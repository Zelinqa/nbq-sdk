import { apiErrorFromPayload, NBQAPIError, NBQConnectionError } from "./errors.js";
import type {
  ConversionResponse,
  Fetch,
  Message,
  NBQClientOptions,
  NextQuestion,
  NextQuestionOptions,
  NextQuestionsResponse,
  Outcome,
  ReportConversionOptions,
} from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.zelinqa.ai";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RETRIES = 2;

const MAX_SESSION_ID_CHARS = 128;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_MESSAGES = 50;
const MAX_ANSWERED_QUESTIONS = 200;
const MAX_CONTEXT_CHARS = 8_000;
const MAX_METADATA_BYTES = 4_096;
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const OUTCOMES = new Set<Outcome>(["purchase", "lead", "abandon", "other"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(payload: UnknownRecord, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") {
    throw new NBQAPIError(`NBQ API returned an invalid '${field}' field`, {
      statusCode: 200,
      detail: payload,
    });
  }
  return value;
}

function validateSettings(options: NBQClientOptions): {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImplementation: Fetch;
} {
  if (!options.apiKey.trim()) {
    throw new TypeError("apiKey must not be empty");
  }

  const rawBaseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL");
  }
  if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.protocol !== "http:") {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL");
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new TypeError("baseUrl must not contain credentials");
  }
  if (parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new TypeError("baseUrl must not contain a query string or fragment");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be greater than zero");
  }

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError("maxRetries must be a non-negative integer");
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A Fetch API implementation is required");
  }

  return {
    apiKey: options.apiKey,
    baseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
    timeoutMs,
    maxRetries,
    fetchImplementation,
  };
}

function validateSessionId(sessionId: string): void {
  if (!sessionId.trim()) {
    throw new TypeError("sessionId must not be empty");
  }
  if (sessionId.length > MAX_SESSION_ID_CHARS) {
    throw new TypeError(`sessionId must not exceed ${MAX_SESSION_ID_CHARS} characters`);
  }
}

function serializeMessages(messages: readonly Message[]): Array<{ role: string; content: string }> {
  if (messages.length > MAX_HISTORY_MESSAGES) {
    throw new TypeError(`conversationHistory must not exceed ${MAX_HISTORY_MESSAGES} messages`);
  }
  return messages.map((message) => {
    if (message.role !== "user" && message.role !== "assistant") {
      throw new TypeError("each message role must be 'user' or 'assistant'");
    }
    if (!message.content?.trim()) {
      throw new TypeError("each message content must not be empty");
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      throw new TypeError(`each message content must not exceed ${MAX_MESSAGE_CHARS} characters`);
    }
    return { role: message.role, content: message.content };
  });
}

function nextQuestionPayload(options: NextQuestionOptions): UnknownRecord {
  validateSessionId(options.sessionId);
  const messages = serializeMessages(options.conversationHistory ?? []);
  const answeredQuestionIds = options.answeredQuestionIds ?? [];
  const context = options.context ?? null;

  if (answeredQuestionIds.length > MAX_ANSWERED_QUESTIONS) {
    throw new TypeError(`answeredQuestionIds must not exceed ${MAX_ANSWERED_QUESTIONS} entries`);
  }
  if (context !== null && context.length > MAX_CONTEXT_CHARS) {
    throw new TypeError(`context must not exceed ${MAX_CONTEXT_CHARS} characters`);
  }
  if (messages.length === 0 && !context?.trim()) {
    throw new TypeError("provide conversationHistory or context");
  }
  if (messages.length > 0 && messages.at(-1)?.role !== "user") {
    throw new TypeError("the last conversation message must have role='user'");
  }

  return {
    session_id: options.sessionId,
    conversation_history: messages,
    context,
    answered_question_ids: [...answeredQuestionIds],
  };
}

function conversionPayload(
  outcome: Outcome,
  metadata: Readonly<Record<string, unknown>> | undefined,
): UnknownRecord {
  if (!OUTCOMES.has(outcome)) {
    throw new TypeError("outcome must be purchase, lead, abandon or other");
  }
  const metadataPayload = metadata ?? {};
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(metadataPayload);
  } catch {
    throw new TypeError("metadata must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new TypeError("metadata must be JSON serializable");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_METADATA_BYTES) {
    throw new TypeError(`metadata must not exceed ${MAX_METADATA_BYTES} bytes when serialized`);
  }
  return { outcome, metadata: metadataPayload };
}

