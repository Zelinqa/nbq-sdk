from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from nbq import (
    AsyncNBQClient,
    Message,
    NBQAuthenticationError,
    NBQClient,
    NBQServerError,
)


@pytest.fixture
def captured_requests() -> list[httpx.Request]:
    return []


def _next_response(*, exhausted: bool = False) -> dict[str, Any]:
    return {
        "next_question": (
            None
            if exhausted
            else {"external_id": "q_budget", "text": "What budget have you planned?"}
        ),
        "exhausted": exhausted,
        "nbq_version": "0.9.0-beta.1",
        "request_id": "req_test",
    }


@pytest.fixture
def client(captured_requests: list[httpx.Request]) -> Iterator[NBQClient]:
    def handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        return httpx.Response(200, json=_next_response())

    with NBQClient(
        api_key="nbq_live_test",
        base_url="https://api.example.test",
        max_retries=0,
        transport=httpx.MockTransport(handler),
    ) as value:
        yield value


def test_next_question_sends_auth_idempotency_and_contract(
    client: NBQClient, captured_requests: list[httpx.Request]
) -> None:
    result = client.next_question(
        session_id="session-1",
        conversation_history=[Message(role="user", content="We have 200 leads each month")],
        answered_question_ids=["q_company"],
        idempotency_key="idem-next",
    )

    request = captured_requests[0]
    assert request.url.path == "/v1/next-questions"
    assert request.headers["Authorization"] == "Bearer nbq_live_test"
    assert request.headers["Idempotency-Key"] == "idem-next"
    assert request.headers["User-Agent"].startswith("nbq-python/")
    assert request.read()
    assert result.next_question is not None
    assert result.next_question.external_id == "q_budget"
    assert result.request_id == "req_test"


def test_next_question_parses_exhausted_response() -> None:
    transport = httpx.MockTransport(
        lambda _: httpx.Response(200, json=_next_response(exhausted=True))
    )
    with NBQClient(api_key="key", transport=transport, max_retries=0) as client:
        result = client.next_question(session_id="session-1", context="Conversation summary")

    assert result.exhausted is True
    assert result.next_question is None


def test_report_conversion_generates_idempotency_key_and_escapes_session() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            202,
            json={"conversion_id": "cv_123", "request_id": "req_conversion"},
        )

    with NBQClient(api_key="key", transport=httpx.MockTransport(handler), max_retries=0) as client:
        result = client.report_conversion(
            session_id="session/with/slash",
            outcome="lead",
            metadata={"source": "website"},
        )

    assert requests[0].url.path == "/v1/sessions/session/with/slash/conversion"
    assert requests[0].url.raw_path == b"/v1/sessions/session%2Fwith%2Fslash/conversion"
    assert requests[0].headers["Idempotency-Key"]
    assert result.conversion_id == "cv_123"


def test_authentication_error_preserves_request_id() -> None:
    transport = httpx.MockTransport(
        lambda _: httpx.Response(
            401,
            json={
                "type": "https://docs.zelinqa.ai/errors/invalid_token",
                "title": "Invalid token",
                "request_id": "req_auth",
            },
        )
    )
    with NBQClient(api_key="bad-key", transport=transport, max_retries=0) as client:
        with pytest.raises(NBQAuthenticationError) as captured:
            client.next_question(session_id="session-1", context="summary")

    assert captured.value.status_code == 401
    assert captured.value.request_id == "req_auth"


def test_retries_server_error_with_same_idempotency_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(503, json={"title": "Temporarily unavailable"})
        return httpx.Response(200, json=_next_response())

    monkeypatch.setattr("nbq.client.time.sleep", lambda _: None)
    with NBQClient(api_key="key", transport=httpx.MockTransport(handler), max_retries=1) as client:
        result = client.next_question(
            session_id="session-1", context="summary", idempotency_key="same-key"
        )

    assert result.next_question is not None
    assert len(requests) == 2
    assert {request.headers["Idempotency-Key"] for request in requests} == {"same-key"}


def test_server_error_after_retry_budget() -> None:
    transport = httpx.MockTransport(lambda _: httpx.Response(500, json={"title": "Internal error"}))
    with NBQClient(api_key="key", transport=transport, max_retries=0) as client:
        with pytest.raises(NBQServerError) as captured:
            client.next_question(session_id="session-1", context="summary")
    assert captured.value.status_code == 500


def test_rejects_credentials_inside_base_url() -> None:
    with pytest.raises(ValueError, match="credentials"):
        NBQClient(api_key="key", base_url="https://user:password@example.test")


def test_rejects_oversized_request_fields() -> None:
    with NBQClient(api_key="key", transport=httpx.MockTransport(lambda _: httpx.Response(200))):
        pass

    client = NBQClient(api_key="key", transport=httpx.MockTransport(lambda _: httpx.Response(200)))
    try:
        with pytest.raises(ValueError, match="session_id"):
            client.next_question(session_id="s" * 129, context="summary")
        with pytest.raises(ValueError, match="context"):
            client.next_question(session_id="session", context="x" * 8001)
        with pytest.raises(ValueError, match="answered_question_ids"):
            client.next_question(
                session_id="session",
                context="summary",
                answered_question_ids=[f"q_{index}" for index in range(201)],
            )
    finally:
        client.close()


def test_rejects_oversized_or_non_json_conversion_metadata() -> None:
    client = NBQClient(api_key="key", transport=httpx.MockTransport(lambda _: httpx.Response(202)))
    try:
        with pytest.raises(ValueError, match="4096"):
            client.report_conversion(
                session_id="session",
                outcome="lead",
                metadata={"value": "x" * 4097},
            )
        with pytest.raises(ValueError, match="JSON serializable"):
            client.report_conversion(
                session_id="session",
                outcome="lead",
                metadata={"value": object()},
            )
    finally:
        client.close()


@pytest.mark.asyncio
async def test_async_client() -> None:
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=_next_response()))
    async with AsyncNBQClient(api_key="key", transport=transport, max_retries=0) as client:
        result = await client.next_question(
            session_id="session-async",
            conversation_history=[{"role": "user", "content": "Hello"}],
        )

    assert result.next_question is not None
    assert result.next_question.external_id == "q_budget"
