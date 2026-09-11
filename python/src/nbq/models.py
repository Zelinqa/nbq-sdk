"""Pydantic models for the NBQ Engine API V1.

One class per named schema of ``openapi/nbq-v1.openapi.yaml``, with the same
name. Closed enumerations are exposed as ``Literal`` type aliases.

Request models are strict (``extra="forbid"``) and carry the contract bounds so
a mistake is caught before the network call. Response models are forward
compatible (``extra="ignore"``) and deliberately carry no length or range
bounds: a future server field must never turn a valid response into an error.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, model_validator

# --------------------------------------------------------------------- enums

Role: TypeAlias = Literal["user", "assistant"]
QuestionType: TypeAlias = Literal["open", "single_choice", "multiple_choice", "semi_open"]
QuestionOutcome: TypeAlias = Literal["asked_answered", "asked_no_answer", "refused"]
OutcomeSource: TypeAlias = Literal["client", "inferred"]
ObjectiveOverrideValue: TypeAlias = Literal["achieved", "not_achieved"]
SubObjectiveOverrideValue: TypeAlias = Literal["achieved", "not_achieved", "excluded"]
SubObjectiveSelectionMode: TypeAlias = Literal["restrict", "prefer"]
SessionStatus: TypeAlias = Literal["active", "completed", "stopped"]
NextAction: TypeAlias = Literal["ask", "stop"]
StopReason: TypeAlias = Literal["no_question_available"]
SelectionWarning: TypeAlias = Literal[
    "max_turns_reached",
    "objective_achieved",
    "eligibility_exhausted_fallback",
    "constraints_relaxed",
]
DegradedReason: TypeAlias = Literal[
    "missing_user_text",
    "summary_only_context",
    "semantic_service_unavailable",
    "unresolved_previous_turn",
]
TargetKind: TypeAlias = Literal["data", "exploration"]
TargetStatus: TypeAlias = Literal["tentative", "confirmed", "conflicted", "not_applicable"]
ProgressStatus: TypeAlias = Literal["not_started", "in_progress", "covered", "blocked"]
SubObjectiveEffectiveStatus: TypeAlias = Literal[
    "not_started", "in_progress", "covered", "blocked", "excluded"
]
CompletionRole: TypeAlias = Literal["blocking", "contributing", "optional"]
QualificationLevel: TypeAlias = Literal["essential", "balanced", "deep"]
FeedbackResult: TypeAlias = Literal["success", "partial", "failure"]
ConfigurationState: TypeAlias = Literal["published", "draft"]
ConfigurationAuditResourceType: TypeAlias = Literal[
    "objective",
    "sub_objective",
    "success_information",
    "question",
    "configuration",
    "api_key",
    "nbq",
]
AuditActorType: TypeAlias = Literal["api_key", "cognito_user"]
AuditOrigin: TypeAlias = Literal["public_api", "studio_jwt"]
ChangeOperation: TypeAlias = Literal["create", "update", "delete"]
CompilationStatusValue: TypeAlias = Literal["queued", "running", "succeeded", "failed"]
CompilationErrorCode: TypeAlias = Literal[
    "validation_failed", "llm_unavailable", "timeout", "internal_error"
]
ConfigurationIssueEntity: TypeAlias = Literal[
    "objective", "sub_objective", "success_information", "question"
]
ErrorCode: TypeAlias = Literal[
    "unauthorized",
    "insufficient_scope",
    "idempotency_contention",
    "state_version_conflict",
    "idempotency_key_reused",
    "unknown_session",
    "invalid_previous_turn",
    "constraint_no_match",
    "invalid_choice",
    "compiled_artifact_unavailable",
    "configuration_validation_failed",
    "compilation_in_progress",
    "unknown_configuration",
    "unknown_compilation",
]

#: A value a client may set on a success information. Never an object: the
#: extraction pipeline could neither produce nor repair one.
DataValue: TypeAlias = bool | int | float | str | list[bool | int | float | str]

#: Short correlation facts attached to a feedback. Never conversational content.
MetadataValue: TypeAlias = str | int | float | bool | None


class NBQRequestModel(BaseModel):
    """Base class of every request body model: strict and bounded."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class NBQResponseModel(BaseModel):
    """Base class of every response model: forward compatible."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)


# ------------------------------------------------------------------ sessions


class StructuredAnswer(NBQRequestModel):
    """Answer to a choice question, mapped deterministically without any LLM."""

    choice_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        min_length=1, max_length=50
    )
    free_text: str | None = Field(default=None, min_length=1, max_length=4000)

    @model_validator(mode="after")
    def _unique_choice_ids(self) -> StructuredAnswer:
        if len(set(self.choice_ids)) != len(self.choice_ids):
            raise ValueError("choice_ids must be unique")
        return self


class InitialHistoryItem(NBQRequestModel):
    """One message of a conversation started outside NBQ."""

    role: Role
    message_id: str | None = Field(default=None, min_length=1, max_length=128)
    question_id: str | None = Field(default=None, min_length=1, max_length=128)
    text: str | None = Field(default=None, min_length=1, max_length=8000)
    structured_answer: StructuredAnswer | None = None
    occurred_at: datetime | None = None

    @model_validator(mode="after")
    def _text_or_structured_answer(self) -> InitialHistoryItem:
        if self.text is None and self.structured_answer is None:
            raise ValueError("provide text or structured_answer")
        return self


class SessionCreateRequest(NBQRequestModel):
    """Body of ``POST /v1/sessions``."""

    client_reference: str | None = Field(default=None, min_length=1, max_length=128)
    max_turns: int | None = Field(default=None, ge=1, le=100)
    initial_history: list[InitialHistoryItem] | None = Field(default=None, max_length=100)


class PreviousTurn(NBQRequestModel):
    """Observation of the last exchange. Every identifier is an optional hint."""

    decision_id: str | None = Field(default=None, min_length=1, max_length=128)
    question_id: str | None = Field(default=None, min_length=1, max_length=128)
    outcome: QuestionOutcome | None = None
    assistant_text: str | None = Field(default=None, min_length=1, max_length=8000)
    user_text: str | None = Field(default=None, min_length=1, max_length=8000)
    structured_answer: StructuredAnswer | None = None
    message_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def _at_least_one_field(self) -> PreviousTurn:
        if not self.model_dump(exclude_none=True):
            raise ValueError("previous_turn must carry at least one field")
        return self


class ConversationSummary(NBQRequestModel):
    """Compact summary of what happened since the last NBQ call."""

    mode: Literal["summary"] = "summary"
    text: str = Field(min_length=1, max_length=16000)


class ConversationMessage(NBQRequestModel):
    """One message of a context delta."""

    role: Role
    message_id: str | None = Field(default=None, min_length=1, max_length=128)
    question_id: str | None = Field(default=None, min_length=1, max_length=128)
    text: str | None = Field(default=None, min_length=1, max_length=8000)
    structured_answer: StructuredAnswer | None = None
    occurred_at: datetime | None = None

    @model_validator(mode="after")
    def _text_or_structured_answer(self) -> ConversationMessage:
        if self.text is None and self.structured_answer is None:
            raise ValueError("provide text or structured_answer")
        return self


class ConversationMessageDelta(NBQRequestModel):
    """Ordered delta of the messages NBQ has not seen yet."""

    mode: Literal["messages"] = "messages"
    messages: list[ConversationMessage] = Field(min_length=1, max_length=100)


#: Context that appeared since the last NBQ call: a summary or a message delta.
ContextUpdate: TypeAlias = Annotated[
    ConversationSummary | ConversationMessageDelta,
    Field(discriminator="mode"),
]


class SetDataUpdate(NBQRequestModel):
    """Confirm a success information value already known by the caller."""

    id: str = Field(min_length=1, max_length=128)
    operation: Literal["set"] = "set"
    value: DataValue


class UnsetDataUpdate(NBQRequestModel):
    """Drop the current value of a success information."""

    id: str = Field(min_length=1, max_length=128)
    operation: Literal["unset"]


class NotApplicableDataUpdate(NBQRequestModel):
    """Satisfy a success information without giving it a value."""

    id: str = Field(min_length=1, max_length=128)
    operation: Literal["not_applicable"]


#: A data update: ``set``, ``unset`` or ``not_applicable``.
DataClientUpdate: TypeAlias = SetDataUpdate | UnsetDataUpdate | NotApplicableDataUpdate


class SetSubObjectiveOverride(NBQRequestModel):
    """Force a sub-objective to achieved or prevent an early completion."""

    id: str = Field(min_length=1, max_length=128)
    operation: Literal["set"] = "set"
    status: ObjectiveOverrideValue


class ExcludeSubObjectiveOverride(NBQRequestModel):
    """Remove a sub-objective from selection and from the objective progress."""

    id: str = Field(min_length=1, max_length=128)
    operation: Literal["exclude"] = "exclude"


class ClearSubObjectiveOverride(NBQRequestModel):
    """Drop a previously set sub-objective override."""

    id: str = Field(min_length=1, max_length=128)
    operation: Literal["clear"] = "clear"


#: A sub-objective override: ``set``, ``exclude`` or ``clear``.
SubObjectiveOverrideUpdate: TypeAlias = Annotated[
    SetSubObjectiveOverride | ExcludeSubObjectiveOverride | ClearSubObjectiveOverride,
    Field(discriminator="operation"),
]


class SetObjectiveOverride(NBQRequestModel):
    """Force the objective status."""

    operation: Literal["set"] = "set"
    status: ObjectiveOverrideValue


class ClearObjectiveOverride(NBQRequestModel):
    """Drop a previously set objective override."""

    operation: Literal["clear"] = "clear"


#: An objective override: ``set`` or ``clear``.
ObjectiveOverrideUpdate: TypeAlias = Annotated[
    SetObjectiveOverride | ClearObjectiveOverride,
    Field(discriminator="operation"),
]


class ClientUpdates(NBQRequestModel):
    """Explicit updates from the calling system. They win over inference."""

    data: list[DataClientUpdate] | None = Field(default=None, max_length=100)
    sub_objectives: list[SubObjectiveOverrideUpdate] | None = Field(default=None, max_length=100)
    objective: ObjectiveOverrideUpdate | None = None

    @model_validator(mode="after")
    def _at_least_one_field(self) -> ClientUpdates:
        if self.data is None and self.sub_objectives is None and self.objective is None:
            raise ValueError("client_updates must carry at least one field")
        return self


class SubObjectiveSelection(NBQRequestModel):
    """Restrict or prefer a set of sub-objectives for this call only."""

    ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        min_length=1, max_length=100
    )
    mode: SubObjectiveSelectionMode


class SelectionOptions(NBQRequestModel):
    """Selection constraints applied before the ranking, for this call only."""

    candidate_count: int | None = Field(default=None, ge=1, le=10)
    sub_objectives: SubObjectiveSelection | None = None
    allowed_question_types: list[QuestionType] | None = Field(default=None, min_length=1)
    required_target_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] | None = Field(
        default=None, min_length=1, max_length=100
    )
    excluded_question_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] | None = Field(
        default=None, max_length=500
    )


class NextRequest(NBQRequestModel):
    """Body of ``POST /v1/sessions/{session_id}/next``."""

    state_version: int = Field(ge=0)
    previous_turn: PreviousTurn | None = None
    context_update: ContextUpdate | None = None
    client_updates: ClientUpdates | None = None
    selection: SelectionOptions | None = None


class SessionEventsRequest(NBQRequestModel):
    """Body of ``POST /v1/sessions/{session_id}/events``."""

    state_version: int = Field(ge=0)
    context_update: ContextUpdate | None = None
    client_updates: ClientUpdates | None = None

    @model_validator(mode="after")
    def _context_or_client_updates(self) -> SessionEventsRequest:
        if self.context_update is None and self.client_updates is None:
            raise ValueError("provide context_update or client_updates")
        return self


class FeedbackRequest(NBQRequestModel):
    """Body of ``POST /v1/sessions/{session_id}/feedback``."""

    result: FeedbackResult
    label: str | None = Field(default=None, min_length=1, max_length=128)
    metadata: dict[str, MetadataValue] | None = Field(default=None, max_length=50)


class FeedbackResponse(NBQResponseModel):
    """Acknowledgement of a recorded conversation outcome."""

    request_id: str
    session_id: str
    feedback_id: str
    recorded_at: datetime


class CandidateChoice(NBQResponseModel):
    """One published choice of a proposed question."""

    choice_id: str
    label: str


class Candidate(NBQResponseModel):
    """A proposed question. ``rank`` 1 is the most relevant."""

    rank: int
    question_id: str
    text: str
    type: QuestionType
    choices: list[CandidateChoice]
    target_ids: list[str]


class VersionInfo(NBQResponseModel):
    """Versions carried by every session response."""

    state_version: int
    engine_version: str
    api_version: str


class ObjectiveClientOverrideView(NBQResponseModel):
    """Objective override currently applied by the client."""

    status: ObjectiveOverrideValue
    updated_at: datetime | None = None


class SubObjectiveClientOverrideView(NBQResponseModel):
    """Sub-objective override currently applied by the client."""

    status: SubObjectiveOverrideValue
    updated_at: datetime | None = None


class ObjectiveProgress(NBQResponseModel):
    """Objective progress, before and after the client override."""

    computed_status: ProgressStatus
    progress: float
    client_override: ObjectiveClientOverrideView | None
    effective_status: ProgressStatus


class SubObjectiveProgress(NBQResponseModel):
    """Sub-objective progress, before and after the client override."""

    id: str
    order_position: int
    completion_role: CompletionRole
    computed_status: ProgressStatus
    progress: float
    client_override: SubObjectiveClientOverrideView | None
    effective_status: SubObjectiveEffectiveStatus


class ProgressView(NBQResponseModel):
    """Objective and sub-objective progress of a session."""

    objective: ObjectiveProgress
    sub_objectives: list[SubObjectiveProgress]


class NextResponse(NBQResponseModel):
    """Result of ``POST /v1/sessions/{session_id}/next``.

    ``action: ask`` implies a non-null ``decision_id``, a null ``stop_reason``
    and at least one candidate. ``action: stop`` implies the opposite.
    """

    request_id: str
    session_id: str
    decision_id: str | None
    action: NextAction
    stop_reason: StopReason | None
    candidates: list[Candidate]
    progress: ProgressView
    turn_count: int
    turns_remaining: int
    warnings: list[SelectionWarning]
    degraded: bool
    degraded_reasons: list[DegradedReason]
    versions: VersionInfo


class QuestionOutcomeRecord(NBQResponseModel):
    """Outcome of a question that was actually asked."""

    question_id: str
    decision_id: str | None
    outcome: QuestionOutcome
    source: OutcomeSource
    message_id: str | None = None
    occurred_at: datetime | None = None


class PublicQuestionState(NBQResponseModel):
    """Everything the session knows about the questions already asked."""

    outcomes: list[QuestionOutcomeRecord]


class PublicTargetState(NBQResponseModel):
    """Public view of a target. ``coverage`` measures progress, never success."""

    kind: TargetKind
    status: TargetStatus | None = None
    value: Any = None
    coverage: float


class PendingDecisionView(NBQResponseModel):
    """A decision proposed and not resolved yet, with rehydrated candidates."""

    decision_id: str
    candidates: list[Candidate]


class SessionStateResponse(NBQResponseModel):
    """Full resumable state of a session."""

    request_id: str
    session_id: str
    client_reference: str | None
    status: SessionStatus
    turn_count: int
    max_turns: int
    turns_remaining: int
    question_state: PublicQuestionState
    targets: dict[str, PublicTargetState]
    progress: ProgressView
    pending_decision: PendingDecisionView | None
    degraded: bool
    versions: VersionInfo


# ------------------------------------------------------------- configuration


class Objective(NBQResponseModel):
    """The single objective of an NBQ."""

    name: str
    description: str | None = None
    qualification_level: QualificationLevel
    max_turns: int
    candidates_per_call: int
    order_strength: float


class SubObjective(NBQResponseModel):
    """One ordered step of the objective."""

    id: str
    name: str
    order_position: int
    completion_role: CompletionRole


class SuccessInformation(NBQResponseModel):
    """A concrete datum whose collection lets the objective be declared met.

    The contract calls the JSON Schema field ``schema``; that name shadows a
    ``BaseModel`` attribute, so the attribute is ``json_schema`` and the wire
    name stays ``schema``.
    """

    id: str
    label: str
    json_schema: dict[str, Any] = Field(alias="schema")
    primary_question_id: str


class ConfiguredChoice(NBQResponseModel):
    """A configured choice. Shared by the configuration read and the changes."""

    id: str
    label: str
    maps_to_value: Any = None


class ConfiguredQuestion(NBQResponseModel):
    """A question of the corpus, as configured in NBQ Studio."""

    id: str
    text: str
    type: QuestionType
    choices: list[ConfiguredChoice]
    sub_objective_id: str
    active: bool


class ConfigurationResponse(NBQResponseModel):
    """The four objects configured in NBQ Studio."""

    request_id: str
    state: ConfigurationState
    configuration_version: str | None = None
    draft_revision: int | None = None
    published_at: datetime | None = None
    objective: Objective
    sub_objectives: list[SubObjective]
    success_informations: list[SuccessInformation]
    questions: list[ConfiguredQuestion]


class QuestionListResponse(NBQResponseModel):
    """One cursor page of the question corpus."""

    request_id: str
    state: ConfigurationState
    questions: list[ConfiguredQuestion]
    next_cursor: str | None
    total: int | None = None


class ConfigurationAuditActor(NBQResponseModel):
    """Who performed a configuration action. Never a plaintext API key."""

    type: AuditActorType
    id: str


class ConfigurationAuditResource(NBQResponseModel):
    """Which resource a configuration action touched."""

    type: ConfigurationAuditResourceType
    id: str


class ConfigurationAuditDiff(NBQResponseModel):
    """Sanitised structural diff. Editorial free text is never copied here."""

    before: dict[str, Any] | None
    after: dict[str, Any] | None


class ConfigurationAuditEvent(NBQResponseModel):
    """One append-only configuration audit entry."""

    id: str
    occurred_at: datetime
    action: str
    origin: AuditOrigin
    actor: ConfigurationAuditActor
    scopes: list[str]
    request_id: str
    resource: ConfigurationAuditResource
    diff: ConfigurationAuditDiff
    details: dict[str, Any]


class ConfigurationAuditPage(NBQResponseModel):
    """One cursor page of the configuration audit log."""

    request_id: str
    events: list[ConfigurationAuditEvent]
    next_cursor: str | None


class ConfigurationIssue(NBQResponseModel):
    """A configuration anomaly, ready to be displayed as-is.

    ``code`` is a free string on purpose: the contract does not freeze the
    catalogue, so a client must display ``message`` and never assume it knows
    every code.
    """

    code: str
    message: str
    entity: ConfigurationIssueEntity | None = None
    entity_id: str | None = None
    change_index: int | None = None


class ObjectivePatch(NBQRequestModel):
    """Fields of the objective an ``objective`` change may update."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    qualification_level: QualificationLevel | None = None
    max_turns: int | None = Field(default=None, ge=1, le=100)
    candidates_per_call: int | None = Field(default=None, ge=1, le=10)
    order_strength: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def _at_least_one_field(self) -> ObjectivePatch:
        if not self.model_dump(exclude_none=True):
            raise ValueError("objective must carry at least one field")
        return self


