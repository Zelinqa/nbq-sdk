"""Live recette of the Python SDK against the staging NBQ "SDK MCP V1 Recette".

Opt-in only: the whole module is skipped unless ``ZELINQA_LIVE=1``, and the ``live``
marker is excluded from the default ``pytest`` run. Nothing here prints a key,
a verbatim, or a payload — only request ids, error codes and counters.

Environment
-----------
``ZELINQA_LIVE``                    set to ``1`` to run this suite
``ZELINQA_LIVE_BASE_URL``           defaults to ``https://api.zelinqa.ai``
``ZELINQA_LIVE_RUNTIME_KEY``        scope ``runtime``
``ZELINQA_LIVE_CONFIG_READ_KEY``    scope ``configuration:read``
``ZELINQA_LIVE_CONFIG_WRITE_KEY``   scope ``configuration:write``
``ZELINQA_LIVE_CONFIG_PUBLISH_KEY`` scope ``configuration:publish``
``ZELINQA_LIVE_CONFIG_MANAGE_KEY``  read + write + publish, the Studio-style key
``ZELINQA_LIVE_REVOKED_KEY``        a key that was revoked on purpose

Re-runnable by design: the corpus is upserted (read the draft, create what is
missing, update what exists), so running the suite twice against the same NBQ
converges instead of failing.

The suite deliberately limits model calls and spaces turns to keep this
functional recipe inexpensive; this is not a throughput benchmark.
"""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from zelinqa import (
    SessionStateResponse,
    ZelinqaAuthenticationError,
    ZelinqaClient,
    ZelinqaCompilationInProgressError,
    ZelinqaConfigurationClient,
    ZelinqaIdempotencyKeyReusedError,
    ZelinqaInsufficientScopeError,
    ZelinqaStateVersionConflictError,
    ZelinqaUnknownConfigurationError,
    ZelinqaUnknownSessionError,
)

LIVE_ENABLED = os.environ.get("ZELINQA_LIVE") == "1"

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not LIVE_ENABLED, reason="live tests need ZELINQA_LIVE=1"),
]

DEFAULT_BASE_URL = "https://api.zelinqa.ai"
NEXT_CALL_PAUSE_SECONDS = 1.0
COMPILATION_TIMEOUT_SECONDS = 900.0
COMPILATION_POLL_SECONDS = 3.0

#: Idempotency records live 24 hours server-side: a fixed key would replay the
#: previous run against a new session. Every key of this run carries a nonce.
RUN_NONCE = uuid.uuid4().hex[:12]

# --------------------------------------------------------------- the corpus

OBJECTIVE = {
    "name": "SDK MCP V1 Recette",
    "description": "NBQ jetable pour la recette des SDK et du serveur MCP.",
    "qualification_level": "balanced",
    "max_turns": 8,
    "candidates_per_call": 2,
    "order_strength": 0.35,
}

SUB_OBJECTIVES = [
    {"id": "sdk_so_besoin", "name": "Besoin", "order_position": 0, "completion_role": "blocking"},
    {"id": "sdk_so_budget", "name": "Budget", "order_position": 1, "completion_role": "blocking"},
    {
        "id": "sdk_so_delai",
        "name": "Délai",
        "order_position": 2,
        "completion_role": "contributing",
    },
]

