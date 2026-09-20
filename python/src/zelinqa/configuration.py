"""Configuration clients for the NBQ Studio-facing routes.

Reading the published corpus needs ``configuration:read``; reading the draft
and writing changes need ``configuration:write``; publishing and reading the
audit log need ``configuration:publish``. Studio recommends separate keys, so
these clients are separate from the runtime one.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from types import TracebackType
from typing import Any

import httpx

from ._http import (
    API_KEY_ENV,
    CONFIGURATION_API_KEY_ENV,
    CSV_ACCEPT,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_SECONDS,
    AsyncExecutor,
    Request,
    SyncExecutor,
    json_payload,
    path_segment,
    query_params,
    resolve_api_key,
    resolve_base_url,
    resolve_idempotency_key,
    text_payload,
    validate_max_retries,
    validate_timeout,
)
from .errors import ZelinqaCompilationTimeoutError
from .models import (
    CompilationStatus,
    ConfigurationAuditPage,
    ConfigurationAuditResourceType,
    ConfigurationChange,
    ConfigurationChangesRequest,
    ConfigurationChangesResponse,
    ConfigurationResponse,
    ConfigurationState,
    ConfiguredQuestion,
    PublishRequest,
    QuestionListResponse,
    QuestionType,
)

__all__ = [
    "AsyncZelinqaConfigurationClient",
    "ZelinqaCompilationTimeoutError",
    "ZelinqaConfigurationClient",
]

_CONFIGURATION = "/v1/configuration"
_QUESTIONS = f"{_CONFIGURATION}/questions"
_AUDIT = f"{_CONFIGURATION}/audit"
_CHANGES = f"{_CONFIGURATION}/changes"
_PUBLISH = f"{_CONFIGURATION}/publish"
_COMPILATIONS = f"{_CONFIGURATION}/compilations"

_TERMINAL_STATUSES = frozenset({"succeeded", "failed"})

DEFAULT_POLL_INTERVAL_SECONDS = 2.0
DEFAULT_COMPILATION_TIMEOUT_SECONDS = 900.0

#: A change accepts either the typed model or a plain mapping.
ChangeInput = ConfigurationChange | Mapping[str, Any]


def _questions_params(
    *,
    state: ConfigurationState | None,
    sub_objective_id: str | None,
    active: bool | None,
    type: QuestionType | None,
    search: str | None,
    limit: int | None,
    cursor: str | None,
    output_format: str | None = None,
) -> dict[str, str]:
    return query_params(
        {
            "state": state,
            "sub_objective_id": sub_objective_id,
            "active": active,
            "type": type,
            "search": search,
            "limit": limit,
            "cursor": cursor,
            "format": output_format,
        }
    )


def _changes_body(
    changes: Sequence[ChangeInput], *, expected_draft_revision: int | None
) -> dict[str, Any]:
    raw: dict[str, Any] = {"changes": list(changes)}
    if expected_draft_revision is not None:
        raw["expected_draft_revision"] = expected_draft_revision
    return _dump(ConfigurationChangesRequest.model_validate(raw))


def _publish_body(*, expected_draft_revision: int | None) -> dict[str, Any]:
    raw: dict[str, Any] = {}
    if expected_draft_revision is not None:
        raw["expected_draft_revision"] = expected_draft_revision
    return _dump(PublishRequest.model_validate(raw))


def _dump(model: ConfigurationChangesRequest | PublishRequest) -> dict[str, Any]:
    """Serialise a request body: JSON types, aliases, and no unset field."""

    payload = model.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(model, ConfigurationChangesRequest):
        for change, wire in zip(model.changes, payload["changes"], strict=True):
            if change.entity == "question" and "selection_mode" in change.question.model_fields_set:
                wire["question"]["selection_mode"] = change.question.selection_mode
    return payload


def _compilation_path(compilation_id: str) -> str:
    return f"{_COMPILATIONS}/{path_segment(compilation_id)}"


def _timeout_error(compilation_id: str, timeout: float) -> ZelinqaCompilationTimeoutError:
    return ZelinqaCompilationTimeoutError(
        f"compilation {compilation_id} did not reach a terminal status within {timeout:g}s",
        compilation_id=compilation_id,
        timeout=timeout,
    )


def _validate_polling(poll_interval: float, timeout: float) -> None:
    if poll_interval < 0:
        raise ValueError("poll_interval must be zero or greater")
    if timeout <= 0:
        raise ValueError("timeout must be greater than zero")


class ZelinqaConfigurationClient:
    """Blocking client for the NBQ configuration routes.

    ``api_key`` falls back to ``ZELINQA_CONFIGURATION_API_KEY`` then
    ``ZELINQA_API_KEY``; ``base_url`` to ``ZELINQA_BASE_URL`` then
    ``https://api.zelinqa.ai``.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = resolve_base_url(base_url)
        self._executor = SyncExecutor(
            api_key=resolve_api_key(api_key, env_names=(CONFIGURATION_API_KEY_ENV, API_KEY_ENV)),
            base_url=self._base_url,
            timeout=validate_timeout(timeout),
            max_retries=validate_max_retries(max_retries),
            transport=transport,
        )

    def __repr__(self) -> str:
        return f"ZelinqaConfigurationClient(base_url={self._base_url!r})"

    def __enter__(self) -> ZelinqaConfigurationClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        """Release the underlying connection pool."""

        self._executor.close()

    # -------------------------------------------------------------- routes

    def get_configuration(
        self, *, state: ConfigurationState = "published"
    ) -> ConfigurationResponse:
        """Read the objective, sub-objectives, success informations and questions."""

        attempt = self._executor.send(
            Request(method="GET", path=_CONFIGURATION, params=query_params({"state": state}))
        )
        return ConfigurationResponse.model_validate(json_payload(attempt))

    def list_questions(
        self,
        *,
        state: ConfigurationState | None = None,
        sub_objective_id: str | None = None,
        active: bool | None = None,
        type: QuestionType | None = None,
        search: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> QuestionListResponse:
        """Read one cursor page of the question corpus."""

        attempt = self._executor.send(
            Request(
                method="GET",
                path=_QUESTIONS,
                params=_questions_params(
                    state=state,
                    sub_objective_id=sub_objective_id,
                    active=active,
                    type=type,
                    search=search,
                    limit=limit,
                    cursor=cursor,
                ),
            )
        )
        return QuestionListResponse.model_validate(json_payload(attempt))

    def iter_questions(
        self,
        *,
        state: ConfigurationState | None = None,
        sub_objective_id: str | None = None,
        active: bool | None = None,
        type: QuestionType | None = None,
        search: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> Iterator[ConfiguredQuestion]:
        """Walk every matching question, following the opaque cursor."""

        next_cursor = cursor
        while True:
            page = self.list_questions(
                state=state,
                sub_objective_id=sub_objective_id,
                active=active,
                type=type,
                search=search,
                limit=limit,
                cursor=next_cursor,
            )
            yield from page.questions
            if page.next_cursor is None:
                return
            next_cursor = page.next_cursor

    def export_questions_csv(
        self,
        *,
        state: ConfigurationState | None = None,
        sub_objective_id: str | None = None,
        active: bool | None = None,
        type: QuestionType | None = None,
        search: str | None = None,
    ) -> str:
        """Export the filtered corpus as ``text/csv``, cursor pagination ignored."""

        attempt = self._executor.send(
            Request(
                method="GET",
                path=_QUESTIONS,
                params=_questions_params(
                    state=state,
                    sub_objective_id=sub_objective_id,
                    active=active,
                    type=type,
                    search=search,
                    limit=None,
                    cursor=None,
                    output_format="csv",
                ),
                accept=CSV_ACCEPT,
            )
        )
        return text_payload(attempt)

    def list_audit(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        action: str | None = None,
        resource_type: ConfigurationAuditResourceType | None = None,
    ) -> ConfigurationAuditPage:
        """Read one cursor page of the configuration audit log."""

        attempt = self._executor.send(
            Request(
                method="GET",
                path=_AUDIT,
                params=query_params(
                    {
                        "limit": limit,
                        "cursor": cursor,
                        "action": action,
                        "resource_type": resource_type,
                    }
                ),
            )
        )
        return ConfigurationAuditPage.model_validate(json_payload(attempt))

    def apply_changes(
        self,
        changes: Sequence[ChangeInput],
        *,
        expected_draft_revision: int | None = None,
        idempotency_key: str | None = None,
    ) -> ConfigurationChangesResponse:
        """Apply an ordered batch of draft changes atomically."""

        attempt = self._executor.send(
            Request(
                method="POST",
                path=_CHANGES,
                json_body=_changes_body(changes, expected_draft_revision=expected_draft_revision),
                idempotency_key=resolve_idempotency_key(idempotency_key),
            )
        )
        return ConfigurationChangesResponse.model_validate(json_payload(attempt))

    def publish(
        self,
        *,
        expected_draft_revision: int | None = None,
        idempotency_key: str | None = None,
    ) -> CompilationStatus:
        """Queue a compilation of the draft. Returns as soon as it is accepted."""

        attempt = self._executor.send(
            Request(
                method="POST",
                path=_PUBLISH,
                json_body=_publish_body(expected_draft_revision=expected_draft_revision),
                idempotency_key=resolve_idempotency_key(idempotency_key),
            )
        )
        return CompilationStatus.model_validate(json_payload(attempt))

    def get_compilation(self, compilation_id: str) -> CompilationStatus:
        """Read the progress of a compilation job."""

        attempt = self._executor.send(Request(method="GET", path=_compilation_path(compilation_id)))
        return CompilationStatus.model_validate(json_payload(attempt))

    def wait_for_compilation(
        self,
        compilation_id: str,
        *,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
        timeout: float = DEFAULT_COMPILATION_TIMEOUT_SECONDS,
    ) -> CompilationStatus:
        """Poll until the job succeeds or fails.

        A failure is a normal outcome here, not an exception: inspect
        ``status.error``. Only running out of time raises
        :class:`~zelinqa.errors.ZelinqaCompilationTimeoutError`.
        """

        _validate_polling(poll_interval, timeout)
        deadline = time.monotonic() + timeout
        while True:
            status = self.get_compilation(compilation_id)
            if status.status in _TERMINAL_STATUSES:
                return status
            if time.monotonic() + poll_interval >= deadline:
                raise _timeout_error(compilation_id, timeout)
            time.sleep(poll_interval)


class AsyncZelinqaConfigurationClient:
    """Async configuration client. Same surface as :class:`ZelinqaConfigurationClient`."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = resolve_base_url(base_url)
        self._executor = AsyncExecutor(
            api_key=resolve_api_key(api_key, env_names=(CONFIGURATION_API_KEY_ENV, API_KEY_ENV)),
            base_url=self._base_url,
            timeout=validate_timeout(timeout),
            max_retries=validate_max_retries(max_retries),
            transport=transport,
        )

    def __repr__(self) -> str:
        return f"AsyncZelinqaConfigurationClient(base_url={self._base_url!r})"

    async def __aenter__(self) -> AsyncZelinqaConfigurationClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Release the underlying connection pool."""

        await self._executor.aclose()

    #: Alias of :meth:`aclose`, for symmetry with the blocking client.
    close = aclose

    # -------------------------------------------------------------- routes

    async def get_configuration(
        self, *, state: ConfigurationState = "published"
    ) -> ConfigurationResponse:
        """Read the objective, sub-objectives, success informations and questions."""

        attempt = await self._executor.send(
            Request(method="GET", path=_CONFIGURATION, params=query_params({"state": state}))
        )
        return ConfigurationResponse.model_validate(json_payload(attempt))

    async def list_questions(
        self,
        *,
        state: ConfigurationState | None = None,
        sub_objective_id: str | None = None,
        active: bool | None = None,
        type: QuestionType | None = None,
        search: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> QuestionListResponse:
        """Read one cursor page of the question corpus."""

        attempt = await self._executor.send(
            Request(
                method="GET",
                path=_QUESTIONS,
                params=_questions_params(
                    state=state,
                    sub_objective_id=sub_objective_id,
                    active=active,
                    type=type,
                    search=search,
                    limit=limit,
                    cursor=cursor,
                ),
            )
        )
        return QuestionListResponse.model_validate(json_payload(attempt))

    async def iter_questions(
        self,
        *,
        state: ConfigurationState | None = None,
        sub_objective_id: str | None = None,
        active: bool | None = None,
        type: QuestionType | None = None,
        search: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> AsyncIterator[ConfiguredQuestion]:
        """Walk every matching question, following the opaque cursor."""

        next_cursor = cursor
        while True:
            page = await self.list_questions(
                state=state,
                sub_objective_id=sub_objective_id,
                active=active,
                type=type,
                search=search,
                limit=limit,
                cursor=next_cursor,
            )
            for question in page.questions:
                yield question
            if page.next_cursor is None:
                return
            next_cursor = page.next_cursor

    async def export_questions_csv(
        self,
        *,
        state: ConfigurationState | None = None,
        sub_objective_id: str | None = None,
        active: bool | None = None,
        type: QuestionType | None = None,
        search: str | None = None,
    ) -> str:
        """Export the filtered corpus as ``text/csv``, cursor pagination ignored."""

        attempt = await self._executor.send(
            Request(
                method="GET",
                path=_QUESTIONS,
                params=_questions_params(
                    state=state,
                    sub_objective_id=sub_objective_id,
                    active=active,
                    type=type,
                    search=search,
                    limit=None,
                    cursor=None,
                    output_format="csv",
                ),
                accept=CSV_ACCEPT,
            )
        )
        return text_payload(attempt)

    async def list_audit(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        action: str | None = None,
        resource_type: ConfigurationAuditResourceType | None = None,
    ) -> ConfigurationAuditPage:
        """Read one cursor page of the configuration audit log."""

        attempt = await self._executor.send(
            Request(
                method="GET",
                path=_AUDIT,
                params=query_params(
                    {
                        "limit": limit,
                        "cursor": cursor,
                        "action": action,
                        "resource_type": resource_type,
                    }
                ),
            )
        )
        return ConfigurationAuditPage.model_validate(json_payload(attempt))

    async def apply_changes(
        self,
        changes: Sequence[ChangeInput],
        *,
        expected_draft_revision: int | None = None,
        idempotency_key: str | None = None,
    ) -> ConfigurationChangesResponse:
        """Apply an ordered batch of draft changes atomically."""

        attempt = await self._executor.send(
            Request(
                method="POST",
                path=_CHANGES,
                json_body=_changes_body(changes, expected_draft_revision=expected_draft_revision),
                idempotency_key=resolve_idempotency_key(idempotency_key),
            )
        )
        return ConfigurationChangesResponse.model_validate(json_payload(attempt))

    async def publish(
        self,
        *,
        expected_draft_revision: int | None = None,
        idempotency_key: str | None = None,
    ) -> CompilationStatus:
        """Queue a compilation of the draft. Returns as soon as it is accepted."""

        attempt = await self._executor.send(
            Request(
                method="POST",
                path=_PUBLISH,
                json_body=_publish_body(expected_draft_revision=expected_draft_revision),
                idempotency_key=resolve_idempotency_key(idempotency_key),
            )
        )
        return CompilationStatus.model_validate(json_payload(attempt))

    async def get_compilation(self, compilation_id: str) -> CompilationStatus:
        """Read the progress of a compilation job."""

        attempt = await self._executor.send(
            Request(method="GET", path=_compilation_path(compilation_id))
        )
        return CompilationStatus.model_validate(json_payload(attempt))

    async def wait_for_compilation(
        self,
        compilation_id: str,
        *,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
        timeout: float = DEFAULT_COMPILATION_TIMEOUT_SECONDS,
    ) -> CompilationStatus:
        """Poll until the job succeeds or fails.

        A failure is a normal outcome here, not an exception: inspect
        ``status.error``. Only running out of time raises
        :class:`~zelinqa.errors.ZelinqaCompilationTimeoutError`.
        """

        _validate_polling(poll_interval, timeout)
        deadline = time.monotonic() + timeout
        while True:
            status = await self.get_compilation(compilation_id)
            if status.status in _TERMINAL_STATUSES:
                return status
            if time.monotonic() + poll_interval >= deadline:
                raise _timeout_error(compilation_id, timeout)
            await asyncio.sleep(poll_interval)
