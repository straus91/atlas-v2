"""ATLAS V2 — a proposal for how RSNA ATLAS could present its cards.

A small ASGI app (FastAPI) that reads the cards ATLAS publishes and serves them, with the
facts people search and filter by, to the web pages in ../frontend. It stores no cards of its
own and calls no AI service. Creating and editing cards is the card creator's job, a separate
project that this site shows in a frame on its Creator page.

    GET  /api/health            status, how many cards are held, where the card creator is
    GET  /api/library           every published card as a small record to search and filter
    GET  /api/library/{id}      one card in full
    POST /api/describe          a card -> its record (used to preview a card just received)

Author review (see review.py): a card's contact person confirms the card through a personal
link, an administrator gives the final OK, and the card then shows "Author-reviewed".

    GET/POST /api/validate/{token}   the page behind a personal link: the card, and the answer
    /api/admin/...                   the admin view (one password, set with ADMIN_PASSWORD)
"""
from __future__ import annotations

import hmac
import logging
import secrets
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Callable
from urllib.parse import urlsplit

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, library, review
from .config import load_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("atlas")
settings = load_settings()
reviews = review.Reviews(settings.data_dir / "reviews.json")


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


def _fingerprint(card_id: str) -> str | None:
    record = library.library_card(card_id)
    return review.fingerprint(record["card"]) if record else None


@app.get("/api/library")
def get_library() -> dict[str, Any]:
    """`syncing` is true while the cards are being read from ATLAS (a minute or two the first time).
    `author_reviewed`: card id -> the day it was marked, for the cards that carry the mark."""
    return {**library.library_index(), "author_reviewed": reviews.marks(_fingerprint)}


@app.get("/api/library/{card_id}")
def get_library_card(card_id: str) -> dict[str, Any]:
    """{"card": the card as published, "title", "description": ATLAS's own, "facts": its record}"""
    found = library.library_card(card_id)
    if found is None:
        raise HTTPException(404, "That card is not in the library.")
    if found["facts"] is not None:
        found["facts"] = {**found["facts"], "author_reviewed": reviews.marks(_fingerprint).get(card_id)}
    return found


@app.post("/api/describe")
def describe(card: dict[str, Any] = Body(...), description: str = "") -> dict[str, Any]:
    """The record the library would show for this card. Nothing is stored: this lets the
    Creator page preview a card it has just received exactly as the library would list it."""
    if "Dataset" not in card and "Model" not in card:
        raise HTTPException(400, 'A card has a "Dataset" or a "Model" section.')
    record = {"card": card, "title": "", "description": description}
    return {**record, "facts": library.summarize("draft", record)}


# ------------------------------------------------------------------ author review: the contact's page
class Answer(BaseModel):
    correct: bool
    name: str = Field("", max_length=200)
    comment: str = Field("", max_length=4000)


