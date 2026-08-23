from __future__ import annotations

import pytest
from nbq import Message


def test_message_rejects_invalid_role() -> None:
    with pytest.raises(ValueError, match="role"):
        Message(role="system", content="hidden")  # type: ignore[arg-type]


def test_message_rejects_empty_content() -> None:
    with pytest.raises(ValueError, match="content"):
        Message(role="user", content="   ")


def test_message_rejects_content_over_api_limit() -> None:
    with pytest.raises(ValueError, match="2000"):
        Message(role="user", content="x" * 2001)
