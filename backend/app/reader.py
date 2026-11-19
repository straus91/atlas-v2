"""The language model used by the one-off reading tool (results.py). Not used by the site.

Plain REST to Google's Gemini over the standard library. Set GEMINI_API_KEY to run the tool.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"


@dataclass
class Completion:
    text: str
    usage: dict[str, int] = field(default_factory=dict)


class Reader:
    def __init__(self, model: str):
        self.model = model

    def is_configured(self) -> bool:
        return bool(os.environ.get("GEMINI_API_KEY"))

    def complete(self, system: str, user: str) -> Completion:
        body = json.dumps({
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2},
        }).encode()
        request = urllib.request.Request(
            f"{API_ROOT}/{self.model}:generateContent", data=body,
            headers={"Content-Type": "application/json", "x-goog-api-key": os.environ.get("GEMINI_API_KEY", "")})
        payload: dict = {}
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=300) as response:
                    payload = json.loads(response.read())
                break
            except urllib.error.HTTPError as error:
                if error.code in (429, 500, 503) and attempt < 2:
                    time.sleep(10 * (attempt + 1))
                    continue
                raise RuntimeError(f"Gemini returned an error ({error.code}).") from None
        candidates = payload.get("candidates") or []
        if not candidates:
            raise RuntimeError("Gemini returned no answer.")
        text = "".join(part.get("text", "") for part in candidates[0].get("content", {}).get("parts", []))
        meta = payload.get("usageMetadata", {})
        return Completion(text=text, usage={
            "input_tokens": meta.get("promptTokenCount", 0),
            "output_tokens": meta.get("candidatesTokenCount", 0) + meta.get("thoughtsTokenCount", 0)})
