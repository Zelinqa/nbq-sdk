"""Configuration client: query params, bodies, pagination, CSV and polling.

Every method is exercised twice, blocking and async, over an
``httpx.MockTransport``. Responses are the payloads documented in the frozen
OpenAPI snapshot.
"""

from __future__ import annotations

import copy
from typing import Any

import httpx
import pytest
from nbq import (
    AsyncNBQConfigurationClient,
    NBQCompilationTimeoutError,
    NBQConfigurationClient,
    ObjectiveChange,
    ObjectivePatch,
    QuestionChange,
    QuestionPatch,
    SuccessInformationChange,
    SuccessInformationPatch,
)
from nbq._version import __version__
from spec_examples import (
    CONFIGURATION_PUBLIEE,
    PAGE_DE_QUESTIONS,
    csv_export_example,
    operation_example,
)

API_KEY = "nbq_live_config_test"
BASE_URL = "https://api.example.test"

AUDIT_PAGE = operation_example("/v1/configuration/audit", "get", "200")
CHANGES_APPLIED = operation_example("/v1/configuration/changes", "post", "200")
PUBLISH_QUEUED = operation_example("/v1/configuration/publish", "post", "202")
COMPILATION_RUNNING = operation_example(
    "/v1/configuration/compilations/{compilation_id}", "get", "200", "en_cours"
)
COMPILATION_DONE = operation_example(
    "/v1/configuration/compilations/{compilation_id}", "get", "200", "terminee"
)
COMPILATION_FAILED = operation_example(
    "/v1/configuration/compilations/{compilation_id}", "get", "200", "echouee"
)


class Recorder:
    """Collects the requests a client actually sent."""

    def __init__(self, *responses: httpx.Response) -> None:
        self._responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if len(self._responses) > 1:
            return self._responses.pop(0)
        return self._responses[0]

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def body(self, index: int = -1) -> Any:
        import json

        return json.loads(self.requests[index].content)


def json_response(status: int, payload: Any) -> httpx.Response:
    return httpx.Response(status, json=copy.deepcopy(payload))


def csv_response(body: str) -> httpx.Response:
    return httpx.Response(200, text=body, headers={"content-type": "text/csv; charset=utf-8"})


def sync_client(recorder: Recorder, **kwargs: Any) -> NBQConfigurationClient:
    return NBQConfigurationClient(
        API_KEY,
        base_url=BASE_URL,
        max_retries=0,
        transport=httpx.MockTransport(recorder),
        **kwargs,
    )


def async_client(recorder: Recorder, **kwargs: Any) -> AsyncNBQConfigurationClient:
    return AsyncNBQConfigurationClient(
        API_KEY,
        base_url=BASE_URL,
        max_retries=0,
        transport=httpx.MockTransport(recorder),
        **kwargs,
    )


# ------------------------------------------------------------- construction


def test_repr_never_leaks_the_key() -> None:
    recorder = Recorder(json_response(200, CONFIGURATION_PUBLIEE))
    with sync_client(recorder) as client:
        assert API_KEY not in repr(client)


def test_api_key_prefers_the_configuration_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NBQ_API_KEY", "nbq_live_runtime")
    monkeypatch.setenv("NBQ_CONFIGURATION_API_KEY", "nbq_live_management")
    recorder = Recorder(json_response(200, CONFIGURATION_PUBLIEE))
    with NBQConfigurationClient(
        base_url=BASE_URL, max_retries=0, transport=httpx.MockTransport(recorder)
    ) as client:
        client.get_configuration()
    assert recorder.last.headers["Authorization"] == "Bearer nbq_live_management"


def test_api_key_falls_back_to_the_runtime_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NBQ_CONFIGURATION_API_KEY", raising=False)
    monkeypatch.setenv("NBQ_API_KEY", "nbq_live_shared")
    recorder = Recorder(json_response(200, CONFIGURATION_PUBLIEE))
    with NBQConfigurationClient(
        base_url=BASE_URL, max_retries=0, transport=httpx.MockTransport(recorder)
    ) as client:
        client.get_configuration()
    assert recorder.last.headers["Authorization"] == "Bearer nbq_live_shared"