function idempotencyKey(value: string | undefined): string {
  if (value !== undefined) {
    if (!value.trim()) {
      throw new TypeError("idempotencyKey must not be empty");
    }
    return value;
  }
  return globalThis.crypto.randomUUID();
}

function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("Retry-After");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds * 1_000, 0), 10_000);
    }
  }
  return Math.min(250 * 2 ** attempt, 2_000);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responsePayload(response: Response): Promise<UnknownRecord> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw apiErrorFromPayload(
      response.status,
      { detail: "NBQ API returned a non-JSON response" },
      response.headers.get("X-Request-Id") ?? undefined,
    );
  }
  if (!isRecord(payload)) {
    throw apiErrorFromPayload(
      response.status,
      { detail: "NBQ API returned an invalid JSON payload" },
      response.headers.get("X-Request-Id") ?? undefined,
    );
  }
  return payload;
}

function parseNextQuestionsResponse(payload: UnknownRecord): NextQuestionsResponse {
  let nextQuestion: NextQuestion | null = null;
  if (payload.next_question !== null && payload.next_question !== undefined) {
    if (!isRecord(payload.next_question)) {
      throw new NBQAPIError("NBQ API returned an invalid 'next_question' field", {
        statusCode: 200,
        detail: payload,
      });
    }
    nextQuestion = {
      externalId: requireString(payload.next_question, "external_id"),
      text: requireString(payload.next_question, "text"),
    };
  }
  if (typeof payload.exhausted !== "boolean") {
    throw new NBQAPIError("NBQ API returned an invalid 'exhausted' field", {
      statusCode: 200,
      detail: payload,
    });
  }
  return {
    nextQuestion,
    exhausted: payload.exhausted,
    nbqVersion: requireString(payload, "nbq_version"),
    requestId: requireString(payload, "request_id"),
  };
}

function parseConversionResponse(payload: UnknownRecord): ConversionResponse {
  return {
    conversionId: requireString(payload, "conversion_id"),
    requestId: requireString(payload, "request_id"),
  };
}

export class NBQClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: Fetch;

  public constructor(options: NBQClientOptions) {
    const settings = validateSettings(options);
    this.#apiKey = settings.apiKey;
    this.#baseUrl = settings.baseUrl;
    this.#timeoutMs = settings.timeoutMs;
    this.#maxRetries = settings.maxRetries;
    this.#fetch = settings.fetchImplementation;
  }

  async #post(
    path: string,
    payload: UnknownRecord,
    requestIdempotencyKey: string,
  ): Promise<Response> {
    let lastConnectionError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(new URL(path, this.#baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": requestIdempotencyKey,
            "User-Agent": `nbq-typescript/${VERSION}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        lastConnectionError = error;
        if (attempt >= this.#maxRetries) {
          throw new NBQConnectionError("Unable to reach the NBQ API", { cause: error });
        }
        await sleep(retryDelay(null, attempt));
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (RETRIABLE_STATUS_CODES.has(response.status) && attempt < this.#maxRetries) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      if (!response.ok) {
        let payload: UnknownRecord | null = null;
        try {
          const rawPayload: unknown = await response.json();
          payload = isRecord(rawPayload) ? rawPayload : null;
        } catch {
          payload = null;
        }
        throw apiErrorFromPayload(
          response.status,
          payload,
          response.headers.get("X-Request-Id") ?? undefined,
        );
      }
      return response;
    }

    throw new NBQConnectionError("Unable to reach the NBQ API", {
      cause: lastConnectionError,
    });
  }

  public async nextQuestion(options: NextQuestionOptions): Promise<NextQuestionsResponse> {
    const response = await this.#post(
      "/v1/next-questions",
      nextQuestionPayload(options),
      idempotencyKey(options.idempotencyKey),
    );
    return parseNextQuestionsResponse(await responsePayload(response));
  }

  public async reportConversion(options: ReportConversionOptions): Promise<ConversionResponse> {
    validateSessionId(options.sessionId);
    const response = await this.#post(
      `/v1/sessions/${encodeURIComponent(options.sessionId)}/conversion`,
      conversionPayload(options.outcome, options.metadata),
      idempotencyKey(options.idempotencyKey),
    );
    return parseConversionResponse(await responsePayload(response));
  }
}
