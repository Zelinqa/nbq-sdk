"""Typed exceptions raised by the NBQ SDK.

Mapping is driven by the business error envelope ``code`` first, then by the
HTTP status when the body is not a V1 envelope.

Two refusals never reach the service and never carry an envelope: ``401`` when
the ``Authorization`` header is missing, and ``403`` when the key is invalid,
revoked, expired, or lacks the scope the gateway authorizer requires for that
route. The authorizer answers the same opaque body in every ``403`` case, so
both map to :class:`NBQAuthenticationError`. Only the service-side dynamic scope
check — today ``?state=draft`` — produces a ``403`` V1 envelope, and that one is
:class:`NBQInsufficientScopeError`.

No exception, message or ``repr`` ever carries the API key.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

from .models import ConfigurationIssue

#: ``Retry-After`` is never honoured beyond this many seconds.
MAX_RETRY_AFTER_SECONDS = 30.0

__all__ = [
    "NBQAPIError",
    "NBQAuthenticationError",
    "NBQCompilationInProgressError",
    "NBQCompilationTimeoutError",
    "NBQCompiledArtifactUnavailableError",
    "NBQConfigurationValidationError",
    "NBQConflictError",
    "NBQConnectionError",
    "NBQConstraintNoMatchError",
    "NBQError",
    "NBQIdempotencyContentionError",
    "NBQIdempotencyKeyReusedError",
    "NBQInsufficientScopeError",
    "NBQInvalidChoiceError",
    "NBQInvalidPreviousTurnError",
    "NBQNotFoundError",
    "NBQRateLimitError",
    "NBQServerError",
    "NBQStateVersionConflictError",
    "NBQUnknownCompilationError",
    "NBQUnknownConfigurationError",
    "NBQUnknownSessionError",
    "NBQValidationError",
    "api_error_from_response",
    "parse_retry_after",
]


class NBQError(Exception):
    """Base class of every SDK error."""


class NBQConnectionError(NBQError):
    """The API could not be reached, or timed out, after every retry."""


class NBQCompilationTimeoutError(NBQError):
    """``wait_for_compilation`` gave up before the job reached a terminal state."""

    def __init__(self, message: str, *, compilation_id: str, timeout: float) -> None:
        super().__init__(message)
        self.compilation_id = compilation_id
        self.timeout = timeout


class NBQAPIError(NBQError):
    """The NBQ API answered with an unsuccessful status."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: str | None = None,
        request_id: str | None = None,
        details: Mapping[str, Any] | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.request_id = request_id
        self.details: dict[str, Any] = dict(details or {})
        self.retry_after = retry_after

    def __str__(self) -> str:
        label = self.code or str(self.status_code)
        suffix = f" (request_id={self.request_id})" if self.request_id else ""
        return f"{label}: {self.message}{suffix}"

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(status_code={self.status_code!r}, code={self.code!r}, "
            f"request_id={self.request_id!r})"
        )


class NBQAuthenticationError(NBQAPIError):
    """The gateway refused the key before the request reached the service.

    Missing header (``401``), or invalid, revoked, expired, or missing the scope
    the authorizer requires for that route (``403`` with no V1 envelope). The
    gateway answers the same body in all the ``403`` cases, so the SDK cannot
    tell them apart either.
    """


class NBQInsufficientScopeError(NBQAPIError):
    """The service refused a scope it can only check from the request content.

    Raised on the ``403`` V1 envelope ``insufficient_scope`` — today only
    ``?state=draft`` asked with a key that lacks ``configuration:write``. A
    scope the authorizer checks statically never reaches this class: it surfaces
    as :class:`NBQAuthenticationError`.
    """

    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.required_scopes: list[str] = _string_list(self.details.get("required_scopes"))
        self.granted_scopes: list[str] = _string_list(self.details.get("granted_scopes"))


class NBQNotFoundError(NBQAPIError):
    """The addressed resource does not exist, or belongs to another tenant."""


class NBQUnknownSessionError(NBQNotFoundError):
    """The session is unknown, or belongs to another tenant."""


class NBQUnknownConfigurationError(NBQNotFoundError):
    """No configuration matches the requested state."""


class NBQUnknownCompilationError(NBQNotFoundError):
    """The compilation job is unknown, or belongs to another tenant."""


class NBQConflictError(NBQAPIError):
    """The request conflicts with the current server state."""


class NBQStateVersionConflictError(NBQConflictError):
    """The session moved since the ``state_version`` the caller supplied."""

    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.supplied_state_version = _optional_int(self.details.get("supplied_state_version"))
        self.current_state_version = _optional_int(self.details.get("current_state_version"))


class NBQIdempotencyKeyReusedError(NBQConflictError):
    """The idempotency key already served for a different body."""

    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.idempotency_key = _optional_str(self.details.get("idempotency_key"))


class NBQCompilationInProgressError(NBQConflictError):
    """A compilation is already queued or running for this NBQ."""

    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.compilation_id = _optional_str(self.details.get("compilation_id"))
        self.status = _optional_str(self.details.get("status"))


class NBQCompiledArtifactUnavailableError(NBQAPIError):
    """The engine artifact pinned by the session is really unreachable."""


class NBQValidationError(NBQAPIError):
    """The request does not satisfy the contract, or leaves no possible answer."""


class NBQInvalidPreviousTurnError(NBQValidationError):
    """The supplied identifiers contradict the pending decision."""


class NBQConstraintNoMatchError(NBQValidationError):
    """No available question satisfies the strict constraints of the call."""


class NBQInvalidChoiceError(NBQValidationError):
    """A supplied value does not belong to the published schema or choices."""