# -------------------------------------------------------- get_configuration


def test_get_configuration_defaults_to_published() -> None:
    recorder = Recorder(json_response(200, CONFIGURATION_PUBLIEE))
    with sync_client(recorder) as client:
        configuration = client.get_configuration()

    assert recorder.last.method == "GET"
    assert recorder.last.url.path == "/v1/configuration"
    assert dict(recorder.last.url.params) == {"state": "published"}
    assert recorder.last.headers["User-Agent"] == f"nbq-python/{__version__}"
    assert configuration.state == "published"
    assert configuration.configuration_version == "cfg_00013"
    assert configuration.objective.qualification_level == "balanced"
    assert [so.id for so in configuration.sub_objectives] == [
        "so_besoin",
        "so_budget",
        "so_livraison",
    ]
    assert configuration.success_informations[0].json_schema == {"type": "number", "minimum": 0}
    assert configuration.questions[2].choices[0].maps_to_value == "dans_le_mois"
    assert configuration.published_at is not None


def test_get_configuration_can_read_the_draft() -> None:
    draft = copy.deepcopy(CONFIGURATION_PUBLIEE)
    draft["state"] = "draft"
    draft["configuration_version"] = None
    draft["draft_revision"] = 42
    draft["published_at"] = None
    recorder = Recorder(json_response(200, draft))
    with sync_client(recorder) as client:
        configuration = client.get_configuration(state="draft")

    assert dict(recorder.last.url.params) == {"state": "draft"}
    assert configuration.draft_revision == 42
    assert configuration.configuration_version is None


async def test_async_get_configuration() -> None:
    recorder = Recorder(json_response(200, CONFIGURATION_PUBLIEE))
    async with async_client(recorder) as client:
        configuration = await client.get_configuration()
    assert configuration.request_id == "req_1005"


# ------------------------------------------------------------ list_questions


def test_list_questions_serialises_every_filter() -> None:
    recorder = Recorder(json_response(200, PAGE_DE_QUESTIONS))
    with sync_client(recorder) as client:
        page = client.list_questions(
            state="draft",
            sub_objective_id="so_besoin",
            active=True,
            type="single_choice",
            search="canapé",
            limit=2,
            cursor="opaque-cursor",
        )

    assert recorder.last.url.path == "/v1/configuration/questions"
    assert dict(recorder.last.url.params) == {
        "state": "draft",
        "sub_objective_id": "so_besoin",
        "active": "true",
        "type": "single_choice",
        "search": "canapé",
        "limit": "2",
        "cursor": "opaque-cursor",
    }
    assert page.total == 3
    assert page.next_cursor is None
    assert [question.id for question in page.questions] == ["q_style", "q_budget"]


def test_list_questions_sends_no_unset_filter() -> None:
    recorder = Recorder(json_response(200, PAGE_DE_QUESTIONS))
    with sync_client(recorder) as client:
        client.list_questions()
    assert dict(recorder.last.url.params) == {}


def test_list_questions_serialises_a_false_flag() -> None:
    recorder = Recorder(json_response(200, PAGE_DE_QUESTIONS))
    with sync_client(recorder) as client:
        client.list_questions(active=False)
    assert dict(recorder.last.url.params) == {"active": "false"}


def _paginated(recorder_pages: list[dict[str, Any]]) -> Recorder:
    return Recorder(*[json_response(200, page) for page in recorder_pages])


def _page(questions: list[dict[str, Any]], next_cursor: str | None) -> dict[str, Any]:
    return {
        "request_id": "req_page",
        "state": "published",
        "total": 3,
        "next_cursor": next_cursor,
        "questions": questions,
    }