QUESTIONS = [
    {
        "id": "sdk_q_usage",
        "text": "Pour quel usage cherchez-vous ce canapé ?",
        "type": "open",
        "sub_objective_id": "sdk_so_besoin",
        "active": True,
        "choices": [],
    },
    {
        "id": "sdk_q_style",
        "text": "Quel style préférez-vous ?",
        "type": "single_choice",
        "sub_objective_id": "sdk_so_besoin",
        "active": True,
        "choices": [
            {"id": "sdk_c_contemporain", "label": "Contemporain", "maps_to_value": "contemporain"},
            {"id": "sdk_c_scandinave", "label": "Scandinave", "maps_to_value": "scandinave"},
            {"id": "sdk_c_classique", "label": "Classique", "maps_to_value": "classique"},
        ],
    },
    {
        "id": "sdk_q_budget",
        "text": "Quel budget envisagez-vous ?",
        "type": "open",
        "sub_objective_id": "sdk_so_budget",
        "active": True,
        "choices": [],
    },
    {
        "id": "sdk_q_delai",
        "text": "Quand souhaitez-vous être livré ?",
        "type": "single_choice",
        "sub_objective_id": "sdk_so_delai",
        "active": True,
        "choices": [
            {"id": "sdk_c_1m", "label": "Dans le mois", "maps_to_value": "dans_le_mois"},
            {"id": "sdk_c_3m", "label": "Dans les trois mois", "maps_to_value": "trois_mois"},
            {"id": "sdk_c_later", "label": "Plus tard", "maps_to_value": "plus_tard"},
        ],
    },
    {
        "id": "sdk_q_animaux",
        "text": "Avez-vous des animaux ?",
        "type": "single_choice",
        "sub_objective_id": "sdk_so_besoin",
        "active": True,
        "choices": [
            {"id": "sdk_c_oui", "label": "Oui", "maps_to_value": True},
            {"id": "sdk_c_non", "label": "Non", "maps_to_value": False},
        ],
    },
]

SUCCESS_INFORMATIONS = [
    {
        "id": "sdk_style",
        "label": "Style souhaité",
        "primary_question_id": "sdk_q_style",
        "schema": {"type": "string", "enum": ["contemporain", "scandinave", "classique"]},
    },
    {
        "id": "sdk_budget",
        "label": "Budget",
        "primary_question_id": "sdk_q_budget",
        "schema": {"type": "number", "minimum": 0},
    },
    {
        "id": "sdk_delai",
        "label": "Délai de livraison",
        "primary_question_id": "sdk_q_delai",
        "schema": {"type": "string", "enum": ["dans_le_mois", "trois_mois", "plus_tard"]},
    },
    {
        "id": "sdk_animaux",
        "label": "Présence d'animaux",
        "primary_question_id": "sdk_q_animaux",
        "schema": {"type": "boolean"},
    },
]

QUESTION_IDS = {question["id"] for question in QUESTIONS}


# ------------------------------------------------------------------ plumbing


