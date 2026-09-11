/**
 * Configuration client of the NBQ Engine V1 API.
 *
 * Requires a management key. Scopes are least privilege and checked per route:
 * `configuration:read` to read the published corpus, `configuration:write` to
 * read the draft and apply changes, `configuration:publish` to publish and to
 * read the audit log. `state=draft` is a dynamic check made by the service, so a
 * read-only key gets `403 insufficient_scope` on it rather than a gateway refusal.
 */

import { NBQCompilationTimeoutError } from "./errors.js";
import { encodePathSegment, HttpTransport } from "./http.js";
import type {
  CompilationStatus,
  ConfigurationAuditPage,
  ConfigurationChangesRequest,
  ConfigurationChangesResponse,
  ConfigurationResponse,
  ConfiguredQuestion,
  GetConfigurationQuery,
  ListAuditQuery,
  ListQuestionsQuery,
  NBQClientOptions,
  PublishRequest,
  QuestionListResponse,
  RequestOptions,
  WaitForCompilationOptions,
} from "./types.js";

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_COMPILATION_TIMEOUT_MS = 900_000;

const TERMINAL_COMPILATION_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed"]);

function questionsQuery(
  query: ListQuestionsQuery | undefined,
  overrides: Readonly<Record<string, string | number | boolean | undefined>> = {},
): Readonly<Record<string, string | number | boolean | undefined>> {
  return {
    state: query?.state,
    sub_objective_id: query?.sub_objective_id,
    active: query?.active,
    type: query?.type,
    search: query?.search,
    limit: query?.limit,
    cursor: query?.cursor,
    ...overrides,
  };
}

function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class NBQConfigurationClient {
  readonly #http: HttpTransport;

  public constructor(options: NBQClientOptions) {
    this.#http = new HttpTransport(options);
  }

  public get baseUrl(): string {
    return this.#http.baseUrl;
  }

  /** Never exposes the API key. */
  public toString(): string {
    return `NBQConfigurationClient(baseUrl=${this.#http.baseUrl})`;
  }

  /**
   * `GET /v1/configuration` — objective, sub-objectives, success informations and
   * questions. `state: "draft"` requires `configuration:write`.
   */
  public async getConfiguration(
    query?: GetConfigurationQuery,
    options?: RequestOptions,
  ): Promise<ConfigurationResponse> {
    return await this.#http.requestJson<ConfigurationResponse>({
      method: "GET",
      path: "/v1/configuration",
      query: { state: query?.state },
      options,
    });
  }

  /** `GET /v1/configuration/questions` — one cursor page of the corpus. */
  public async listQuestions(
    query?: ListQuestionsQuery,
    options?: RequestOptions,
  ): Promise<QuestionListResponse> {
    return await this.#http.requestJson<QuestionListResponse>({
      method: "GET",
      path: "/v1/configuration/questions",
      query: questionsQuery(query),
      options,
    });
  }

  /**
   * Walks every page of `GET /v1/configuration/questions`, following
   * `next_cursor` until the last page.
   */
  public async *iterateQuestions(
    query?: ListQuestionsQuery,
    options?: RequestOptions,
  ): AsyncGenerator<ConfiguredQuestion, void, undefined> {
    let cursor = query?.cursor;
    for (;;) {
      const page = await this.#http.requestJson<QuestionListResponse>({
        method: "GET",
        path: "/v1/configuration/questions",
        query: questionsQuery(query, { cursor }),
        options,
      });
      for (const question of page.questions) {
        yield question;
      }
      if (page.next_cursor === null || page.next_cursor === undefined) {
        return;
      }
      cursor = page.next_cursor;
    }
  }

  /**
   * `GET /v1/configuration/questions?format=csv` — the whole filtered corpus as
   * `text/csv`, header `id,text,type,choices,sub_objective_id,active`.
   */
  public async exportQuestionsCsv(
    query?: ListQuestionsQuery,
    options?: RequestOptions,
  ): Promise<string> {
    return await this.#http.requestText({
      method: "GET",
      path: "/v1/configuration/questions",
      query: questionsQuery(query, { format: "csv", cursor: undefined, limit: undefined }),
      accept: "text/csv",
      options,
    });
  }

  /** `GET /v1/configuration/audit` — configuration changelog. Requires `configuration:publish`. */
  public async listAudit(
    query?: ListAuditQuery,
    options?: RequestOptions,
  ): Promise<ConfigurationAuditPage> {
    return await this.#http.requestJson<ConfigurationAuditPage>({
      method: "GET",
      path: "/v1/configuration/audit",
      query: {
        limit: query?.limit,
        cursor: query?.cursor,
        action: query?.action,
        resource_type: query?.resource_type,
      },
      options,
    });
  }

  /**
   * `POST /v1/configuration/changes` — applies an ordered list of operations to
   * the draft, atomically. Publishes nothing.
   */
  public async applyChanges(
    body: ConfigurationChangesRequest,
    options?: RequestOptions,
  ): Promise<ConfigurationChangesResponse> {
    return await this.#http.requestJson<ConfigurationChangesResponse>({
      method: "POST",
      path: "/v1/configuration/changes",
      body,
      mutation: true,
      options,
    });
  }

  /**
   * `POST /v1/configuration/publish` — queues a compilation job and returns
   * immediately. Track it with `getCompilation` or `waitForCompilation`.
   */
  public async publish(
    body: PublishRequest = {},
    options?: RequestOptions,
  ): Promise<CompilationStatus> {
    return await this.#http.requestJson<CompilationStatus>({
      method: "POST",
      path: "/v1/configuration/publish",
      body,
      mutation: true,
      options,
    });
  }

  /** `GET /v1/configuration/compilations/{id}` — job progress. */
  public async getCompilation(
    compilationId: string,
    options?: RequestOptions,
  ): Promise<CompilationStatus> {
    return await this.#http.requestJson<CompilationStatus>({
      method: "GET",
      path: `/v1/configuration/compilations/${encodePathSegment(compilationId, "compilationId")}`,
      options,
    });
  }

  /**
   * Polls a compilation until it reaches a terminal state and returns that state.
   *
   * Returns on `failed` as well as on `succeeded` — inspect `status.error` — and
   * raises `NBQCompilationTimeoutError` only when the budget runs out. A failed
   * compilation is an editorial outcome, not an SDK failure.
   */
  public async waitForCompilation(
    compilationId: string,
    options?: WaitForCompilationOptions,
  ): Promise<CompilationStatus> {
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMPILATION_TIMEOUT_MS;
    const signal = options?.signal;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new TypeError("pollIntervalMs must be greater than zero");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be greater than zero");
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getCompilation(
        compilationId,
        signal === undefined ? undefined : { signal },
      );
      if (TERMINAL_COMPILATION_STATUSES.has(status.status)) {
        return status;
      }
      if (Date.now() + pollIntervalMs > deadline) {
        throw new NBQCompilationTimeoutError(
          `Compilation ${compilationId} did not finish within ${timeoutMs} ms`,
          compilationId,
          timeoutMs,
        );
      }
      await sleep(pollIntervalMs, signal);
    }
  }
}
