/**
 * Friendly names for the Zelinqa V1 contract.
 *
 * Every wire type is re-exported from `generated/openapi.d.ts`, which is produced
 * by `pnpm generate:types` from `openapi/nbq-v1.openapi.yaml`. Nothing here is
 * hand-copied: the contract stays the single source of truth, and field names are
 * snake_case exactly as they appear on the wire.
 *
 * Deprecated compatibility schemas (`Legacy*`) are intentionally not exported.
 */
import type { components } from "./generated/openapi.js";

type Schemas = components["schemas"];

/* ------------------------------------------------------------------ Enumerations */

export type CompletionRole = Schemas["CompletionRole"];
export type ConfigurationAuditResourceType = Schemas["ConfigurationAuditResourceType"];
export type ErrorCode = Schemas["ErrorCode"];
export type ObjectiveOverrideValue = Schemas["ObjectiveOverrideValue"];
export type ProgressStatus = Schemas["ProgressStatus"];
export type QualificationLevel = Schemas["QualificationLevel"];
export type QuestionOutcome = Schemas["QuestionOutcome"];
export type QuestionType = Schemas["QuestionType"];
export type QuestionSelectionMode = Schemas["QuestionSelectionMode"];
export type QuestionSource = Schemas["QuestionSource"];
export type SelectionWarning = Schemas["SelectionWarning"];
export type StopReason = Schemas["StopReason"];
export type DimensionOverrideValue = Schemas["DimensionOverrideValue"];

/** Configuration state selector shared by the configuration read routes. */
export type ConfigurationState = "published" | "draft";

/* ---------------------------------------------------------------- Runtime models */

export type SessionCreateRequest = Schemas["SessionCreateRequest"];
export type InitialHistoryItem = Schemas["InitialHistoryItem"];
export type NextRequest = Schemas["NextRequest"];
export type PreviousTurn = Schemas["PreviousTurn"];
export type ContextUpdate = Schemas["ContextUpdate"];
export type ConversationSummary = Schemas["ConversationSummary"];
export type ConversationMessageDelta = Schemas["ConversationMessageDelta"];
export type ConversationMessage = Schemas["ConversationMessage"];
export type StructuredAnswer = Schemas["StructuredAnswer"];
export type ClientUpdates = Schemas["ClientUpdates"];
export type DataClientUpdate = Schemas["DataClientUpdate"];
export type SetDataUpdate = Schemas["SetDataUpdate"];
export type UnsetDataUpdate = Schemas["UnsetDataUpdate"];
export type NotApplicableDataUpdate = Schemas["NotApplicableDataUpdate"];
export type DimensionOverrideUpdate = Schemas["DimensionOverrideUpdate"];
export type ObjectiveOverrideUpdate = Schemas["ObjectiveOverrideUpdate"];
export type SelectionOptions = Schemas["SelectionOptions"];
export type DimensionSelection = Schemas["DimensionSelection"];
export type SessionEventsRequest = Schemas["SessionEventsRequest"];
export type FeedbackRequest = Schemas["FeedbackRequest"];
export type FeedbackResponse = Schemas["FeedbackResponse"];
export type NextResponse = Schemas["NextResponse"];
export type Candidate = Schemas["Candidate"];
export type CandidateChoice = Schemas["CandidateChoice"];
export type SessionStateResponse = Schemas["SessionStateResponse"];
/** SDK name for `SessionStateResponse`. */
export type SessionState = Schemas["SessionStateResponse"];
export type PublicQuestionState = Schemas["PublicQuestionState"];
export type QuestionOutcomeRecord = Schemas["QuestionOutcomeRecord"];
export type PublicTargetState = Schemas["PublicTargetState"];
export type ProgressView = Schemas["ProgressView"];
export type ObjectiveProgress = Schemas["ObjectiveProgress"];
export type DimensionProgress = Schemas["DimensionProgress"];
export type ObjectiveClientOverrideView = Schemas["ObjectiveClientOverrideView"];
export type DimensionClientOverrideView = Schemas["DimensionClientOverrideView"];
export type PendingDecisionView = Schemas["PendingDecisionView"];
export type VersionInfo = Schemas["VersionInfo"];

