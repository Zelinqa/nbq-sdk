"""Synchronous and asynchronous clients for the NBQ runtime API."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, cast
from urllib.parse import quote, urlsplit

import httpx

from ._version import __version__
from .errors import NBQConnectionError, api_error_from_payload
from .models import (
    ConversionResponse,
    MessageInput,
    NextQuestionsResponse,
    Outcome,
    serialize_messages,
)

DEFAULT_BASE_URL = "https://api.zelinqa.ai"
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_RETRIES = 2
MAX_SESSION_ID_CHARS = 128
MAX_HISTORY_MESSAGES = 50
MAX_ANSWERED_QUESTIONS = 200
MAX_CONTEXT_CHARS = 8000
MAX_METADATA_BYTES = 4096
RETRIABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})


def _validate_settings(api_key: str, base_url: str, timeout: float, max_retries: int) -> None:
    if not api_key.strip():
        raise ValueError("api_key must not be empty")
    parsed_url = urlsplit(base_url)
    if parsed_url.scheme not in ("https", "http") or not parsed_url.netloc:
        raise ValueError("base_url must be an absolute HTTP(S) URL")
    if parsed_url.username or parsed_url.password:
        raise ValueError("base_url must not contain credentials")
    if parsed_url.query or parsed_url.fragment:
        raise ValueError("base_url must not contain a query string or fragment")
    if timeout <= 0:
        raise ValueError("timeout must be greater than zero")
    if max_retries < 0:
        raise ValueError("max_retries must be zero or greater")


def _request_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": f"nbq-python/{__version__}",
    }


def _next_payload(
    *,
    session_id: str,
    conversation_history: Sequence[MessageInput],
    context: str | None,
    answered_question_ids: Sequence[str],
) -> dict[str, Any]:
    if not session_id.strip():
        raise ValueError("session_id must not be empty")
    if len(session_id) > MAX_SESSION_ID_CHARS:
        raise ValueError(f"session_id must not exceed {MAX_SESSION_ID_CHARS} characters")
    if len(conversation_history) > MAX_HISTORY_MESSAGES:
        raise ValueError(f"conversation_history must not exceed {MAX_HISTORY_MESSAGES} messages")
    if len(answered_question_ids) > MAX_ANSWERED_QUESTIONS:
        raise ValueError(f"answered_question_ids must not exceed {MAX_ANSWERED_QUESTIONS} entries")
    if context is not None and len(context) > MAX_CONTEXT_CHARS:
        raise ValueError(f"context must not exceed {MAX_CONTEXT_CHARS} characters")

    messages = serialize_messages(conversation_history)
    if not messages and not (context and context.strip()):
        raise ValueError("provide conversation_history or context")
    if messages and messages[-1]["role"] != "user":
        raise ValueError("the last conversation message must have role='user'")

    return {
        "session_id": session_id,
        "conversation_history": messages,
        "context": context,
        "answered_question_ids": list(answered_question_ids),
    }


def _conversion_payload(*, outcome: Outcome, metadata: Mapping[str, Any] | None) -> dict[str, Any]:
    if outcome not in ("purchase", "lead", "abandon", "other"):
        raise ValueError("outcome must be purchase, lead, abandon or other")
    metadata_payload = dict(metadata or {})
    try:
        metadata_size = len(json.dumps(metadata_payload, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise ValueError("metadata must be JSON serializable") from exc
    if metadata_size > MAX_METADATA_BYTES:
        raise ValueError(f"metadata must not exceed {MAX_METADATA_BYTES} bytes when serialized")
    return {"outcome": outcome, "metadata": metadata_payload}


def _idempotency_key(value: str | None) -> str:
    if value is not None:
        if not value.strip():
            raise ValueError("idempotency_key must not be empty")
        return value
    return str(uuid.uuid4())


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        if retry_after is not None:
            try:
                return min(max(float(retry_after), 0.0), 10.0)
            except ValueError:
                pass
    return float(min(0.25 * (2**attempt), 2.0))


def _response_payload(response: httpx.Response) -> Mapping[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise api_error_from_payload(
            status_code=response.status_code,
            payload={"detail": "NBQ API returned a non-JSON response"},
            request_id=response.headers.get("X-Request-Id"),
        ) from exc
    if not isinstance(payload, Mapping):
        raise api_error_from_payload(
            status_code=response.status_code,
            payload={"detail": "NBQ API returned an invalid JSON payload"},
            request_id=response.headers.get("X-Request-Id"),
        )
    return cast(Mapping[str, Any], payload)


def _raise_for_api_error(response: httpx.Response) -> None:
    if response.is_success:
        return
    payload: Mapping[str, Any] | None
    try:
        raw = response.json()
        payload = cast(Mapping[str, Any], raw) if isinstance(raw, Mapping) else None
    except ValueError:
        payload = None
    request_id = response.headers.get("X-Request-Id")
    if payload and payload.get("request_id"):
        request_id = str(payload["request_id"])
    raise api_error_from_payload(
        status_code=response.status_code,
        payload=payload,
        request_id=request_id,
    )


class NBQClient:
    """Blocking client for the hosted NBQ runtime API."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        _validate_settings(api_key, base_url, timeout, max_retries)
        self._max_retries = max_retries
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers=_request_headers(api_key),
            timeout=timeout,
            transport=transport,
        )

    def __enter__(self) -> NBQClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def _post(
        self, path: str, *, payload: Mapping[str, Any], idempotency_key: str
    ) -> httpx.Response:
        response: httpx.Response | None = None
        for attempt in range(self._max_retries + 1):
            try:
                response = self._http.post(
                    path,
                    json=payload,
                    headers={"Idempotency-Key": idempotency_key},
                )
            except httpx.TransportError as exc:
                if attempt >= self._max_retries:
                    raise NBQConnectionError("Unable to reach the NBQ API") from exc
                time.sleep(_retry_delay(None, attempt))
                continue

            if response.status_code not in RETRIABLE_STATUS_CODES or attempt >= self._max_retries:
                break
            time.sleep(_retry_delay(response, attempt))

        assert response is not None
        _raise_for_api_error(response)
        return response

    def next_question(
        self,
        *,
        session_id: str,
        conversation_history: Sequence[MessageInput] = (),
        context: str | None = None,
        answered_question_ids: Sequence[str] = (),
        idempotency_key: str | None = None,
    ) -> NextQuestionsResponse:
        """Return the next best question for a conversation."""

        response = self._post(
            "/v1/next-questions",
            payload=_next_payload(
                session_id=session_id,
                conversation_history=conversation_history,
                context=context,
                answered_question_ids=answered_question_ids,
            ),
            idempotency_key=_idempotency_key(idempotency_key),
        )
        return NextQuestionsResponse.from_payload(_response_payload(response))

    def report_conversion(
        self,
        *,
        session_id: str,
        outcome: Outcome,
        metadata: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> ConversionResponse:
        """Report the final business outcome of a conversation."""

        if not session_id.strip():
            raise ValueError("session_id must not be empty")
        if len(session_id) > MAX_SESSION_ID_CHARS:
            raise ValueError(f"session_id must not exceed {MAX_SESSION_ID_CHARS} characters")
        response = self._post(
            f"/v1/sessions/{quote(session_id, safe='')}/conversion",
            payload=_conversion_payload(outcome=outcome, metadata=metadata),
            idempotency_key=_idempotency_key(idempotency_key),
        )
        return ConversionResponse.from_payload(_response_payload(response))


class AsyncNBQClient:
    """Async client for the hosted NBQ runtime API."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        _validate_settings(api_key, base_url, timeout, max_retries)
        self._max_retries = max_retries
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers=_request_headers(api_key),
            timeout=timeout,
            transport=transport,
        )

    async def __aenter__(self) -> AsyncNBQClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._http.aclose()

    async def _post(
        self, path: str, *, payload: Mapping[str, Any], idempotency_key: str
    ) -> httpx.Response:
        response: httpx.Response | None = None
        for attempt in range(self._max_retries + 1):
            try:
                response = await self._http.post(
                    path,
                    json=payload,
                    headers={"Idempotency-Key": idempotency_key},
                )
            except httpx.TransportError as exc:
                if attempt >= self._max_retries:
                    raise NBQConnectionError("Unable to reach the NBQ API") from exc
                await asyncio.sleep(_retry_delay(None, attempt))
                continue

            if response.status_code not in RETRIABLE_STATUS_CODES or attempt >= self._max_retries:
                break
            await asyncio.sleep(_retry_delay(response, attempt))

        assert response is not None
        _raise_for_api_error(response)
        return response

    async def next_question(
        self,
        *,
        session_id: str,
        conversation_history: Sequence[MessageInput] = (),
        context: str | None = None,
        answered_question_ids: Sequence[str] = (),
        idempotency_key: str | None = None,
    ) -> NextQuestionsResponse:
        """Return the next best question for a conversation."""

        response = await self._post(
            "/v1/next-questions",
            payload=_next_payload(
                session_id=session_id,
                conversation_history=conversation_history,
                context=context,
                answered_question_ids=answered_question_ids,
            ),
            idempotency_key=_idempotency_key(idempotency_key),
        )
        return NextQuestionsResponse.from_payload(_response_payload(response))

    async def report_conversion(
        self,
        *,
        session_id: str,
        outcome: Outcome,
        metadata: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> ConversionResponse:
        """Report the final business outcome of a conversation."""

        if not session_id.strip():
            raise ValueError("session_id must not be empty")
        if len(session_id) > MAX_SESSION_ID_CHARS:
            raise ValueError(f"session_id must not exceed {MAX_SESSION_ID_CHARS} characters")
        response = await self._post(
            f"/v1/sessions/{quote(session_id, safe='')}/conversion",
            payload=_conversion_payload(outcome=outcome, metadata=metadata),
            idempotency_key=_idempotency_key(idempotency_key),
        )
        return ConversionResponse.from_payload(_response_payload(response))