def _key(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.skip(f"{name} is not set")
    return value


def _base_url() -> str:
    return os.environ.get("ZELINQA_LIVE_BASE_URL") or DEFAULT_BASE_URL


@dataclass
class LiveState:
    """Values one scenario hands to the next. Never a key, never a verbatim."""

    draft_revision: int | None = None
    compilation_id: str | None = None
    session: SessionStateResponse | None = None
    state_version: int = 0
    first_decision_id: str | None = None
    first_request_id: str | None = None
    first_turn_count: int = 0
    request_ids: list[str] = field(default_factory=list)

    def note(self, label: str, request_id: str) -> None:
        self.request_ids.append(request_id)
        print(f"  {label}: request_id={request_id}")


@pytest.fixture(scope="module")
def state() -> LiveState:
    return LiveState()


@pytest.fixture(scope="module")
def manage() -> Iterator[ZelinqaConfigurationClient]:
    with ZelinqaConfigurationClient(
        _key("ZELINQA_LIVE_CONFIG_MANAGE_KEY"), base_url=_base_url()
    ) as c:
        yield c


@pytest.fixture(scope="module")
def reader() -> Iterator[ZelinqaConfigurationClient]:
    with ZelinqaConfigurationClient(
        _key("ZELINQA_LIVE_CONFIG_READ_KEY"), base_url=_base_url()
    ) as c:
        yield c


@pytest.fixture(scope="module")
def writer() -> Iterator[ZelinqaConfigurationClient]:
    with ZelinqaConfigurationClient(
        _key("ZELINQA_LIVE_CONFIG_WRITE_KEY"), base_url=_base_url()
    ) as c:
        yield c


@pytest.fixture(scope="module")
def publisher() -> Iterator[ZelinqaConfigurationClient]:
    with ZelinqaConfigurationClient(
        _key("ZELINQA_LIVE_CONFIG_PUBLISH_KEY"), base_url=_base_url()
    ) as c:
        yield c


@pytest.fixture(scope="module")
def runtime() -> Iterator[ZelinqaClient]:
    with ZelinqaClient(_key("ZELINQA_LIVE_RUNTIME_KEY"), base_url=_base_url()) as c:
        yield c


def _read_draft_or_published(client: ZelinqaConfigurationClient) -> Any:
    """Return the draft if there is one, else the published configuration."""

    try:
        return client.get_configuration(state="draft")
    except ZelinqaUnknownConfigurationError:
        print("  no draft yet, falling back on the published configuration")
    try:
        return client.get_configuration()
    except ZelinqaUnknownConfigurationError:
        print("  nothing published yet either: the corpus will be created")
        return None


def _upsert_changes(existing: Any) -> list[dict[str, Any]]:
    """Build the ordered batch that makes the live NBQ match the corpus.

    Order matters: sub-objectives first, then questions, then the success
    informations that point at them.
    """

    known_sub_objectives = {item.id for item in existing.sub_objectives} if existing else set()
    known_questions = {item.id for item in existing.questions} if existing else set()
    known_informations = {item.id for item in existing.success_informations} if existing else set()

    changes: list[dict[str, Any]] = [
        {"entity": "objective", "operation": "update", "objective": OBJECTIVE}
    ]
    for sub_objective in SUB_OBJECTIVES:
        changes.append(
            {
                "entity": "sub_objective",
                "operation": "update" if sub_objective["id"] in known_sub_objectives else "create",
                "sub_objective": sub_objective,
            }
        )
    for question in QUESTIONS:
        changes.append(
            {
                "entity": "question",
                "operation": "update" if question["id"] in known_questions else "create",
                "question": question,
            }
        )
    for information in SUCCESS_INFORMATIONS:
        changes.append(
            {
                "entity": "success_information",
                "operation": "update" if information["id"] in known_informations else "create",
                "success_information": information,
            }
        )
    return changes


# ------------------------------------- 1. upsert the corpus with the manage key


def test_01_upsert_corpus_with_the_manage_key(
    manage: ZelinqaConfigurationClient, state: LiveState
) -> None:
    existing = _read_draft_or_published(manage)
    changes = _upsert_changes(existing)
    expected = existing.draft_revision if existing is not None else None

    response = manage.apply_changes(changes, expected_draft_revision=expected)
    state.note("apply_changes", response.request_id)
    print(f"  applied={response.applied} draft_revision={response.draft_revision}")
    assert response.applied == len(changes)
    assert [issue.code for issue in response.warnings] == []

    state.draft_revision = response.draft_revision


def test_02_manage_key_reads_the_draft(
    manage: ZelinqaConfigurationClient, state: LiveState
) -> None:
    draft = manage.get_configuration(state="draft")
    state.note("get_configuration(draft)", draft.request_id)

    assert draft.state == "draft"
    assert draft.draft_revision == state.draft_revision
    assert draft.objective.max_turns == OBJECTIVE["max_turns"]
    assert {item.id for item in draft.sub_objectives} >= {s["id"] for s in SUB_OBJECTIVES}
    assert {item.id for item in draft.questions} >= QUESTION_IDS
    assert {item.id for item in draft.success_informations} >= {
        s["id"] for s in SUCCESS_INFORMATIONS
    }


def test_03_manage_key_lists_draft_questions(manage: ZelinqaConfigurationClient) -> None:
    page = manage.list_questions(state="draft", limit=200)
    print(f"  request_id={page.request_id} questions={len(page.questions)}")
    assert {question.id for question in page.questions} >= QUESTION_IDS


# ------------------------------------------------------- 2. scope enforcement


def test_04_read_key_on_the_draft_is_an_insufficient_scope(
    reader: ZelinqaConfigurationClient,
) -> None:
    """The service checks ?state=draft dynamically, so the envelope is a V1 one."""

    with pytest.raises(ZelinqaInsufficientScopeError) as captured:
        reader.get_configuration(state="draft")

    error = captured.value
    print(f"  code={error.code} status={error.status_code} request_id={error.request_id}")
    assert error.status_code == 403
    assert error.code == "insufficient_scope"
    assert "configuration:write" in error.required_scopes


def test_05_write_only_key_cannot_read_the_draft(writer: ZelinqaConfigurationClient) -> None:
    """The authorizer wants configuration:read on this route; a write-only key is
    refused before the service sees the query string."""

    with pytest.raises(ZelinqaAuthenticationError) as captured:
        writer.get_configuration(state="draft")
    print(f"  status={captured.value.status_code} code={captured.value.code}")
    assert captured.value.status_code == 403
    assert captured.value.code is None


def test_06_read_key_cannot_read_the_audit_log(reader: ZelinqaConfigurationClient) -> None:
    with pytest.raises(ZelinqaAuthenticationError) as captured:
        reader.list_audit()
    print(f"  status={captured.value.status_code} code={captured.value.code}")
    assert captured.value.status_code == 403


def test_07_runtime_key_cannot_read_the_configuration() -> None:
    with ZelinqaConfigurationClient(
        _key("ZELINQA_LIVE_RUNTIME_KEY"), base_url=_base_url()
    ) as client:
        with pytest.raises(ZelinqaAuthenticationError) as captured:
            client.get_configuration()
    print(f"  status={captured.value.status_code} code={captured.value.code}")
    assert captured.value.status_code == 403


def test_08_write_key_cannot_publish(writer: ZelinqaConfigurationClient) -> None:
    with pytest.raises(ZelinqaAuthenticationError) as captured:
        writer.publish()
    print(f"  status={captured.value.status_code} code={captured.value.code}")
    assert captured.value.status_code == 403


# ------------------------------------------- 3. the write-only key can write


def test_09_write_only_key_applies_a_change(
    writer: ZelinqaConfigurationClient, manage: ZelinqaConfigurationClient, state: LiveState
) -> None:
    response = writer.apply_changes(
        [{"entity": "objective", "operation": "update", "objective": OBJECTIVE}],
        expected_draft_revision=state.draft_revision,
    )
    state.note("apply_changes(write-only key)", response.request_id)
    assert response.applied == 1
    assert response.draft_revision >= (state.draft_revision or 0)
    state.draft_revision = response.draft_revision

    # The write-only key cannot read back what it wrote; the manage key can.
    draft = manage.get_configuration(state="draft")
    assert draft.draft_revision == state.draft_revision


# --------------------------------------------------------------- 4. publish


def test_10_publish_queues_a_compilation(
    publisher: ZelinqaConfigurationClient, state: LiveState
) -> None:
    status = publisher.publish(expected_draft_revision=state.draft_revision)
    state.note("publish", status.request_id)
    print(f"  compilation_id={status.compilation_id} status={status.status}")

    assert status.status in ("queued", "running")
    assert status.draft_revision == state.draft_revision
    assert status.configuration_version is None
    state.compilation_id = status.compilation_id


def test_11_a_second_publish_conflicts(
    publisher: ZelinqaConfigurationClient, state: LiveState
) -> None:
    """Tolerant on purpose: a very small corpus can finish before this runs."""

    try:
        status = publisher.publish()
    except ZelinqaCompilationInProgressError as error:
        print(f"  code={error.code} compilation_id={error.compilation_id} status={error.status}")
        assert error.status_code == 409
        assert error.compilation_id == state.compilation_id
    else:
        print(f"  first compilation already finished, second job {status.compilation_id}")
        state.compilation_id = status.compilation_id


def test_12_wait_for_the_compilation_to_succeed(
    manage: ZelinqaConfigurationClient, state: LiveState
) -> None:
    assert state.compilation_id is not None
    status = manage.wait_for_compilation(
        state.compilation_id,
        poll_interval=COMPILATION_POLL_SECONDS,
        timeout=COMPILATION_TIMEOUT_SECONDS,
    )
    state.note("wait_for_compilation", status.request_id)
    codes = None if status.error is None else status.error.code
    print(f"  status={status.status} error_code={codes} version={status.configuration_version}")

    assert status.status == "succeeded", f"compilation failed with {codes}"
    assert status.configuration_version is not None
    assert status.progress == 1


def test_13_publish_key_reads_the_audit_log(
    publisher: ZelinqaConfigurationClient, state: LiveState
) -> None:
    page = publisher.list_audit(limit=10)
    state.note("list_audit", page.request_id)
    print(f"  events={len(page.events)} actions={sorted({e.action for e in page.events})}")
    assert page.events


# -------------------------------------- 5. read the published configuration


def test_14_read_key_sees_the_published_corpus(
    reader: ZelinqaConfigurationClient, state: LiveState
) -> None:
    configuration = reader.get_configuration()
    state.note("get_configuration(published)", configuration.request_id)

    assert configuration.state == "published"
    assert configuration.configuration_version is not None
    assert configuration.objective.name == OBJECTIVE["name"]
    assert configuration.objective.candidates_per_call == OBJECTIVE["candidates_per_call"]
    assert {item.id for item in configuration.questions} >= QUESTION_IDS
    assert {item.id for item in configuration.success_informations} >= {
        s["id"] for s in SUCCESS_INFORMATIONS
    }


def test_15_questions_paginate_by_cursor(reader: ZelinqaConfigurationClient) -> None:
    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    total: int | None = None

    while True:
        page = reader.list_questions(limit=2, cursor=cursor)
        pages += 1
        total = page.total if total is None else total
        seen.extend(question.id for question in page.questions)
        cursor = page.next_cursor
        if cursor is None:
            break
        assert pages < 50, "the cursor never returned null"

    print(f"  pages={pages} questions={len(seen)} total={total}")
    assert len(seen) == len(set(seen)), "a question appeared on two pages"
    assert set(seen) >= QUESTION_IDS
    if total is not None:
        assert total == len(seen)


def test_16_iter_questions_walks_the_whole_corpus(reader: ZelinqaConfigurationClient) -> None:
    ids = [question.id for question in reader.iter_questions(limit=2)]
    assert set(ids) >= QUESTION_IDS
    assert len(ids) == len(set(ids))


def test_17_question_filters_narrow_the_corpus(reader: ZelinqaConfigurationClient) -> None:
    by_sub_objective = reader.list_questions(sub_objective_id="sdk_so_besoin", limit=200)
    assert {q.id for q in by_sub_objective.questions} >= {
        "sdk_q_usage",
        "sdk_q_style",
        "sdk_q_animaux",
    }
    assert all(q.sub_objective_id == "sdk_so_besoin" for q in by_sub_objective.questions)

    by_type = reader.list_questions(type="open", limit=200)
    assert all(question.type == "open" for question in by_type.questions)
    assert {"sdk_q_usage", "sdk_q_budget"} <= {q.id for q in by_type.questions}

    by_search = reader.list_questions(search="budget", limit=200)
    assert "sdk_q_budget" in {question.id for question in by_search.questions}

    active_only = reader.list_questions(active=True, limit=200)
    assert all(question.active for question in active_only.questions)
    print(
        f"  sub_objective={len(by_sub_objective.questions)} open={len(by_type.questions)} "
        f"search={len(by_search.questions)} active={len(active_only.questions)}"
    )


def test_18_csv_export_has_the_documented_header(reader: ZelinqaConfigurationClient) -> None:
    export = reader.export_questions_csv()
    lines = export.splitlines()
    print(f"  csv_lines={len(lines)}")
    assert lines[0] == "id,text,type,selection_mode,choices,source,sub_objective_id,active"
    assert any(line.startswith("sdk_q_budget,") for line in lines[1:])


def test_19_read_key_reads_the_compilation(
    reader: ZelinqaConfigurationClient, state: LiveState
) -> None:
    assert state.compilation_id is not None
    status = reader.get_compilation(state.compilation_id)
    state.note("get_compilation", status.request_id)
    assert status.status == "succeeded"


# ------------------------------------------------------------- 6. the runtime


def test_20_create_a_session(runtime: ZelinqaClient, state: LiveState) -> None:
    session = runtime.create_session(client_reference="sdk-python-recette")
    state.note("create_session", session.request_id)
    print(f"  status={session.status} state_version={session.versions.state_version}")

    assert session.status == "active"
    assert session.versions.state_version == 0
    assert session.versions.api_version == "1.0"
    assert session.client_reference == "sdk-python-recette"
    assert session.pending_decision is None
    assert session.turn_count == 0

    state.session = session
    state.state_version = session.versions.state_version


def test_21_first_turn_proposes_questions(runtime: ZelinqaClient, state: LiveState) -> None:
    assert state.session is not None
    decision = runtime.next(
        state.session.session_id,
        state_version=state.state_version,
        idempotency_key=f"sdk-python-recette-{RUN_NONCE}-turn-1",
    )
    state.note("next(turn 1)", decision.request_id)
    print(
        f"  action={decision.action} candidates={len(decision.candidates)} "
        f"warnings={sorted(decision.warnings)} degraded={decision.degraded}"
    )

    assert decision.action == "ask"
    assert decision.decision_id is not None
    assert decision.candidates
    assert decision.candidates[0].rank == 1
    assert all(candidate.question_id in QUESTION_IDS for candidate in decision.candidates)
    assert len(decision.candidates) <= int(OBJECTIVE["candidates_per_call"])

    state.first_decision_id = decision.decision_id
    state.first_request_id = decision.request_id
    state.first_turn_count = decision.turn_count
    state.state_version = decision.versions.state_version
    time.sleep(NEXT_CALL_PAUSE_SECONDS)


def test_22_replaying_the_same_call_replays_the_answer(
    runtime: ZelinqaClient, state: LiveState
) -> None:
    """Same key and same body: the original response, without a second effect."""

    assert state.session is not None
    replay = runtime.next(
        state.session.session_id,
        state_version=0,
        idempotency_key=f"sdk-python-recette-{RUN_NONCE}-turn-1",
    )
    # A replay returns the ORIGINAL response verbatim, request_id included: it is
    # not a new request, so it is not recorded as one.
    print(f"  next(replay): request_id={replay.request_id} (same as turn 1)")

    assert replay.request_id == state.first_request_id
    assert replay.decision_id == state.first_decision_id
    assert replay.turn_count == state.first_turn_count
    assert replay.versions.state_version == state.state_version


def test_23_the_same_key_with_another_body_is_refused(
    runtime: ZelinqaClient, state: LiveState
) -> None:
    assert state.session is not None
    with pytest.raises(ZelinqaIdempotencyKeyReusedError) as captured:
        runtime.next(
            state.session.session_id,
            state_version=state.state_version,
            previous_turn={"user_text": "Un autre corps pour la même clé."},
            idempotency_key=f"sdk-python-recette-{RUN_NONCE}-turn-1",
        )
    print(f"  code={captured.value.code} status={captured.value.status_code}")
    assert captured.value.status_code == 409


def test_24_a_stale_state_version_conflicts(runtime: ZelinqaClient, state: LiveState) -> None:
    assert state.session is not None
    with pytest.raises(ZelinqaStateVersionConflictError) as captured:
        runtime.next(state.session.session_id, state_version=0)

    error = captured.value
    print(
        f"  code={error.code} supplied={error.supplied_state_version} "
        f"current={error.current_state_version}"
    )
    assert error.status_code == 409
    assert error.supplied_state_version == 0
    assert error.current_state_version == state.state_version


def test_25_second_turn_understands_a_free_answer(runtime: ZelinqaClient, state: LiveState) -> None:
    assert state.session is not None
    session = runtime.resume_session(state.session.session_id)
    assert session.pending_decision is not None
    asked = session.pending_decision.candidates[0]

    decision = session.next(
        previous_turn={
            "assistant_text": asked.text,
            "user_text": "Un canapé contemporain pour le salon, nous avons un chat.",
        }
    )
    state.note("next(turn 2)", decision.request_id)
    print(
        f"  action={decision.action} turn_count={decision.turn_count} "
        f"degraded_reasons={sorted(decision.degraded_reasons)}"
    )

    assert decision.turn_count > state.first_turn_count
    assert decision.versions.state_version > state.state_version
    state.state_version = decision.versions.state_version
    time.sleep(NEXT_CALL_PAUSE_SECONDS)


def test_26_third_turn_answers_a_structured_question(
    runtime: ZelinqaClient, state: LiveState
) -> None:
    """Answer with choice ids when a choice question is on the table.

    Falls back to free text otherwise: the engine ranks, the test does not get
    to dictate which question comes up.
    """

    assert state.session is not None
    session = runtime.resume_session(state.session.session_id)
    assert session.pending_decision is not None
    candidate = next(
        (c for c in session.pending_decision.candidates if c.choices),
        session.pending_decision.candidates[0],
    )

    previous_turn: dict[str, Any] = {"assistant_text": candidate.text}
    if candidate.choices:
        previous_turn["structured_answer"] = {"choice_ids": [candidate.choices[0].choice_id]}
        print(f"  structured answer on {candidate.question_id}")
    else:
        previous_turn["user_text"] = "Plutôt autour de 2 500 euros, livré dans le mois."
        print(f"  free answer on {candidate.question_id}")

    decision = session.next(previous_turn=previous_turn)
    state.note("next(turn 3)", decision.request_id)
    print(f"  action={decision.action} objective={decision.progress.objective.effective_status}")

    assert decision.versions.state_version > state.state_version
    state.state_version = decision.versions.state_version
    time.sleep(NEXT_CALL_PAUSE_SECONDS)


def test_27_client_updates_confirm_a_success_information(
    runtime: ZelinqaClient, state: LiveState
) -> None:
    assert state.session is not None
    updated = runtime.apply_events(
        state.session.session_id,
        state_version=state.state_version,
        client_updates={"data": [{"id": "sdk_budget", "value": 2500}]},
    )
    state.note("apply_events(data)", updated.request_id)

    target = updated.targets.get("sdk_budget")
    print(f"  sdk_budget status={None if target is None else target.status}")
    assert target is not None, "a client set must appear in the public state"
    assert target.kind == "data"
    assert target.status == "confirmed"
    assert target.value == 2500
    assert target.coverage == 1

    state.state_version = updated.versions.state_version


def test_28_a_context_summary_is_accepted(runtime: ZelinqaClient, state: LiveState) -> None:
    assert state.session is not None
    updated = runtime.apply_events(
        state.session.session_id,
        state_version=state.state_version,
        context_update={
            "mode": "summary",
            "text": "Le visiteur emménage en mars et mesure la pièce ce week-end.",
        },
    )
    state.note("apply_events(summary)", updated.request_id)
    assert updated.versions.state_version >= state.state_version
    state.state_version = updated.versions.state_version


def test_29_get_session_returns_a_resumable_state(runtime: ZelinqaClient, state: LiveState) -> None:
    assert state.session is not None
    session = runtime.get_session(state.session.session_id)
    state.note("get_session", session.request_id)
    print(
        f"  state_version={session.versions.state_version} "
        f"outcomes={len(session.question_state.outcomes)} targets={len(session.targets)}"
    )

    assert session.versions.state_version == state.state_version
    assert session.session_id == state.session.session_id
    assert session.question_state.outcomes
    if session.pending_decision is not None:
        assert session.pending_decision.candidates
        assert all(c.question_id in QUESTION_IDS for c in session.pending_decision.candidates)


def test_30_feedback_is_recorded_once(runtime: ZelinqaClient, state: LiveState) -> None:
    assert state.session is not None
    first = runtime.submit_feedback(
        state.session.session_id,
        result="success",
        label="achat",
        metadata={"order_id": "SDK-1"},
        idempotency_key=f"sdk-python-recette-{RUN_NONCE}-feedback",
    )
    state.note("submit_feedback", first.request_id)

    replay = runtime.submit_feedback(
        state.session.session_id,
        result="success",
        label="achat",
        metadata={"order_id": "SDK-1"},
        idempotency_key=f"sdk-python-recette-{RUN_NONCE}-feedback",
    )
    print(f"  feedback replayed identically: {first.feedback_id == replay.feedback_id}")
    assert replay.feedback_id == first.feedback_id


def test_31_an_unknown_session_is_a_404_envelope(runtime: ZelinqaClient) -> None:
    with pytest.raises(ZelinqaUnknownSessionError) as captured:
        runtime.get_session("ses_does_not_exist")

    error = captured.value
    print(f"  code={error.code} status={error.status_code} request_id={error.request_id}")
    assert error.status_code == 404
    assert error.code == "unknown_session"


# ------------------------------------------------------------------ 7. auth


def test_32_an_invalid_key_is_refused_by_the_gateway() -> None:
    with ZelinqaClient("nbq_live_invalid", base_url=_base_url()) as client:
        with pytest.raises(ZelinqaAuthenticationError) as captured:
            client.get_session("ses_does_not_exist")
    print(f"  status={captured.value.status_code} code={captured.value.code}")
    assert captured.value.status_code == 403
    assert captured.value.code is None


def test_33_a_revoked_key_is_refused_by_the_gateway() -> None:
    with ZelinqaClient(_key("ZELINQA_LIVE_REVOKED_KEY"), base_url=_base_url()) as client:
        with pytest.raises(ZelinqaAuthenticationError) as captured:
            client.get_session("ses_does_not_exist")
    print(f"  status={captured.value.status_code} code={captured.value.code}")
    assert captured.value.status_code == 403


def test_34_no_authorization_header_is_a_401() -> None:
    """Raw call: the SDK always sends the header, so httpx is used directly."""

    response = httpx.get(f"{_base_url()}/v1/sessions/ses_does_not_exist", timeout=30.0)
    print(f"  status={response.status_code}")
    assert response.status_code == 401


def test_35_the_health_probe_needs_no_key() -> None:
    response = httpx.get(f"{_base_url()}/v1/health", timeout=30.0)
    print(f"  status={response.status_code} body_keys={sorted(response.json())}")
    assert response.status_code == 200


def test_36_every_scenario_reported_a_request_id(state: LiveState) -> None:
    """Sanity check on the trail this suite leaves behind for support."""

    if not state.request_ids:
        pytest.skip("no scenario ran, nothing to correlate")
    print(f"  request ids recorded: {len(state.request_ids)}")
    assert all(request_id for request_id in state.request_ids)
    assert len(state.request_ids) == len(set(state.request_ids)), "a request id was reused"


def test_37_managed_session_answers_without_manual_ids(runtime: ZelinqaClient) -> None:
    session = runtime.start_session(client_reference="sdk-python-managed-recipe")
    first = session.next()
    candidate = first.candidates[0]
    if candidate.choices:
        answer = session.answer(choice_labels=[candidate.choices[0].label])
    else:
        answer = session.answer("Pour aménager mon salon avec un canapé confortable.")
    assert answer.turn_count > first.turn_count
    resumed = runtime.resume_session(session.id)
    assert resumed.state_version == session.state_version
    feedback = resumed.submit_feedback(result="success", label="sdk-python-managed-recipe")
    assert feedback.feedback_id


async def test_38_async_managed_session_answers_without_manual_ids() -> None:
    from zelinqa import AsyncZelinqaClient

    async with AsyncZelinqaClient(_key("ZELINQA_LIVE_RUNTIME_KEY"), base_url=_base_url()) as client:
        session = await client.start_session(client_reference="sdk-async-managed-recipe")
        first = await session.next()
        candidate = first.candidates[0]
        if candidate.choices:
            answer = await session.answer(choice_labels=[candidate.choices[0].label])
        else:
            answer = await session.answer("Pour aménager mon salon avec un canapé confortable.")
        assert answer.turn_count > first.turn_count
        resumed = await client.resume_session(session.id)
        assert resumed.state_version == session.state_version
        assert (
            await resumed.submit_feedback(result="success", label="sdk-async-managed-recipe")
        ).feedback_id
