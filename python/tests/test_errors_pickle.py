"""SDK errors must survive pickling.

``multiprocessing``, ``concurrent.futures`` process pools and task queues move
exceptions between processes with pickle, which rebuilds an exception as
``cls(*args)``. Every error keeps its message, status, request id, details and
the attributes a subclass derives from ``details``.
"""

from __future__ import annotations

import concurrent.futures
import pickle
from typing import Any

import pytest
from zelinqa import (
    ZelinqaAPIError,
    ZelinqaAuthenticationError,
    ZelinqaCompilationInProgressError,
    ZelinqaCompilationTimeoutError,
    ZelinqaCompiledArtifactUnavailableError,
    ZelinqaConfigurationValidationError,
    ZelinqaConflictError,
    ZelinqaConnectionError,
    ZelinqaConstraintNoMatchError,
    ZelinqaError,
    ZelinqaIdempotencyContentionError,
    ZelinqaIdempotencyKeyReusedError,
    ZelinqaInsufficientScopeError,
    ZelinqaInvalidChoiceError,
    ZelinqaInvalidPreviousTurnError,
    ZelinqaNotFoundError,
    ZelinqaRateLimitError,
    ZelinqaServerError,
    ZelinqaStateVersionConflictError,
    ZelinqaUnknownCompilationError,
    ZelinqaUnknownConfigurationError,
    ZelinqaUnknownSessionError,
    ZelinqaValidationError,
)

DETAILS: dict[str, Any] = {
    "supplied_state_version": 3,
    "current_state_version": 4,
    "idempotency_key": "idem-1",
    "compilation_id": "cmp_1",
    "status": "running",
    "required_scopes": ["configuration:write"],
    "granted_scopes": ["configuration:read"],
    "issues": [{"code": "missing_field", "message": "name is required", "path": "objective.name"}],
}

API_ERROR_CLASSES = [
    ZelinqaAPIError,
    ZelinqaAuthenticationError,
    ZelinqaInsufficientScopeError,
    ZelinqaNotFoundError,
    ZelinqaUnknownSessionError,
    ZelinqaUnknownConfigurationError,
    ZelinqaUnknownCompilationError,
    ZelinqaConflictError,
    ZelinqaStateVersionConflictError,
    ZelinqaIdempotencyKeyReusedError,
    ZelinqaCompilationInProgressError,
    ZelinqaCompiledArtifactUnavailableError,
    ZelinqaValidationError,
    ZelinqaInvalidPreviousTurnError,
    ZelinqaConstraintNoMatchError,
    ZelinqaInvalidChoiceError,
    ZelinqaConfigurationValidationError,
    ZelinqaRateLimitError,
    ZelinqaIdempotencyContentionError,
    ZelinqaServerError,
]


def _round_trip(error: BaseException) -> Any:
    return pickle.loads(pickle.dumps(error, protocol=pickle.HIGHEST_PROTOCOL))


@pytest.mark.parametrize("cls", API_ERROR_CLASSES, ids=lambda cls: cls.__name__)
def test_api_errors_round_trip_through_pickle(cls: type[ZelinqaAPIError]) -> None:
    original = cls(
        "the request failed",
        status_code=409,
        code="some_code",
        request_id="req_42",
        details=DETAILS,
        retry_after=2.5,
    )

    rebuilt = _round_trip(original)

    assert type(rebuilt) is cls
    assert str(rebuilt) == str(original)
    assert repr(rebuilt) == repr(original)
    assert rebuilt.message == "the request failed"
    assert rebuilt.status_code == 409
    assert rebuilt.code == "some_code"
    assert rebuilt.request_id == "req_42"
    assert rebuilt.details == DETAILS
    assert rebuilt.retry_after == 2.5
    # Attributes a subclass derives from ``details`` are computed again.
    for name, value in vars(original).items():
        assert vars(rebuilt)[name] == value, name


def test_derived_attributes_survive() -> None:
    conflict = _round_trip(
        ZelinqaStateVersionConflictError("stale", status_code=409, details=DETAILS)
    )
    assert conflict.supplied_state_version == 3
    assert conflict.current_state_version == 4

    scope = _round_trip(ZelinqaInsufficientScopeError("scope", status_code=403, details=DETAILS))
    assert scope.required_scopes == ["configuration:write"]
    assert scope.granted_scopes == ["configuration:read"]

    validation = _round_trip(
        ZelinqaConfigurationValidationError("invalid", status_code=422, details=DETAILS)
    )
    assert [issue.code for issue in validation.issues] == ["missing_field"]


def test_minimal_api_error_round_trip() -> None:
    rebuilt = _round_trip(ZelinqaAPIError("boom", status_code=500))
    assert type(rebuilt) is ZelinqaAPIError
    assert rebuilt.status_code == 500
    assert rebuilt.code is None
    assert rebuilt.details == {}
    assert rebuilt.retry_after is None


def test_compilation_timeout_error_round_trip() -> None:
    rebuilt = _round_trip(
        ZelinqaCompilationTimeoutError("gave up", compilation_id="cmp_9", timeout=12.5)
    )
    assert type(rebuilt) is ZelinqaCompilationTimeoutError
    assert str(rebuilt) == "gave up"
    assert rebuilt.compilation_id == "cmp_9"
    assert rebuilt.timeout == 12.5


@pytest.mark.parametrize("cls", [ZelinqaError, ZelinqaConnectionError])
def test_plain_errors_round_trip(cls: type[ZelinqaError]) -> None:
    rebuilt = _round_trip(cls("unreachable"))
    assert type(rebuilt) is cls
    assert str(rebuilt) == "unreachable"


def _raise_in_worker() -> None:
    raise ZelinqaRateLimitError("slow down", status_code=429, retry_after=1.0)


def test_error_crosses_a_process_boundary() -> None:
    with concurrent.futures.ProcessPoolExecutor(max_workers=1) as pool:
        future = pool.submit(_raise_in_worker)
        with pytest.raises(ZelinqaRateLimitError) as excinfo:
            future.result(timeout=60)
    assert excinfo.value.status_code == 429
    assert excinfo.value.retry_after == 1.0
