"""All configuration comes from environment variables (see .env.example)."""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


@dataclass(frozen=True)
class Settings:
    library_sync_hours: float     # how often the cards are re-read from ATLAS; 0 = never
    creator_url: str              # the card creator shown on the Creator page ("" = no Creator page)
    data_dir: Path                # where the copy of the cards is kept
    static_dir: Path              # the built web pages
    # Only used by the one-off reading tool (python -m app.results); the site itself never calls AI.
    reader_model: str
    reader_price_per_mtok: tuple[float, float]


def load_settings() -> Settings:
    return Settings(
        library_sync_hours=float(_env("LIBRARY_SYNC_HOURS", "24")),
        creator_url=_env("CREATOR_URL", "https://card-creator.pedsrad.org").rstrip("/"),
        data_dir=Path(_env("DATA_DIR") or Path(tempfile.gettempdir()) / "atlas-v2"),
        static_dir=Path(_env("STATIC_DIR", "/app/static")),
        reader_model=_env("READER_MODEL", "gemini-4-hydrogen"),
        reader_price_per_mtok=(float(_env("READER_PRICE_INPUT_PER_MTOK", "1.50")),
                               float(_env("READER_PRICE_OUTPUT_PER_MTOK", "7.50"))),
    )