class ObjectiveChange(NBQRequestModel):
    """Update the objective. It can be neither created nor deleted."""

    entity: Literal["objective"] = "objective"
    operation: Literal["update"] = "update"
    objective: ObjectivePatch


class SubObjectivePatch(NBQRequestModel):
    """Fields of a sub-objective a ``sub_objective`` change carries."""

    id: str = Field(min_length=1, max_length=128)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    order_position: int | None = Field(default=None, ge=0)
    completion_role: CompletionRole | None = None


class SubObjectiveChange(NBQRequestModel):
    """Create, update or delete a sub-objective."""

    entity: Literal["sub_objective"] = "sub_objective"
    operation: ChangeOperation
    sub_objective: SubObjectivePatch


class SuccessInformationPatch(NBQRequestModel):
    """Fields of a success information a change carries.

    ``json_schema`` is serialised as ``schema``, like
    :class:`SuccessInformation`.
    """

    id: str = Field(min_length=1, max_length=128)
    label: str | None = Field(default=None, min_length=1, max_length=200)
    json_schema: dict[str, Any] | None = Field(default=None, alias="schema")
    primary_question_id: str | None = Field(default=None, min_length=1, max_length=128)


class SuccessInformationChange(NBQRequestModel):
    """Create, update or delete a success information."""

    entity: Literal["success_information"] = "success_information"
    operation: ChangeOperation
    success_information: SuccessInformationPatch