def test_iter_questions_follows_the_cursor() -> None:
    first, second = PAGE_DE_QUESTIONS["questions"][:1], PAGE_DE_QUESTIONS["questions"][1:]
    recorder = _paginated([_page(first, "cursor-2"), _page(second, None)])
    with sync_client(recorder) as client:
        questions = list(client.iter_questions(limit=1))

    assert [question.id for question in questions] == ["q_style", "q_budget"]
    assert len(recorder.requests) == 2
    assert dict(recorder.requests[0].url.params) == {"limit": "1"}
    assert dict(recorder.requests[1].url.params) == {"limit": "1", "cursor": "cursor-2"}


def test_iter_questions_stops_on_an_empty_last_page() -> None:
    recorder = _paginated([_page(PAGE_DE_QUESTIONS["questions"], None)])
    with sync_client(recorder) as client:
        assert len(list(client.iter_questions())) == 2
    assert len(recorder.requests) == 1


async def test_async_iter_questions_follows_the_cursor() -> None:
    first, second = PAGE_DE_QUESTIONS["questions"][:1], PAGE_DE_QUESTIONS["questions"][1:]
    recorder = _paginated([_page(first, "cursor-2"), _page(second, None)])
    async with async_client(recorder) as client:
        questions = [question async for question in client.iter_questions(limit=1)]

    assert [question.id for question in questions] == ["q_style", "q_budget"]
    assert len(recorder.requests) == 2


# ------------------------------------------------------- export_questions_csv


def test_export_questions_csv_asks_for_text_csv() -> None:
    recorder = Recorder(csv_response(csv_export_example()))
    with sync_client(recorder) as client:
        export = client.export_questions_csv(sub_objective_id="so_besoin")

    assert recorder.last.headers["Accept"] == "text/csv"
    assert dict(recorder.last.url.params) == {
        "sub_objective_id": "so_besoin",
        "format": "csv",
    }
    assert export.splitlines()[0] == "id,text,type,choices,sub_objective_id,active"


async def test_async_export_questions_csv() -> None:
    recorder = Recorder(csv_response(csv_export_example()))
    async with async_client(recorder) as client:
        export = await client.export_questions_csv()
    assert recorder.last.headers["Accept"] == "text/csv"
    assert "q_budget" in export


# ---------------------------------------------------------------- list_audit


def test_list_audit_parses_the_page() -> None:
    recorder = Recorder(json_response(200, AUDIT_PAGE))
    with sync_client(recorder) as client:
        page = client.list_audit(limit=50, action="configuration.question.deactivated")

    assert recorder.last.url.path == "/v1/configuration/audit"
    assert dict(recorder.last.url.params) == {
        "limit": "50",
        "action": "configuration.question.deactivated",
    }
    assert page.next_cursor is None
    event = page.events[0]
    assert event.actor.type == "cognito_user"
    assert event.resource.id == "q_style"
    assert event.diff.before == {"active": True}
    assert event.details["draft_revision"] == 43


def test_list_audit_serialises_the_resource_type() -> None:
    recorder = Recorder(json_response(200, AUDIT_PAGE))
    with sync_client(recorder) as client:
        client.list_audit(resource_type="question", cursor="c1")
    assert dict(recorder.last.url.params) == {"resource_type": "question", "cursor": "c1"}


async def test_async_list_audit() -> None:
    recorder = Recorder(json_response(200, AUDIT_PAGE))
    async with async_client(recorder) as client:
        page = await client.list_audit()
    assert page.request_id == "req_8aa1"


# -------------------------------------------------------------- apply_changes


