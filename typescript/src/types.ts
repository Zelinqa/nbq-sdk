export type Role = "user" | "assistant";

export type Outcome = "purchase" | "lead" | "abandon" | "other";

export interface Message {
  readonly role: Role;
  readonly content: string;
}

export interface NextQuestion {
  readonly externalId: string;
  readonly text: string;
}

export interface NextQuestionsResponse {
  readonly nextQuestion: NextQuestion | null;
  readonly exhausted: boolean;
  readonly nbqVersion: string;
  readonly requestId: string;
}

export interface ConversionResponse {
  readonly conversionId: string;
  readonly requestId: string;
}

export interface NextQuestionOptions {
  readonly sessionId: string;
  readonly conversationHistory?: readonly Message[];
  readonly context?: string | null;
  readonly answeredQuestionIds?: readonly string[];
  readonly idempotencyKey?: string;
}

export interface ReportConversionOptions {
  readonly sessionId: string;
  readonly outcome: Outcome;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NBQClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: Fetch;
}
