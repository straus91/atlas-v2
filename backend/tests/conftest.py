import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.reader import Completion  # noqa: E402


class FakeProvider:
    """Stands in for the language model: replies with canned text, records what it was asked."""

    def __init__(self, *replies: str):
        self.replies = list(replies)
        self.calls: list[dict] = []

    def is_configured(self) -> bool:
        return True

    def complete(self, system, user):
        self.calls.append({"system": system, "user": user})
        return Completion(text=self.replies.pop(0), usage={"input_tokens": 10, "output_tokens": 5})