def test_apply_changes_sends_typed_models() -> None:
    recorder = Recorder(json_response(200, CHANGES_APPLIED))
    with sync_client(recorder) as client:
        response = client.apply_changes(
            [
                QuestionChange(
                    operation="create",
                    question=QuestionPatch(
                        id="sdk_q_delai",
                        text="Quand souhaitez-vous être livré ?",
                        type="single_choice",
                        sub_objective_id="sdk_so_delai",
                        active=True,
                        choices=[{"id": "sdk_c_1m", "label": "Dans le mois"}],
                    ),
                ),
                SuccessInformationChange(
                    operation="create",
                    success_information=SuccessInformationPatch(
                        id="sdk_delai",
                        label="Délai de livraison",
                        primary_question_id="sdk_q_delai",
                        json_schema={"type": "string"},
                    ),
                ),
            ],
            expected_draft_revision=41,
            idempotency_key="changes-rev-41",
        )

    assert recorder.last.url.path == "/v1/configuration/changes"
    assert recorder.last.headers["Idempotency-Key"] == "changes-rev-41"
    assert recorder.body() == {
        "expected_draft_revision": 41,
        "changes": [
            {
                "entity": "question",
                "operation": "create",
                "question": {
                    "id": "sdk_q_delai",
                    "text": "Quand souhaitez-vous être livré ?",
                    "type": "single_choice",
                    "sub_objective_id": "sdk_so_delai",
                    "active": True,
                    "choices": [{"id": "sdk_c_1m", "label": "Dans le mois"}],
                },
            },
            {
                "entity": "success_information",
                "operation": "create",
                "success_information": {
                    "id": "sdk_delai",
                    "label": "Délai de livraison",
                    "primary_question_id": "sdk_q_delai",
                    "schema": {"type": "string"},
                },
            },
        ],
    }
    assert response.draft_revision == 42
    assert response.applied == 2
    assert response.warnings == []


def test_apply_changes_accepts_plain_mappings() -> None:
    recorder = Recorder(json_response(200, CHANGES_APPLIED))
    with sync_client(recorder) as client:
        client.apply_changes(
            [{"entity": "objective", "operation": "update", "objective": {"max_turns": 8}}]
        )
    assert recorder.body()["changes"][0]["objective"] == {"max_turns": 8}
    assert "expected_draft_revision" not in recorder.body()


def test_apply_changes_rejects_an_invalid_batch_before_sending() -> None:
    recorder = Recorder(json_response(200, CHANGES_APPLIED))
    with sync_client(recorder) as client:
        with pytest.raises(ValueError, match="changes"):
            client.apply_changes([])
        with pytest.raises(ValueError, match="entity"):
            client.apply_changes([{"operation": "update", "objective": {"max_turns": 8}}])
        with pytest.raises(ValueError, match="at least one field"):
            client.apply_changes([ObjectiveChange(objective=ObjectivePatch())])
    assert recorder.requests == []


async def test_async_apply_changes() -> None:
    recorder = Recorder(json_response(200, CHANGES_APPLIED))
    async with async_client(recorder) as client:
        response = await client.apply_changes(
            [{"entity": "question", "operation": "delete", "question": {"id": "q_old"}}]
        )
    assert response.request_id == "req_71aa"


# -------------------------------------------------------------------- publish


def test_publish_locks_the_draft_revision() -> None:
    recorder = Recorder(json_response(202, PUBLISH_QUEUED))
    with sync_client(recorder) as client:
        status = client.publish(expected_draft_revision=42, idempotency_key="publish-rev-42")

    assert recorder.last.url.path == "/v1/configuration/publish"
    assert recorder.last.headers["Idempotency-Key"] == "publish-rev-42"
    assert recorder.body() == {"expected_draft_revision": 42}
    assert status.compilation_id == "cmp_01K2QF"
    assert status.status == "queued"
    assert status.error is None
    assert status.configuration_version is None


def test_publish_sends_an_empty_body_by_default() -> None:
    recorder = Recorder(json_response(202, PUBLISH_QUEUED))
    with sync_client(recorder) as client:
        client.publish()
    assert recorder.body() == {}


