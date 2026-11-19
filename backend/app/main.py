"""ATLAS V2 — a proposal for how RSNA ATLAS could present its cards.

A small ASGI app (FastAPI) that reads the cards ATLAS publishes and serves them, with the
facts people search and filter by, to the web pages in ../frontend. It has no accounts, stores
no cards of its own and calls no AI service. Creating and editing cards is the card creator's
job, a separate project that this site shows in a frame on its Creator page.

    GET  /api/health            status, how many cards are held, where the card creator is
    GET  /api/library           every published card as a small record to search and filter
    GET  /api/library/{id}      one card in full
    POST /api/describe          a card -> its record (used to preview a card just received)
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import __version__, library
from .config import load_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
settings = load_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    library.configure(settings.data_dir)
    if settings.library_sync_hours > 0:
        library.start_background_sync(settings.library_sync_hours)
    yield


app = FastAPI(title="ATLAS V2", version=__version__, lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2000)   # the library listing is large as plain text


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""


@app.get("/api/health")
def health() -> dict[str, Any]:
    index = library.library_index()
    return {"status": "ok", "version": __version__, "cards": index["count"],
            "synced_at": index["synced_at"], "syncing": index["syncing"],
            "creator_url": settings.creator_url, "creator_origin": _origin(settings.creator_url)}


@app.get("/api/library")
def get_library() -> dict[str, Any]:
    """`syncing` is true while the cards are being read from ATLAS (a minute or two the first time)."""
    return library.library_index()


@app.get("/api/library/{card_id}")
def get_library_card(card_id: str) -> dict[str, Any]:
    """{"card": the card as published, "title", "description": ATLAS's own, "facts": its record}"""
    found = library.library_card(card_id)
    if found is None:
        raise HTTPException(404, "That card is not in the library.")
    return found


@app.post("/api/describe")
def describe(card: dict[str, Any] = Body(...), description: str = "") -> dict[str, Any]:
    """The record the library would show for this card. Nothing is stored: this lets the
    Creator page preview a card it has just received exactly as the library would list it."""
    if "Dataset" not in card and "Model" not in card:
        raise HTTPException(400, 'A card has a "Dataset" or a "Model" section.')
    record = {"card": card, "title": "", "description": description}
    return {**record, "facts": library.summarize("draft", record)}


# Serve the built pages from the same container when they are present (single-image deploys).
if settings.static_dir.is_dir():
    app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="frontend")