class QuestionPatch(NBQRequestModel):
    """Fields of a question a ``question`` change carries."""

    id: str = Field(min_length=1, max_length=128)
    text: str | None = Field(default=None, min_length=1, max_length=4000)
    type: QuestionType | None = None
    choices: list[ConfiguredChoice] | None = Field(default=None, max_length=50)
    sub_objective_id: str | None = Field(default=None, min_length=1, max_length=128)
    active: bool | None = None


class QuestionChange(NBQRequestModel):
    """Create, update or delete a question."""

    entity: Literal["question"] = "question"
    operation: ChangeOperation
    question: QuestionPatch


#: One configuration operation, discriminated by ``entity``.
ConfigurationChange: TypeAlias = Annotated[
    ObjectiveChange | SubObjectiveChange | SuccessInformationChange | QuestionChange,
    Field(discriminator="entity"),
]


class ConfigurationChangesRequest(NBQRequestModel):
    """Body of ``POST /v1/configuration/changes``. Applied atomically."""

    expected_draft_revision: int | None = Field(default=None, ge=0)
    changes: list[ConfigurationChange] = Field(min_length=1, max_length=500)


class ConfigurationChangesResponse(NBQResponseModel):
    """New draft revision after a batch of changes."""

    request_id: str
    draft_revision: int
    applied: int
    warnings: list[ConfigurationIssue]