def _for_contact(token: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
    found = reviews.by_token(token)
    record = library.library_card(found[0]) if found else None
    if found is None or record is None:
        raise HTTPException(404, "This link is not valid any more. It may have been replaced by a newer one, or it is "
                                 f"older than {review.LINK_DAYS} days.")
    return found[0], found[1], record


def _contact_view(state: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    return {"record": record, "status": state["status"], "name": state.get("answered_by") or state.get("name", ""),
            "comment": state.get("comment", ""), "answered_at": state.get("answered_at"), "until": state.get("expires_at")}


@app.get("/api/validate/{token}")
def validation_page(token: str) -> dict[str, Any]:
    """What the page behind a personal link shows: the card, and the answer given so far."""
    _, state, record = _for_contact(token)
    return _contact_view(state, record)


@app.post("/api/validate/{token}")
def validation_answer(token: str, answer: Answer) -> dict[str, Any]:
    card_id, _, record = _for_contact(token)
    try:
        state = reviews.answer(token, correct=answer.correct, name=answer.name, comment=answer.comment,
                               card_fingerprint=review.fingerprint(record["card"]))
    except review.ReviewError as error:
        raise HTTPException(400, str(error)) from None
    log.info("review: the contact of %s answered: %s", card_id, state["status"])
    return _contact_view(state, record)


# ------------------------------------------------------------------ author review: the admin view
ADMIN_COOKIE = "atlas_admin"
SESSION_HOURS = 12
_admin_lock = threading.Lock()
_sessions: dict[str, float] = {}      # cookie value -> when it stops working
_failed_logins: list[float] = []


def _signed_in(request: Request) -> bool:
    cookie = request.cookies.get(ADMIN_COOKIE, "")
    with _admin_lock:
        return bool(cookie) and _sessions.get(cookie, 0) > time.time()


def require_admin(request: Request) -> None:
    if not settings.admin_password:
        raise HTTPException(503, "The admin view is not set up on this site.")
    if not _signed_in(request):
        raise HTTPException(401, "Sign in first.")


class Login(BaseModel):
    password: str = Field(max_length=500)


@app.get("/api/admin/session")
def admin_session(request: Request) -> dict[str, Any]:
    return {"configured": bool(settings.admin_password), "signed_in": bool(settings.admin_password) and _signed_in(request)}


@app.post("/api/admin/login")
def admin_login(login: Login, request: Request, response: Response) -> dict[str, Any]:
    if not settings.admin_password:
        raise HTTPException(503, "The admin view is not set up on this site.")
    with _admin_lock:
        recent = [at for at in _failed_logins if at > time.time() - 900]
        _failed_logins[:] = recent
        if len(recent) >= 5:
            raise HTTPException(429, "Too many wrong passwords. Wait 15 minutes and try again.")
        if not hmac.compare_digest(login.password.encode(), settings.admin_password.encode()):
            _failed_logins.append(time.time())
            raise HTTPException(401, "That is not the password.")
        cookie = secrets.token_urlsafe(32)
        for old in [key for key, until in _sessions.items() if until < time.time()]:
            del _sessions[old]
        _sessions[cookie] = time.time() + SESSION_HOURS * 3600
    response.set_cookie(ADMIN_COOKIE, cookie, max_age=SESSION_HOURS * 3600, httponly=True, samesite="strict",
                        secure=request.url.scheme == "https", path="/api/admin")
    return {"configured": True, "signed_in": True}


@app.post("/api/admin/logout")
def admin_logout(request: Request, response: Response) -> dict[str, Any]:
    with _admin_lock:
        _sessions.pop(request.cookies.get(ADMIN_COOKIE, ""), None)
    response.delete_cookie(ADMIN_COOKIE, path="/api/admin")
    return {"configured": bool(settings.admin_password), "signed_in": False}


def _admin_view(state: dict[str, Any] | None, card: dict[str, Any]) -> dict[str, Any] | None:
    """A card's review as the administrator sees it. `changed`: the card is no longer the one reviewed."""
    if not state:
        return None
    seen = {key: value for key, value in state.items() if key not in ("token", "fingerprint")}
    return {**seen, "changed": bool(state.get("fingerprint")) and state["fingerprint"] != review.fingerprint(card)}


def _card_or_404(card_id: str) -> dict[str, Any]:
    record = library.library_card(card_id)
    if record is None or record["facts"] is None:
        raise HTTPException(404, "That card is not in the library.")
    return record


@app.get("/api/admin/reviews", dependencies=[Depends(require_admin)])
def admin_reviews() -> dict[str, Any]:
    """Every card with the people it names as contact and where its review stands."""
    saved = reviews.all()
    rows = []
    for facts in library.library_index()["cards"]:
        record = library.library_card(facts["id"])
        if record is None:
            continue
        rows.append({"id": facts["id"], "title": facts["title"], "type": facts["type"],
                     "contacts": review.contacts_of(record["card"]), "review": _admin_view(saved.get(facts["id"]), record["card"])})
    return {"cards": rows, "settings": reviews.settings(), "link_days": review.LINK_DAYS,
            "mail": {"configured": settings.mail.configured, "sender": settings.mail.sender if settings.mail.configured else ""}}


class ReviewSettings(BaseModel):
    emails_enabled: bool | None = None
    subject: str | None = Field(None, max_length=200)
    body: str | None = Field(None, max_length=5000)


@app.put("/api/admin/settings", dependencies=[Depends(require_admin)])
def admin_settings(change: ReviewSettings) -> dict[str, Any]:
    try:
        reviews.change_settings(change.emails_enabled, change.subject, change.body)
    except review.ReviewError as error:
        raise HTTPException(400, str(error)) from None
    return reviews.settings()


class Ask(BaseModel):
    id: str
    email: str = Field(max_length=320)
    name: str = Field("", max_length=200)


class AskMany(BaseModel):
    cards: list[Ask] = Field(max_length=50)


@app.post("/api/admin/reviews/request", dependencies=[Depends(require_admin)])
def admin_request(asked: AskMany, request: Request) -> dict[str, Any]:
    """Ask the contacts of the chosen cards to check them. One card failing does not stop the others."""
    if not reviews.settings()["emails_enabled"]:
        raise HTTPException(400, "Validation emails are switched off. Switch them on first.")
    site = settings.site_url or str(request.base_url).rstrip("/")
    results = []
    for ask in asked.cards:
        record = library.library_card(ask.id)
        if record is None or record["facts"] is None:
            results.append({"id": ask.id, "ok": False, "problem": "That card is not in the library."})
            continue
        try:
            state = reviews.request(ask.id, title=record["facts"]["title"], card_type=record["facts"]["type"],
                                    email=ask.email, name=ask.name, site=site, mail=settings.mail)
        except review.ReviewError as error:
            results.append({"id": ask.id, "ok": False, "problem": str(error)})
            continue
        log.info("review: asked the contact of %s (email sent: %s)", ask.id, state["email_sent"])
        results.append({"id": ask.id, "ok": True, "sent": state["email_sent"], "problem": state["email_problem"]})
    return {"results": results}


class ByHand(BaseModel):
    note: str = Field(max_length=500)


def _changed(action: Callable[[], dict[str, Any] | None]) -> dict[str, Any]:
    try:
        return {"review": action()}
    except review.ReviewError as error:
        raise HTTPException(400, str(error)) from None


@app.post("/api/admin/reviews/{card_id}/approve", dependencies=[Depends(require_admin)])
def admin_approve(card_id: str) -> dict[str, Any]:
    """The final OK: from now on everyone sees the card as author-reviewed."""
    card = _card_or_404(card_id)["card"]
    return _changed(lambda: _admin_view(reviews.approve(card_id, review.fingerprint(card)), card))


@app.post("/api/admin/reviews/{card_id}/mark", dependencies=[Depends(require_admin)])
def admin_mark(card_id: str, by_hand: ByHand) -> dict[str, Any]:
    """Mark a card as author-reviewed without the email; the reason is kept."""
    card = _card_or_404(card_id)["card"]
    return _changed(lambda: _admin_view(reviews.mark_by_hand(card_id, review.fingerprint(card), by_hand.note), card))


@app.delete("/api/admin/reviews/{card_id}", dependencies=[Depends(require_admin)])
def admin_clear(card_id: str) -> dict[str, Any]:
    reviews.clear(card_id)
    return {"review": None}


# Serve the built pages from the same container when they are present (single-image deploys).
if settings.static_dir.is_dir():
    app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="frontend")
