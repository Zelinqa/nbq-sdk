/**
 * Live acceptance suite of `@zelinqa/sdk` 1.0.0 against the staging API.
 *
 * Opt-in: the whole file is skipped unless `ZELINQA_LIVE=1`. It runs against the
 * throwaway Zelinqa "SDK MCP V1 Recette" and is re-runnable — the corpus is upserted
 * (`create` what is missing, `update` what exists) rather than recreated.
 *
 * Keys are least privilege and deliberately split, because the deployed gateway
 * makes the difference observable:
 * - `ZELINQA_LIVE_CONFIG_MANAGE_KEY` (read + write + publish) reads the DRAFT, which
 *   needs `configuration:read` for the authorizer AND `configuration:write` for
 *   the service's dynamic check;
 * - `ZELINQA_LIVE_CONFIG_READ_KEY` reads the published corpus, paginates and exports;
 * - `ZELINQA_LIVE_CONFIG_WRITE_KEY` proves a write-only key can apply changes;
 * - `ZELINQA_LIVE_CONFIG_PUBLISH_KEY` publishes and reads the audit log;
 * - `ZELINQA_LIVE_RUNTIME_KEY` drives the conversation.
 *
 * Never logs a key, a header or a verbatim: only request ids and error codes.
 * `next` calls are spaced for a small functional recipe, not a throughput test.
 *
 *   ZELINQA_LIVE=1 \
 *   ZELINQA_LIVE_RUNTIME_KEY=… ZELINQA_LIVE_CONFIG_READ_KEY=… ZELINQA_LIVE_CONFIG_WRITE_KEY=… \
 *   ZELINQA_LIVE_CONFIG_PUBLISH_KEY=… ZELINQA_LIVE_CONFIG_MANAGE_KEY=… ZELINQA_LIVE_REVOKED_KEY=… \
 *   pnpm test:live
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  type Candidate,
  type CompilationStatus,
  type ConfigurationChange,
  type ConfigurationResponse,
  type ConfiguredQuestion,
  type Dimension,
  type NextResponse,
  type Objective,
  type SessionState,
  type SuccessInformation,
  ZelinqaAuthenticationError,
  ZelinqaClient,
  ZelinqaCompilationInProgressError,
  ZelinqaConfigurationClient,
  ZelinqaIdempotencyKeyReusedError,
  ZelinqaInsufficientScopeError,
  ZelinqaStateVersionConflictError,
  ZelinqaUnknownConfigurationError,
  ZelinqaUnknownSessionError,
} from "../../src/index.js";

const LIVE = process.env.ZELINQA_LIVE === "1";
const BASE_URL = process.env.ZELINQA_LIVE_BASE_URL ?? "https://api.zelinqa.ai";
const RUN_ID = `sdkts${Date.now().toString(36)}`;

const REQUIRED_ENV = [
  "ZELINQA_LIVE_RUNTIME_KEY",
  "ZELINQA_LIVE_CONFIG_READ_KEY",
  "ZELINQA_LIVE_CONFIG_WRITE_KEY",
  "ZELINQA_LIVE_CONFIG_PUBLISH_KEY",
  "ZELINQA_LIVE_CONFIG_MANAGE_KEY",
  "ZELINQA_LIVE_REVOKED_KEY",
] as const;

function requireEnv(name: (typeof REQUIRED_ENV)[number]): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required when ZELINQA_LIVE=1`);
  }
  return value;
}

/** Logs the traceable bits only: never a key, a header or a verbatim. */
function trace(step: string, facts: Readonly<Record<string, unknown>>): void {
  console.log(`[live] ${step} ${JSON.stringify(facts)}`);
}