async def test_async_publish() -> None:
    recorder = Recorder(json_response(202, PUBLISH_QUEUED))
    async with async_client(recorder) as client:
        status = await client.publish()
    assert status.draft_revision == 42


# ------------------------------------------------------------ get_compilation


def test_get_compilation_parses_a_failure() -> None:
    recorder = Recorder(json_response(200, COMPILATION_FAILED))
    with sync_client(recorder) as client:
        status = client.get_compilation("cmp_01K2QG")

    assert recorder.last.url.path == "/v1/configuration/compilations/cmp_01K2QG"
    assert status.status == "failed"
    assert status.error is not None
    assert status.error.code == "llm_unavailable"
    assert status.progress == pytest.approx(0.62)


def test_compilation_id_is_escaped_in_the_path() -> None:
    recorder = Recorder(json_response(200, COMPILATION_DONE))
    with sync_client(recorder) as client:
        client.get_compilation("cmp/../secret")
    assert recorder.last.url.raw_path == b"/v1/configuration/compilations/cmp%2F..%2Fsecret"


async def test_async_get_compilation() -> None:
    recorder = Recorder(json_response(200, COMPILATION_DONE))
    async with async_client(recorder) as client:
        status = await client.get_compilation("cmp_01K2QF")
    assert status.configuration_version == "cfg_00014"


# ------------------------------------------------------- wait_for_compilation


def test_wait_for_compilation_polls_until_success() -> None:
    recorder = Recorder(
        json_response(200, COMPILATION_RUNNING),
        json_response(200, COMPILATION_RUNNING),
        json_response(200, COMPILATION_DONE),
    )
    with sync_client(recorder) as client:
        status = client.wait_for_compilation("cmp_01K2QF", poll_interval=0, timeout=5)

    assert status.status == "succeeded"
    assert status.configuration_version == "cfg_00014"
    assert len(recorder.requests) == 3


def test_wait_for_compilation_returns_a_failure_without_raising() -> None:
    recorder = Recorder(json_response(200, COMPILATION_FAILED))
    with sync_client(recorder) as client:
        status = client.wait_for_compilation("cmp_01K2QG", poll_interval=0, timeout=5)

    assert status.status == "failed"
    assert status.error is not None
    assert status.error.message.startswith("Le service de compilation")


def test_wait_for_compilation_times_out() -> None:
    recorder = Recorder(json_response(200, COMPILATION_RUNNING))
    with sync_client(recorder) as client:
        with pytest.raises(NBQCompilationTimeoutError) as captured:
            client.wait_for_compilation("cmp_01K2QF", poll_interval=0.01, timeout=0.05)

    assert captured.value.compilation_id == "cmp_01K2QF"
    assert captured.value.timeout == 0.05
    assert recorder.requests


def test_wait_for_compilation_validates_its_arguments() -> None:
    recorder = Recorder(json_response(200, COMPILATION_DONE))
    with sync_client(recorder) as client:
        with pytest.raises(ValueError, match="poll_interval"):
            client.wait_for_compilation("cmp", poll_interval=-1)
        with pytest.raises(ValueError, match="timeout"):
            client.wait_for_compilation("cmp", timeout=0)


async def test_async_wait_for_compilation() -> None:
    recorder = Recorder(
        json_response(200, COMPILATION_RUNNING),
        json_response(200, COMPILATION_DONE),
    )
    async with async_client(recorder) as client:
        status = await client.wait_for_compilation("cmp_01K2QF", poll_interval=0, timeout=5)
    assert status.status == "succeeded"
    assert len(recorder.requests) == 2


async def test_async_wait_for_compilation_times_out() -> None:
    recorder = Recorder(json_response(200, COMPILATION_RUNNING))
    async with async_client(recorder) as client:
        with pytest.raises(NBQCompilationTimeoutError):
            await client.wait_for_compilation("cmp_01K2QF", poll_interval=0.01, timeout=0.05)
