"""Official Python SDK for the Zelinqa NBQ API."""

from ._version import __version__
from .client import AsyncNBQClient, NBQClient
from .errors import (
    NBQAPIError,
    NBQAuthenticationError,
    NBQConflictError,
    NBQConnectionError,
    NBQError,
    NBQRateLimitError,
    NBQServerError,
    NBQValidationError,
)
from .models import (
    ConversionResponse,
    Message,
    NextQuestion,
    NextQuestionsResponse,
    Outcome,
)

__all__ = [
    "AsyncNBQClient",
    "ConversionResponse",
    "Message",
    "NBQAPIError",
    "NBQAuthenticationError",
    "NBQClient",
    "NBQConflictError",
    "NBQConnectionError",
    "NBQError",
    "NBQRateLimitError",
    "NBQServerError",
    "NBQValidationError",
    "NextQuestion",
    "NextQuestionsResponse",
    "Outcome",
    "__version__",
]