/* ---------------------------------------------------------- Configuration models */

export type ConfigurationResponse = Schemas["ConfigurationResponse"];
export type DomainMetadata = Schemas["DomainMetadata"];
/** SDK name for `ConfigurationResponse`. */
export type Configuration = Schemas["ConfigurationResponse"];
export type Objective = Schemas["Objective"];
export type Dimension = Schemas["Dimension"];
export type SuccessInformation = Schemas["SuccessInformation"];
export type ConfiguredQuestion = Schemas["ConfiguredQuestion"];
export type ConfiguredChoice = Schemas["ConfiguredChoice"];
export type QuestionListResponse = Schemas["QuestionListResponse"];
export type ConfigurationAuditActor = Schemas["ConfigurationAuditActor"];
export type ConfigurationAuditResource = Schemas["ConfigurationAuditResource"];
export type ConfigurationAuditDiff = Schemas["ConfigurationAuditDiff"];
export type ConfigurationAuditEvent = Schemas["ConfigurationAuditEvent"];
export type ConfigurationAuditPage = Schemas["ConfigurationAuditPage"];
export type ConfigurationChangesRequest = Schemas["ConfigurationChangesRequest"];
export type ConfigurationChange = Schemas["ConfigurationChange"];
export type ObjectiveChange = Schemas["ObjectiveChange"];
export type DimensionChange = Schemas["DimensionChange"];
export type SuccessInformationChange = Schemas["SuccessInformationChange"];
export type QuestionChange = Schemas["QuestionChange"];
export type ConfigurationChangesResponse = Schemas["ConfigurationChangesResponse"];
export type PublishRequest = Schemas["PublishRequest"];
export type CompilationStatus = Schemas["CompilationStatus"];
export type CompilationError = Schemas["CompilationError"];
export type ConfigurationIssue = Schemas["ConfigurationIssue"];
export type ErrorEnvelope = Schemas["ErrorEnvelope"];

/* --------------------------------------------------------------- Client surface */

/** Minimal Fetch API shape the SDK depends on; inject one for tests or exotic runtimes. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ZelinqaClientOptions {
  /** Zelinqa integration key. Required: the TypeScript SDK never reads the environment. */
  readonly apiKey: string;
  /** Absolute HTTP(S) origin. Defaults to `https://api.zelinqa.ai`. */
  readonly baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Defaults to 30000. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt. Defaults to 2. */
  readonly maxRetries?: number;
  /** Fetch implementation. Defaults to the global `fetch`. */
  readonly fetch?: Fetch;
}

/** Per-call options accepted by every client method. */
export interface RequestOptions {
  /**
   * Idempotency key for this logical mutation. Generated once per call and reused
   * across retries when omitted. Ignored by `GET` routes.
   */
  readonly idempotencyKey?: string;
  /** Caller-owned cancellation signal, combined with the per-attempt timeout. */
  readonly signal?: AbortSignal;
}

/** Query of `GET /v1/configuration`. */
export interface GetConfigurationQuery {
  readonly state?: ConfigurationState;
}

/** Query of `GET /v1/configuration/questions`. */
export interface ListQuestionsQuery {
  readonly state?: ConfigurationState;
  readonly dimension_id?: string;
  readonly active?: boolean;
  readonly type?: QuestionType;
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Query of `GET /v1/configuration/audit`. */
export interface ListAuditQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly action?: string;
  readonly resource_type?: ConfigurationAuditResourceType;
}

/** Options of `ZelinqaConfigurationClient.waitForCompilation`. */
export interface WaitForCompilationOptions {
  /** Delay between two status reads. Defaults to 2000 ms. */
  readonly pollIntervalMs?: number;
  /** Overall budget before `ZelinqaCompilationTimeoutError`. Defaults to 900000 ms. */
  readonly timeoutMs?: number;
  /** Caller-owned cancellation signal. */
  readonly signal?: AbortSignal;
}
