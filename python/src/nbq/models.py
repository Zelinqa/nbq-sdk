"""Public data models returned by the NBQ runtime API."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, TypeAlias, cast

Role: TypeAlias = Literal["user", "assistant"]
Outcome: TypeAlias = Literal["purchase", "lead", "abandon", "other"]

MAX_MESSAGE_CHARS = 2000


@dataclass(frozen=True, slots=True)
class Message:
    """A conversation message accepted by the NBQ runtime API."""

    role: Role
    content: str

    def __post_init__(self) -> None:
        if self.role not in ("user", "assistant"):
            raise ValueError("role must be 'user' or 'assistant'")
        if not self.content.strip():
            raise ValueError("content must not be empty")
        if len(self.content) > MAX_MESSAGE_CHARS:
            raise ValueError(f"content must not exceed {MAX_MESSAGE_CHARS} characters")

    def to_payload(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


MessageInput: TypeAlias = Message | Mapping[str, str]


@dataclass(frozen=True, slots=True)
class NextQuestion:
    external_id: str
    text: str

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> NextQuestion:
        return cls(external_id=str(payload["external_id"]), text=str(payload["text"]))


@dataclass(frozen=True, slots=True)
class NextQuestionsResponse:
    next_question: NextQuestion | None
    exhausted: bool
    nbq_version: str
    request_id: str

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> NextQuestionsResponse:
        raw_question = payload.get("next_question")
        question = (
            NextQuestion.from_payload(cast(Mapping[str, Any], raw_question))
            if isinstance(raw_question, Mapping)
            else None
        )
        return cls(
            next_question=question,
            exhausted=bool(payload["exhausted"]),
            nbq_version=str(payload["nbq_version"]),
            request_id=str(payload["request_id"]),
        )


@dataclass(frozen=True, slots=True)
class ConversionResponse:
    conversion_id: str
    request_id: str

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> ConversionResponse:
        return cls(
            conversion_id=str(payload["conversion_id"]),
            request_id=str(payload["request_id"]),
        )


def serialize_messages(messages: Sequence[MessageInput]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for message in messages:
        if isinstance(message, Message):
            result.append(message.to_payload())
            continue

        role = message.get("role")
        content = message.get("content")
        if role not in ("user", "assistant"):
            raise ValueError("each message role must be 'user' or 'assistant'")
        if not content or not content.strip():
            raise ValueError("each message content must not be empty")
        if len(content) > MAX_MESSAGE_CHARS:
            raise ValueError(f"each message content must not exceed {MAX_MESSAGE_CHARS} characters")
        result.append({"role": role, "content": content})
    return result