class NBQConfigurationValidationError(NBQValidationError):
    """Draft validation failed. Every anomaly is reported together."""

    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.issues: list[ConfigurationIssue] = _issues(self.details.get("issues"))


class NBQRateLimitError(NBQAPIError):
    """The key exceeded its rate limit."""


class NBQIdempotencyContentionError(NBQAPIError):
    """The idempotency key could not be reserved. Retried first, then raised."""


class NBQServerError(NBQAPIError):
    """The NBQ service failed to process the request."""


_CODE_ERRORS: dict[str, type[NBQAPIError]] = {
    "unauthorized": NBQAuthenticationError,
    "insufficient_scope": NBQInsufficientScopeError,
    "idempotency_contention": NBQIdempotencyContentionError,
    "state_version_conflict": NBQStateVersionConflictError,
    "idempotency_key_reused": NBQIdempotencyKeyReusedError,
    "unknown_session": NBQUnknownSessionError,
    "invalid_previous_turn": NBQInvalidPreviousTurnError,
    "constraint_no_match": NBQConstraintNoMatchError,
    "invalid_choice": NBQInvalidChoiceError,
    "compiled_artifact_unavailable": NBQCompiledArtifactUnavailableError,
    "configuration_validation_failed": NBQConfigurationValidationError,
    "compilation_in_progress": NBQCompilationInProgressError,
    "unknown_configuration": NBQUnknownConfigurationError,
    "unknown_compilation": NBQUnknownCompilationError,
}

#: The gateway answers 403 with the same opaque body for an invalid key, a
#: revoked key and a key missing the statically checked scope of the route.
GATEWAY_FORBIDDEN_MESSAGE = (
    "Forbidden by the API gateway: the key is invalid, revoked, expired, or does "
    "not carry the scope required for this route."
)

_STATUS_ERRORS: dict[int, type[NBQAPIError]] = {
    401: NBQAuthenticationError,
    403: NBQAuthenticationError,
    404: NBQNotFoundError,
    409: NBQConflictError,
    410: NBQCompiledArtifactUnavailableError,
    422: NBQValidationError,
    429: NBQRateLimitError,
}


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def _optional_str(value: Any) -> str | None:
    return None if value is None else str(value)


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _issues(value: Any) -> list[ConfigurationIssue]:
    if not isinstance(value, list):
        return []
    parsed: list[ConfigurationIssue] = []
    for item in value:
        if isinstance(item, Mapping):
            try:
                parsed.append(ConfigurationIssue.model_validate(item))
            except ValueError:  # pragma: no cover - defensive, server-side shape
                continue
    return parsed


def error_class_for(status_code: int, code: str | None) -> type[NBQAPIError]:
    """Return the exception class for an envelope code, falling back on status."""

    if code is not None and code in _CODE_ERRORS:
        return _CODE_ERRORS[code]
    if status_code in _STATUS_ERRORS:
        return _STATUS_ERRORS[status_code]
    if status_code >= 500:
        return NBQServerError
    return NBQAPIError


def api_error_from_response(
    status_code: int,
    payload: Any,
    headers: Mapping[str, str] | None = None,
) -> NBQAPIError:
    """Build the typed error for an unsuccessful response.

    ``payload`` is the decoded JSON body when there is one. The public gateway
    answers ``401`` with ``{"message": "Unauthorized"}``, and an infrastructure
    failure may answer with no JSON at all: both are handled.
    """

    envelope: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}
    raw_code = envelope.get("code")
    code = str(raw_code) if isinstance(raw_code, str) and raw_code else None

    raw_details = envelope.get("details")
    details = dict(raw_details) if isinstance(raw_details, Mapping) else {}

    raw_request_id = envelope.get("request_id")
    request_id = str(raw_request_id) if isinstance(raw_request_id, str) and raw_request_id else None
    if request_id is None and headers is not None:
        header_request_id = headers.get("x-request-id") or headers.get("X-Request-Id")
        request_id = header_request_id or None

    if status_code == 403 and code is None:
        # No V1 envelope: the refusal came from the authorizer, which does not
        # say which of the three reasons applied.
        return NBQAuthenticationError(
            GATEWAY_FORBIDDEN_MESSAGE,
            status_code=status_code,
            code=None,
            request_id=request_id,
            details={},
            retry_after=None,
        )

    message = _message_of(envelope, status_code)

    retry_after: float | None = None
    if headers is not None:
        retry_after = parse_retry_after(headers.get("retry-after") or headers.get("Retry-After"))
    if retry_after is None:
        retry_after = _details_retry_after(details)

    return error_class_for(status_code, code)(
        message,
        status_code=status_code,
        code=code,
        request_id=request_id,
        details=details,
        retry_after=retry_after,
    )


def parse_retry_after(value: str | None) -> float | None:
    """Parse a ``Retry-After`` header: delay in seconds, or an HTTP date.

    The result is clamped to ``MAX_RETRY_AFTER_SECONDS``: a server asking an
    integration to wait ten minutes is better surfaced as an error than slept
    through. Returns ``None`` when the header is absent or unparseable.
    """

    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        seconds = float(text)
    except ValueError:
        try:
            moment = parsedate_to_datetime(text)
        except (TypeError, ValueError):
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=UTC)
        seconds = (moment - datetime.now(tz=UTC)).total_seconds()
    return min(max(seconds, 0.0), MAX_RETRY_AFTER_SECONDS)


def _message_of(envelope: Mapping[str, Any], status_code: int) -> str:
    for key in ("message", "detail", "title", "error"):
        value = envelope.get(key)
        if isinstance(value, str) and value:
            return value
    return f"NBQ API request failed with status {status_code}"


def _details_retry_after(details: Mapping[str, Any]) -> float | None:
    value = details.get("retry_after_seconds")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(float(value), 0.0)