function traceError(step: string, error: unknown): void {
  const code = (error as { code?: unknown }).code;
  const requestId = (error as { requestId?: unknown }).requestId;
  const status = (error as { statusCode?: unknown }).statusCode;
  trace(step, { error: (error as Error).name, code, status, request_id: requestId });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/* ------------------------------------------------------------------- Corpus */

const OBJECTIVE: Objective = {
  name: "SDK MCP V1 Recette",
  description: "Zelinqa jetable pour la recette des SDK et du serveur MCP.",
  qualification_level: "balanced",
  max_turns: 8,
  candidates_per_call: 2,
  order_strength: 0.35,
};

const SUB_OBJECTIVES: readonly Dimension[] = [
  { id: "sdk_so_besoin", name: "Besoin", order_position: 0, completion_role: "blocking" },
  { id: "sdk_so_budget", name: "Budget", order_position: 1, completion_role: "blocking" },
  { id: "sdk_so_delai", name: "Délai", order_position: 2, completion_role: "contributing" },
];

const QUESTIONS: readonly ConfiguredQuestion[] = [
  {
    id: "sdk_q_usage",
    text: "Pour quel usage cherchez-vous ce canapé ?",
    type: "open",
    selection_mode: null,
    source: "user",
    dimension_id: "sdk_so_besoin",
    active: true,
    choices: [],
  },
  {
    id: "sdk_q_style",
    text: "Quel style préférez-vous ?",
    type: "single_choice",
    selection_mode: "single",
    source: "user",
    dimension_id: "sdk_so_besoin",
    active: true,
    choices: [
      { id: "sdk_c_contemporain", label: "Contemporain", maps_to_value: "contemporain" },
      { id: "sdk_c_scandinave", label: "Scandinave", maps_to_value: "scandinave" },
      { id: "sdk_c_classique", label: "Classique", maps_to_value: "classique" },
    ],
  },
  {
    id: "sdk_q_budget",
    text: "Quel budget envisagez-vous ?",
    type: "open",
    selection_mode: null,
    source: "user",
    dimension_id: "sdk_so_budget",
    active: true,
    choices: [],
  },
  {
    id: "sdk_q_delai",
    text: "Quand souhaitez-vous être livré ?",
    type: "single_choice",
    selection_mode: "single",
    source: "user",
    dimension_id: "sdk_so_delai",
    active: true,
    choices: [
      { id: "sdk_c_1m", label: "Dans le mois", maps_to_value: "dans_le_mois" },
      { id: "sdk_c_3m", label: "Dans les trois mois", maps_to_value: "trois_mois" },
      { id: "sdk_c_later", label: "Plus tard", maps_to_value: "plus_tard" },
    ],
  },
  {
    id: "sdk_q_animaux",
    text: "Avez-vous des animaux ?",
    type: "single_choice",
    selection_mode: "single",
    source: "user",
    dimension_id: "sdk_so_besoin",
    active: true,
    choices: [
      { id: "sdk_c_oui", label: "Oui", maps_to_value: true },
      { id: "sdk_c_non", label: "Non", maps_to_value: false },
    ],
  },
];

const SUCCESS_INFORMATIONS: readonly SuccessInformation[] = [
  {
    id: "sdk_style",
    label: "Style souhaité",
    primary_question_id: "sdk_q_style",
    schema: { type: "string", enum: ["contemporain", "scandinave", "classique"] },
  },
  {
    id: "sdk_budget",
    label: "Budget",
    primary_question_id: "sdk_q_budget",
    schema: { type: "number", minimum: 0 },
  },
  {
    id: "sdk_delai",
    label: "Délai de livraison",
    primary_question_id: "sdk_q_delai",
    schema: { type: "string", enum: ["dans_le_mois", "trois_mois", "plus_tard"] },
  },
  {
    id: "sdk_animaux",
    label: "Présence d'animaux",
    primary_question_id: "sdk_q_animaux",
    schema: { type: "boolean" },
  },
];

/** Dimensions first, then questions, then the informations they collect. */
function upsertChanges(baseline: ConfigurationResponse | undefined): ConfigurationChange[] {
  const knownDimensions = new Set((baseline?.dimensions ?? []).map((entry) => entry.id));
  const knownQuestions = new Set((baseline?.questions ?? []).map((entry) => entry.id));
  const knownInformations = new Set(
    (baseline?.success_informations ?? []).map((entry) => entry.id),
  );

  return [
    { entity: "objective", operation: "update", objective: OBJECTIVE },
    ...SUB_OBJECTIVES.map<ConfigurationChange>((dimension) => ({
      entity: "dimension",
      operation: knownDimensions.has(dimension.id) ? "update" : "create",
      dimension,
    })),
    ...QUESTIONS.map<ConfigurationChange>((question) => ({
      entity: "question",
      operation: knownQuestions.has(question.id) ? "update" : "create",
      question,
    })),
    ...SUCCESS_INFORMATIONS.map<ConfigurationChange>((success_information) => ({
      entity: "success_information",
      operation: knownInformations.has(success_information.id) ? "update" : "create",
      success_information,
    })),
  ];
}

function revisionBody(revision: number | undefined): { expected_draft_revision?: number } {
  return revision === undefined ? {} : { expected_draft_revision: revision };
}

/* -------------------------------------------------------------------- Suite */

interface LiveState {
  draftRevision: number | undefined;
  compilation: CompilationStatus | undefined;
  session: SessionState | undefined;
  firstTurn: NextResponse | undefined;
  stateVersion: number;
}

describe.skipIf(!LIVE).sequential("Zelinqa V1 — live acceptance", () => {
  let manage: ZelinqaConfigurationClient;
  let write: ZelinqaConfigurationClient;
  let read: ZelinqaConfigurationClient;
  let publish: ZelinqaConfigurationClient;
  let runtime: ZelinqaClient;
  const state: LiveState = {
    draftRevision: undefined,
    compilation: undefined,
    session: undefined,
    firstTurn: undefined,
    stateVersion: 0,
  };

  beforeAll(() => {
    for (const name of REQUIRED_ENV) {
      requireEnv(name);
    }
    const shared = { baseUrl: BASE_URL, timeoutMs: 60_000, maxRetries: 2 } as const;
    manage = new ZelinqaConfigurationClient({
      ...shared,
      apiKey: requireEnv("ZELINQA_LIVE_CONFIG_MANAGE_KEY"),
    });
    write = new ZelinqaConfigurationClient({
      ...shared,
      apiKey: requireEnv("ZELINQA_LIVE_CONFIG_WRITE_KEY"),
    });
    read = new ZelinqaConfigurationClient({
      ...shared,
      apiKey: requireEnv("ZELINQA_LIVE_CONFIG_READ_KEY"),
    });
    publish = new ZelinqaConfigurationClient({
      ...shared,
      apiKey: requireEnv("ZELINQA_LIVE_CONFIG_PUBLISH_KEY"),
    });
    runtime = new ZelinqaClient({ ...shared, apiKey: requireEnv("ZELINQA_LIVE_RUNTIME_KEY") });
    trace("setup", { base_url: BASE_URL, run_id: RUN_ID });
  });

  /* -- 1. upsert the corpus ------------------------------------------------- */

  it("upserts the corpus, with one change applied by a write-only key", async () => {
    let baseline: ConfigurationResponse | undefined;
    try {
      baseline = await manage.getConfiguration({ state: "draft" });
      trace("draft.read", {
        request_id: baseline.request_id,
        draft_revision: baseline.draft_revision,
      });
    } catch (error) {
      if (!(error instanceof ZelinqaUnknownConfigurationError)) {
        throw error;
      }
      traceError("draft.absent", error);
      baseline = await manage.getConfiguration().catch((cause: unknown) => {
        if (cause instanceof ZelinqaUnknownConfigurationError) {
          return undefined;
        }
        throw cause;
      });
    }

    let revision =
      typeof baseline?.draft_revision === "number" ? baseline.draft_revision : undefined;

    // A write-only key can apply changes even though it cannot read the draft.
    const objectiveOnly = await write.applyChanges(
      {
        changes: [{ entity: "objective", operation: "update", objective: OBJECTIVE }],
        ...revisionBody(revision),
      },
      { idempotencyKey: `${RUN_ID}-changes-objective` },
    );
    trace("changes.write_only_key", {
      request_id: objectiveOnly.request_id,
      draft_revision: objectiveOnly.draft_revision,
      applied: objectiveOnly.applied,
    });
    expect(objectiveOnly.applied).toBeGreaterThan(0);
    revision = objectiveOnly.draft_revision;

    const applied = await manage.applyChanges(
      { changes: upsertChanges(baseline), ...revisionBody(revision) },
      { idempotencyKey: `${RUN_ID}-changes-corpus` },
    );
    trace("changes.applied", {
      request_id: applied.request_id,
      draft_revision: applied.draft_revision,
      applied: applied.applied,
      warnings: applied.warnings.map((issue) => issue.code),
    });
    expect(applied.applied).toBeGreaterThan(0);

    const draft = await manage.getConfiguration({ state: "draft" });
    expect(draft.state).toBe("draft");
    expect(draft.objective.name).toBe(OBJECTIVE.name);
    expect(draft.questions.map((question) => question.id)).toEqual(
      expect.arrayContaining(QUESTIONS.map((question) => question.id)),
    );
    state.draftRevision = draft.draft_revision ?? applied.draft_revision;

    const draftQuestions = await manage.listQuestions({ state: "draft", limit: 200 });
    trace("draft.questions", {
      request_id: draftQuestions.request_id,
      state: draftQuestions.state,
      total: draftQuestions.total,
    });
    expect(draftQuestions.state).toBe("draft");
  });

  /* -- 2. draft reads need read + write ------------------------------------- */

  it("refuses the draft to a read-only key with the dynamic scope envelope", async () => {
    const error = await read.getConfiguration({ state: "draft" }).catch((cause: unknown) => cause);

    traceError("draft.read_key", error);
    expect(error).toBeInstanceOf(ZelinqaInsufficientScopeError);
    expect((error as ZelinqaInsufficientScopeError).code).toBe("insufficient_scope");
    expect((error as ZelinqaInsufficientScopeError).statusCode).toBe(403);
  });

  it("refuses the draft to a write-only key at the gateway", async () => {
    // Documents the contract/authorizer mismatch: the authorizer requires
    // `configuration:read` on this route, so a write-only key never reaches the
    // service and gets an envelope-less 403.
    const error = await write.getConfiguration({ state: "draft" }).catch((cause: unknown) => cause);

    traceError("draft.write_key", error);
    expect(error).toBeInstanceOf(ZelinqaAuthenticationError);
    expect(error).not.toBeInstanceOf(ZelinqaInsufficientScopeError);
    expect((error as ZelinqaAuthenticationError).statusCode).toBe(403);
    expect((error as ZelinqaAuthenticationError).code).toBeUndefined();
  });

  /* -- 3. publish, conflict, wait, audit ------------------------------------ */

  it("publishes the draft and waits for the compilation", async () => {
    const queued = await publish.publish(revisionBody(state.draftRevision), {
      idempotencyKey: `${RUN_ID}-publish`,
    });
    trace("publish.queued", {
      request_id: queued.request_id,
      compilation_id: queued.compilation_id,
      status: queued.status,
    });
    expect(["queued", "running"]).toContain(queued.status);

    const second = await publish
      .publish({}, { idempotencyKey: `${RUN_ID}-publish-2` })
      .catch((cause: unknown) => cause);
    if (second instanceof ZelinqaCompilationInProgressError) {
      traceError("publish.conflict", second);
      expect(second.compilationId).toBeDefined();
    } else {
      // Tolerated: the first compilation may already have finished.
      trace("publish.conflict_skipped", {
        outcome: second instanceof Error ? second.name : "accepted",
      });
    }

    // `getCompilation` needs `configuration:read`, which the publish-only key
    // does not carry: poll with the management key.
    const terminal = await manage.waitForCompilation(queued.compilation_id, {
      pollIntervalMs: 3_000,
      timeoutMs: 900_000,
    });
    trace("publish.terminal", {
      request_id: terminal.request_id,
      compilation_id: terminal.compilation_id,
      status: terminal.status,
      error: terminal.error?.code ?? null,
      configuration_version: terminal.configuration_version,
    });
    expect(terminal.status).toBe("succeeded");
    state.compilation = terminal;
  });

  it("exposes the audit log to the publish key only", async () => {
    const page = await publish.listAudit({ limit: 10 });
    trace("audit.page", {
      request_id: page.request_id,
      events: page.events.length,
      actions: page.events.map((event) => event.action),
    });
    expect(page.events.length).toBeGreaterThan(0);

    const error = await read.listAudit().catch((cause: unknown) => cause);
    traceError("audit.read_key", error);
    expect(error).toBeInstanceOf(ZelinqaAuthenticationError);
    expect((error as ZelinqaAuthenticationError).statusCode).toBe(403);
  });

  /* -- 4. published reads: pagination, filters, csv, compilation ------------ */

  it("reads the published corpus, paginates, filters and exports CSV", async () => {
    const published = await read.getConfiguration();
    trace("published.read", {
      request_id: published.request_id,
      configuration_version: published.configuration_version,
      questions: published.questions.length,
    });
    expect(published.state).toBe("published");
    expect(published.objective.name).toBe(OBJECTIVE.name);
    expect(published.success_informations.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(SUCCESS_INFORMATIONS.map((entry) => entry.id)),
    );

    const firstPage = await read.listQuestions({ limit: 2 });
    trace("questions.page", {
      request_id: firstPage.request_id,
      total: firstPage.total,
      returned: firstPage.questions.length,
    });
    expect(firstPage.questions.length).toBeLessThanOrEqual(2);

    const paginated: string[] = [...firstPage.questions.map((question) => question.id)];
    let cursor = firstPage.next_cursor;
    while (cursor !== null && cursor !== undefined) {
      const page = await read.listQuestions({ limit: 2, cursor });
      paginated.push(...page.questions.map((question) => question.id));
      cursor = page.next_cursor;
    }
    expect(paginated).toEqual(expect.arrayContaining(QUESTIONS.map((question) => question.id)));
    if (typeof firstPage.total === "number") {
      expect(paginated).toHaveLength(firstPage.total);
    }

    const iterated: string[] = [];
    for await (const question of read.iterateQuestions({ limit: 2 })) {
      iterated.push(question.id);
    }
    expect(new Set(iterated)).toEqual(new Set(paginated));

    const byDimension = await read.listQuestions({ dimension_id: "sdk_so_besoin" });
    expect(byDimension.questions.length).toBeGreaterThan(0);
    for (const question of byDimension.questions) {
      expect(question.dimension_id).toBe("sdk_so_besoin");
    }

    const byType = await read.listQuestions({ type: "single_choice" });
    for (const question of byType.questions) {
      expect(question.type).toBe("single_choice");
    }

    const bySearch = await read.listQuestions({ search: "budget" });
    expect(bySearch.questions.map((question) => question.id)).toContain("sdk_q_budget");

    const csv = await read.exportQuestionsCsv();
    expect(csv.split("\n")[0]?.trim()).toBe(
      "id,text,type,selection_mode,choices,source,dimension_id,active",
    );
    expect(csv).toContain("sdk_q_style");

    const compilationId = state.compilation?.compilation_id;
    expect(compilationId).toBeDefined();
    if (compilationId !== undefined) {
      const status = await read.getCompilation(compilationId);
      trace("compilation.read", { request_id: status.request_id, status: status.status });
      expect(status.status).toBe("succeeded");
    }
  });

  /* -- 5. scopes are least privilege, refused at the gateway ---------------- */

  it("refuses publish to the write key and configuration to the runtime key", async () => {
    const publishError = await write
      .publish({}, { idempotencyKey: `${RUN_ID}-publish-forbidden` })
      .catch((cause: unknown) => cause);
    traceError("publish.write_key", publishError);
    expect(publishError).toBeInstanceOf(ZelinqaAuthenticationError);
    expect((publishError as ZelinqaAuthenticationError).statusCode).toBe(403);

    const runtimeAsConfig = new ZelinqaConfigurationClient({
      apiKey: requireEnv("ZELINQA_LIVE_RUNTIME_KEY"),
      baseUrl: BASE_URL,
      maxRetries: 0,
    });
    const configError = await runtimeAsConfig.getConfiguration().catch((cause: unknown) => cause);
    traceError("configuration.runtime_key", configError);
    expect(configError).toBeInstanceOf(ZelinqaAuthenticationError);
    expect((configError as ZelinqaAuthenticationError).statusCode).toBe(403);
  });

  /* -- 6. runtime: full conversation --------------------------------------- */

  it("creates a session", async () => {
    const session = await runtime.createSession(
      { client_reference: `${RUN_ID}-lead`, max_turns: 8 },
      { idempotencyKey: `${RUN_ID}-create` },
    );
    trace("session.created", {
      request_id: session.request_id,
      session_id: session.session_id,
      state_version: session.versions.state_version,
      status: session.status,
    });
    expect(session.status).toBe("active");
    expect(session.versions.state_version).toBe(0);
    expect(session.pending_decision).toBeNull();
    state.session = session;
    state.stateVersion = session.versions.state_version;
  });

  it("asks the first question, replays it and rejects a reused key", async () => {
    const sessionId = state.session?.session_id;
    expect(sessionId).toBeDefined();
    if (sessionId === undefined) {
      return;
    }
    const key = `${RUN_ID}-next-1`;

    const first = await runtime.next(sessionId, { state_version: 0 }, { idempotencyKey: key });
    trace("next.first", {
      request_id: first.request_id,
      decision_id: first.decision_id,
      action: first.action,
      candidates: first.candidates.map((candidate) => candidate.question_id),
      warnings: first.warnings,
      degraded_reasons: first.degraded_reasons,
      state_version: first.versions.state_version,
    });
    expect(first.action).toBe("ask");
    expect(first.decision_id).not.toBeNull();
    expect(first.candidates.length).toBeGreaterThan(0);
    state.firstTurn = first;
    state.stateVersion = first.versions.state_version;

    await sleep(1_000);

    const replay = await runtime.next(sessionId, { state_version: 0 }, { idempotencyKey: key });
    trace("next.replay", {
      request_id: replay.request_id,
      decision_id: replay.decision_id,
      turn_count: replay.turn_count,
    });
    expect(replay.decision_id).toBe(first.decision_id);
    expect(replay.turn_count).toBe(first.turn_count);

    const reused = await runtime
      .next(
        sessionId,
        { state_version: state.stateVersion, previous_turn: { user_text: "Autre corps." } },
        { idempotencyKey: key },
      )
      .catch((cause: unknown) => cause);
    traceError("next.key_reused", reused);
    expect(reused).toBeInstanceOf(ZelinqaIdempotencyKeyReusedError);
  });

  it("rejects a stale state_version", async () => {
    const sessionId = state.session?.session_id;
    if (sessionId === undefined) {
      return;
    }
    const stale = Math.max(state.stateVersion - 1, 0);

    const error = await runtime
      .next(sessionId, { state_version: stale }, { idempotencyKey: `${RUN_ID}-next-stale` })
      .catch((cause: unknown) => cause);

    traceError("next.stale_version", error);
    expect(error).toBeInstanceOf(ZelinqaStateVersionConflictError);
    expect((error as ZelinqaStateVersionConflictError).currentStateVersion).toBe(
      state.stateVersion,
    );
  });

  it("plays a second and a third turn", async () => {
    const sessionId = state.session?.session_id;
    const firstCandidate: Candidate | undefined = state.firstTurn?.candidates[0];
    if (sessionId === undefined || firstCandidate === undefined) {
      return;
    }

    await sleep(1_000);
    const second = await runtime.next(
      sessionId,
      {
        state_version: state.stateVersion,
        previous_turn: {
          assistant_text: firstCandidate.text,
          user_text: "Un canapé contemporain pour le salon, nous avons un chat.",
        },
      },
      { idempotencyKey: `${RUN_ID}-next-2` },
    );
    trace("next.second", {
      request_id: second.request_id,
      action: second.action,
      candidates: second.candidates.map((candidate) => candidate.question_id),
      degraded_reasons: second.degraded_reasons,
      state_version: second.versions.state_version,
    });
    expect(second.versions.state_version).toBeGreaterThan(state.stateVersion);
    state.stateVersion = second.versions.state_version;

    const choiceCandidate = second.candidates.find((candidate) => candidate.choices.length > 0);
    const answered: Candidate | undefined = choiceCandidate ?? second.candidates[0];
    if (answered === undefined) {
      return;
    }

    await sleep(1_000);
    const third = await runtime.next(
      sessionId,
      {
        state_version: state.stateVersion,
        previous_turn:
          choiceCandidate === undefined
            ? {
                assistant_text: answered.text,
                user_text: "Autour de 2 500 euros, livraison dans le mois.",
              }
            : {
                question_id: answered.question_id,
                assistant_text: answered.text,
                structured_answer: {
                  choice_ids: [answered.choices[0]?.choice_id ?? ""].filter((id) => id.length > 0),
                },
              },
      },
      { idempotencyKey: `${RUN_ID}-next-3` },
    );
    trace("next.third", {
      request_id: third.request_id,
      action: third.action,
      structured: choiceCandidate !== undefined,
      progress: third.progress.objective.progress,
      state_version: third.versions.state_version,
    });
    state.stateVersion = third.versions.state_version;
  });

  it("applies client data and a context summary out of turn", async () => {
    const sessionId = state.session?.session_id;
    if (sessionId === undefined) {
      return;
    }

    const withData = await runtime.applyEvents(
      sessionId,
      {
        state_version: state.stateVersion,
        client_updates: { data: [{ id: "sdk_budget", operation: "set", value: 2500 }] },
      },
      { idempotencyKey: `${RUN_ID}-events-1` },
    );
    trace("events.data", {
      request_id: withData.request_id,
      state_version: withData.versions.state_version,
      budget_status: withData.targets.sdk_budget?.status,
    });
    expect(withData.targets.sdk_budget?.status).toBe("confirmed");
    state.stateVersion = withData.versions.state_version;

    const withSummary = await runtime.applyEvents(
      sessionId,
      {
        state_version: state.stateVersion,
        context_update: {
          mode: "summary",
          text: "Le visiteur emménage en mars et mesure la pièce ce week-end.",
        },
      },
      { idempotencyKey: `${RUN_ID}-events-2` },
    );
    trace("events.summary", {
      request_id: withSummary.request_id,
      state_version: withSummary.versions.state_version,
    });
    expect(withSummary.versions.state_version).toBeGreaterThan(state.stateVersion);
    state.stateVersion = withSummary.versions.state_version;
  });

  it("re-reads the session and records the feedback", async () => {
    const sessionId = state.session?.session_id;
    if (sessionId === undefined) {
      return;
    }

    const reread = await runtime.getSession(sessionId);
    trace("session.read", {
      request_id: reread.request_id,
      state_version: reread.versions.state_version,
      pending_candidates: reread.pending_decision?.candidates.length ?? 0,
      outcomes: reread.question_state.outcomes.length,
    });
    expect(reread.versions.state_version).toBe(state.stateVersion);
    expect(reread.pending_decision?.candidates.length ?? 0).toBeGreaterThan(0);

    const key = `${RUN_ID}-feedback`;
    const feedback = await runtime.submitFeedback(
      sessionId,
      { result: "success", label: "achat", metadata: { order_id: "SDK-1" } },
      { idempotencyKey: key },
    );
    trace("feedback.recorded", {
      request_id: feedback.request_id,
      feedback_id: feedback.feedback_id,
    });
    expect(feedback.feedback_id).toBeTruthy();

    const replay = await runtime.submitFeedback(
      sessionId,
      { result: "success", label: "achat", metadata: { order_id: "SDK-1" } },
      { idempotencyKey: key },
    );
    expect(replay.feedback_id).toBe(feedback.feedback_id);
  });

  it("reports an unknown session", async () => {
    const error = await runtime.getSession("ses_does_not_exist").catch((cause: unknown) => cause);

    traceError("session.unknown", error);
    expect(error).toBeInstanceOf(ZelinqaUnknownSessionError);
    expect((error as ZelinqaUnknownSessionError).statusCode).toBe(404);
  });

  /* -- 7. authentication --------------------------------------------------- */

  it("rejects an invalid key, a revoked key and a missing header", async () => {
    const invalid = new ZelinqaClient({
      apiKey: "nbq_live_invalid",
      baseUrl: BASE_URL,
      maxRetries: 0,
    });
    const invalidError = await invalid.createSession().catch((cause: unknown) => cause);
    traceError("auth.invalid_key", invalidError);
    expect(invalidError).toBeInstanceOf(ZelinqaAuthenticationError);
    expect((invalidError as ZelinqaAuthenticationError).statusCode).toBe(403);

    const revoked = new ZelinqaClient({
      apiKey: requireEnv("ZELINQA_LIVE_REVOKED_KEY"),
      baseUrl: BASE_URL,
      maxRetries: 0,
    });
    const revokedError = await revoked.createSession().catch((cause: unknown) => cause);
    traceError("auth.revoked_key", revokedError);
    expect(revokedError).toBeInstanceOf(ZelinqaAuthenticationError);
    expect((revokedError as ZelinqaAuthenticationError).statusCode).toBe(403);

    const anonymous = await fetch(`${BASE_URL}/v1/sessions`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
    });
    trace("auth.no_header", { status: anonymous.status });
    expect(anonymous.status).toBe(401);
  });
});
