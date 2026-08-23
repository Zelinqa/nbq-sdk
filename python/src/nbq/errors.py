"""Exceptions raised by the NBQ SDK."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class NBQError(Exception):
    """Base class for every SDK error."""


class NBQConnectionError(NBQError):
    """The API could not be reached after retrying."""


class NBQAPIError(NBQError):
    """The NBQ API returned an unsuccessful response."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        request_id: str | None = None,
        error_type: str | None = None,
        detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.request_id = request_id
        self.error_type = error_type
        self.detail = detail


class NBQAuthenticationError(NBQAPIError):
    """The runtime credential is missing, invalid or not authorised."""


class NBQValidationError(NBQAPIError):
    """The request does not satisfy the API contract."""


class NBQConflictError(NBQAPIError):
    """An idempotency key or future state version conflicts."""


class NBQRateLimitError(NBQAPIError):
    """The runtime credential exceeded its rate limit."""


class NBQServerError(NBQAPIError):
    """The NBQ service failed to process the request."""


def api_error_from_payload(
    *, status_code: int, payload: Mapping[str, Any] | None, request_id: str | None
) -> NBQAPIError:
    data = payload or {}
    title = data.get("title")
    detail = data.get("detail")
    error_type = data.get("type")
    message = str(title or detail or f"NBQ API request failed with status {status_code}")

    error_class: type[NBQAPIError]
    if status_code in (401, 403):
        error_class = NBQAuthenticationError
    elif status_code == 409:
        error_class = NBQConflictError
    elif status_code == 422:
        error_class = NBQValidationError
    elif status_code == 429:
        error_class = NBQRateLimitError
    elif status_code >= 500:
        error_class = NBQServerError
    else:
        error_class = NBQAPIError

    return error_class(
        message,
        status_code=status_code,
        request_id=request_id,
        error_type=str(error_type) if error_type is not None else None,
        detail=detail,
    )
