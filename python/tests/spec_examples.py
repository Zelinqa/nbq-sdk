"""Shared access to the examples of the frozen OpenAPI snapshot.

The client tests answer with the payloads the contract documents rather than
with hand-written fixtures: a response shape can only drift if the contract
drifts.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = REPO_ROOT / "openapi" / "nbq-v1.openapi.yaml"

_SPEC: dict[str, Any] = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
_SHARED: dict[str, Any] = _SPEC["components"]["examples"]


def shared_example(name: str) -> dict[str, Any]:
    """Return a deep copy of ``components/examples/<name>``."""

    value = _SHARED[name]["value"]
    assert isinstance(value, dict)
    return copy.deepcopy(value)


def operation_example(path: str, method: str, status: str, label: str | None = None) -> Any:
    """Return a response example documented on one operation."""

    body = _SPEC["paths"][path][method]["responses"][status]["content"]["application/json"]
    if label is None:
        return copy.deepcopy(body["example"])
    return copy.deepcopy(body["examples"][label]["value"])


def response_example(name: str, label: str | None = None) -> dict[str, Any]:
    """Return an example of a shared ``components/responses`` entry."""

    body = _SPEC["components"]["responses"][name]["content"]["application/json"]
    value = body["example"] if label is None else body["examples"][label]["value"]
    assert isinstance(value, dict)
    return copy.deepcopy(value)


def csv_export_example() -> str:
    """Return the documented ``text/csv`` export body."""

    body = _SPEC["paths"]["/v1/configuration/questions"]["get"]["responses"]["200"]["content"]
    value = body["text/csv"]["example"]
    assert isinstance(value, str)
    return value


SESSION_NEUVE = shared_example("SessionNeuve")
DECISION_NORMALE = shared_example("DecisionNormale")
DECISION_APRES_MAX_TURNS = shared_example("DecisionApresMaxTurns")
ARRET_SANS_QUESTION = shared_example("ArretSansQuestion")
CONFIGURATION_PUBLIEE = shared_example("ConfigurationPubliee")
PAGE_DE_QUESTIONS = shared_example("PageDeQuestions")