class PublishRequest(NBQRequestModel):
    """Body of ``POST /v1/configuration/publish``."""

    expected_draft_revision: int | None = Field(default=None, ge=0)


class CompilationError(NBQResponseModel):
    """Bounded cause of a compilation failure."""

    code: CompilationErrorCode
    message: str
    details: list[ConfigurationIssue] | None = None


class CompilationStatus(NBQResponseModel):
    """Progress of a publication job."""

    request_id: str
    compilation_id: str
    status: CompilationStatusValue
    draft_revision: int
    created_at: datetime
    updated_at: datetime
    progress: float
    error: CompilationError | None
    configuration_version: str | None


class ErrorEnvelope(NBQResponseModel):
    """Uniform envelope of every business error."""

    code: ErrorCode
    message: str
    request_id: str
    details: dict[str, Any]


# ------------------------------------------------------------------- aliases

#: Friendly alias of :class:`SessionStateResponse`.
SessionState: TypeAlias = SessionStateResponse
#: Friendly alias of :class:`ConfigurationResponse`.
Configuration: TypeAlias = ConfigurationResponse

__all__ = [
    "AuditActorType",
    "AuditOrigin",
    "Candidate",
    "CandidateChoice",
    "ChangeOperation",
    "ClearObjectiveOverride",
    "ClearSubObjectiveOverride",
    "ClientUpdates",
    "CompilationError",
    "CompilationErrorCode",
    "CompilationStatus",
    "CompilationStatusValue",
    "CompletionRole",
    "Configuration",
    "ConfigurationAuditActor",
    "ConfigurationAuditDiff",
    "ConfigurationAuditEvent",
    "ConfigurationAuditPage",
    "ConfigurationAuditResource",
    "ConfigurationAuditResourceType",
    "ConfigurationChange",
    "ConfigurationChangesRequest",
    "ConfigurationChangesResponse",
    "ConfigurationIssue",
    "ConfigurationIssueEntity",
    "ConfigurationResponse",
    "ConfigurationState",
    "ConfiguredChoice",
    "ConfiguredQuestion",
    "ContextUpdate",
    "ConversationMessage",
    "ConversationMessageDelta",
    "ConversationSummary",
    "DataClientUpdate",
    "DataValue",
    "DegradedReason",
    "ErrorCode",
    "ErrorEnvelope",
    "ExcludeSubObjectiveOverride",
    "FeedbackRequest",
    "FeedbackResponse",
    "FeedbackResult",
    "InitialHistoryItem",
    "MetadataValue",
    "NBQRequestModel",
    "NBQResponseModel",
    "NextAction",
    "NextRequest",
    "NextResponse",
    "NotApplicableDataUpdate",
    "Objective",
    "ObjectiveChange",
    "ObjectiveClientOverrideView",
    "ObjectiveOverrideUpdate",
    "ObjectiveOverrideValue",
    "ObjectivePatch",
    "ObjectiveProgress",
    "OutcomeSource",
    "PendingDecisionView",
    "PreviousTurn",
    "ProgressStatus",
    "ProgressView",
    "PublicQuestionState",
    "PublicTargetState",
    "PublishRequest",
    "QualificationLevel",
    "QuestionChange",
    "QuestionListResponse",
    "QuestionOutcome",
    "QuestionOutcomeRecord",
    "QuestionPatch",
    "QuestionType",
    "Role",
    "SelectionOptions",
    "SelectionWarning",
    "SessionCreateRequest",
    "SessionEventsRequest",
    "SessionState",
    "SessionStateResponse",
    "SessionStatus",
    "SetDataUpdate",
    "SetObjectiveOverride",
    "SetSubObjectiveOverride",
    "StopReason",
    "StructuredAnswer",
    "SubObjective",
    "SubObjectiveChange",
    "SubObjectiveClientOverrideView",
    "SubObjectiveEffectiveStatus",
    "SubObjectiveOverrideUpdate",
    "SubObjectiveOverrideValue",
    "SubObjectivePatch",
    "SubObjectiveProgress",
    "SubObjectiveSelection",
    "SubObjectiveSelectionMode",
    "SuccessInformation",
    "SuccessInformationChange",
    "SuccessInformationPatch",
    "TargetKind",
    "TargetStatus",
    "UnsetDataUpdate",
    "VersionInfo",
]
