"""ATLAS V2 — a proposal for how RSNA ATLAS could present its cards.

A small ASGI app (FastAPI) that reads the cards ATLAS publishes and serves them, with the
facts people search and filter by, to the web pages in ../frontend. It stores no cards of its
own and calls no AI service. Creating and editing cards is the card creator's job, a separate
project that this site shows in a frame on its Creator page.

    GET  /api/health            status, how many cards are held, where the card creator is
    GET  /api/library           every published card as a small record to search and filter
    GET  /api/library/{id}      one card in full
    POST /api/describe          a card -> its record (used to preview a card just received)

Author review (see review.py): a card's contact person confirms or corrects the card through a
personal link, an administrator gives the final OK, and the card then shows "Author-reviewed".
A corrected card is edited in the card creator (in a frame on the contact's page), kept here
while the contact works on it, and shown in place of ATLAS's copy after the final OK.

    GET/POST /api/validate/{token}        the page behind a personal link: the card, and the answer
    PUT      /api/validate/{token}/draft  keep the contact's version of the card so far
    /api/admin/...                        the admin view (one password, set with ADMIN_PASSWORD)
"""
from __future__ import annotations

import hmac
import json
import logging
import secrets
import threading
import time
import urllib.request
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
    """Of the card as the library holds it (ATLAS's copy), whatever its author has corrected here."""
    record = library.library_card(card_id)
    return review.fingerprint(record["card"]) if record else None


def _with_revision(card_id: str, record: dict[str, Any], revision: dict[str, Any]) -> dict[str, Any]:
    """The record with its author's corrected card in place of the library's copy. The title follows
    a corrected name, unless ATLAS had given the card a title of its own."""
    def name(card: dict[str, Any]) -> str:
        body = card.get("Dataset") or card.get("Model") or {}
        return str(body.get("Name") or "").strip() if isinstance(body, dict) else ""
    shown = {**record, "card": revision}
    if name(revision) and record.get("title", "").strip() == name(record["card"]):
        shown["title"] = name(revision)
    return {**shown, "facts": {**library.summarize(card_id, shown), "author_edited": True}}


@app.get("/api/library")
def get_library() -> dict[str, Any]:
    """`syncing` is true while the cards are being read from ATLAS (a minute or two the first time).
    `author_reviewed`: card id -> when it was marked, for the cards that carry the mark.
    A card whose author corrected it (and an administrator approved that) is listed as corrected."""
    index = library.library_index()
    revisions = reviews.revisions(_fingerprint)
    if revisions:
        cards = []
        for facts in index["cards"]:
            record = library.library_card(facts["id"]) if facts["id"] in revisions else None
            cards.append(_with_revision(facts["id"], record, revisions[facts["id"]])["facts"] if record else facts)
        index = {**index, "cards": cards}
    return {**index, "author_reviewed": reviews.marks(_fingerprint)}


@app.get("/api/library/{card_id}")
def get_library_card(card_id: str) -> dict[str, Any]:
    """{"card": the card as this site shows it, "title", "description": ATLAS's own, "facts": its record}"""
    found = library.library_card(card_id)
    if found is None:
        raise HTTPException(404, "That card is not in the library.")
    revision = reviews.revisions(_fingerprint).get(card_id)
    if revision is not None:
        found = _with_revision(card_id, found, revision)
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
    how: str = Field("", max_length=20)                 # "quick": the one-click yes
    card: dict[str, Any] | None = None                  # the contact's corrected card, from the card creator


class Draft(BaseModel):
    card: dict[str, Any]


def _same_kind(card: dict[str, Any], published: dict[str, Any]) -> None:
    root = "Dataset" if "Dataset" in published else "Model"
    if not isinstance(card.get(root), dict):
        raise HTTPException(400, f'What arrived is not a {root.lower()} card.')


def _for_contact(token: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
    found = reviews.by_token(token)
    record = library.library_card(found[0]) if found else None
    if found is None or record is None:
        raise HTTPException(404, "This link is not valid any more. It may have been replaced by a newer one, or it is "
                                 f"older than {review.LINK_DAYS} days.")
    return found[0], found[1], record


def _contact_view(state: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    """`draft`: the contact's own version of the card so far, with what differs from the published card."""
    draft = state.get("draft") if state["status"] != "approved" else None
    revision = state.get("revision") if state["status"] == "approved" else None
    if revision:
        record = {**record, "card": revision}
    return {"record": record, "status": state["status"], "name": state.get("answered_by") or state.get("name", ""),
            "comment": state.get("comment", ""), "answered_at": state.get("answered_at"), "until": state.get("expires_at"),
            "how": state.get("how", ""),
            "draft": {"card": draft["card"], "saved_at": draft.get("saved_at"),
                      "differences": review.differences(record["card"], draft["card"])} if draft else None}


@app.get("/api/validate/{token}")
def validation_page(token: str) -> dict[str, Any]:
    """What the page behind a personal link shows: the card, and the answer given so far."""
    _, state, record = _for_contact(token)
    return _contact_view(state, record)


@app.put("/api/validate/{token}/draft")
def validation_draft(token: str, draft: Draft) -> dict[str, Any]:
    """Keep the contact's version of the card so far, so they can come back to it."""
    _, _, record = _for_contact(token)
    _same_kind(draft.card, record["card"])
    try:
        state = reviews.save_draft(token, draft.card)
    except review.ReviewError as error:
        raise HTTPException(400, str(error)) from None
    return _contact_view(state, record)["draft"]


@app.post("/api/validate/{token}")
def validation_answer(token: str, answer: Answer, request: Request) -> dict[str, Any]:
    card_id, _, record = _for_contact(token)
    changed: list[dict[str, str]] = []
    if answer.card is not None:
        _same_kind(answer.card, record["card"])
        changed = review.differences(record["card"], answer.card)
    try:
        state = reviews.answer(token, correct=answer.correct, name=answer.name, comment=answer.comment, how=answer.how,
                               card_fingerprint=review.fingerprint(record["card"]),
                               card=answer.card if changed else None, changes=len(changed))
    except review.ReviewError as error:
        raise HTTPException(400, str(error)) from None
    log.info("review: the contact of %s answered: %s", card_id, state["status"])
    title = (record.get("facts") or {}).get("title") or record.get("title") or card_id
    subject, body = review.admin_notice(title=title, review=state, changed=changed, site=settings.site_url or str(request.base_url).rstrip("/"))
    reviews.post(settings.mail, to=reviews.settings()["admin_email"], subject=subject, body=body, about=title, kind="notice")
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
    seen = {key: value for key, value in state.items() if key not in ("token", "fingerprint", "draft", "revision")}
    revision = state.get("revision")
    return {**seen, "changed": bool(state.get("fingerprint")) and state["fingerprint"] != review.fingerprint(card),
            "working": state.get("status") == "requested" and "draft" in state,
            "differences": review.differences(card, revision) if revision else []}


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
    return {"cards": rows, "settings": reviews.settings(), "link_days": review.LINK_DAYS, "outbox": reviews.outbox(),
            "new_cards": library.new_card_count(),
            "mail": {"configured": settings.mail.configured, "sender": settings.mail.sender if settings.mail.configured else ""}}


class ReviewSettings(BaseModel):
    emails_enabled: bool | None = None
    subject: str | None = Field(None, max_length=200)
    body: str | None = Field(None, max_length=5000)
    admin_email: str | None = Field(None, max_length=320)     # where notes about answers go; "" = nowhere


@app.put("/api/admin/settings", dependencies=[Depends(require_admin)])
def admin_settings(change: ReviewSettings) -> dict[str, Any]:
    try:
        reviews.change_settings(change.emails_enabled, change.subject, change.body, change.admin_email)
    except review.ReviewError as error:
        raise HTTPException(400, str(error)) from None
    return reviews.settings()


class TestEmail(BaseModel):
    to: str = Field(max_length=320)


@app.post("/api/admin/test-email", dependencies=[Depends(require_admin)])
def admin_test_email(test: TestEmail, request: Request) -> dict[str, Any]:
    """One message to an address the administrator gives, to see that the mail account works
    before anyone else is written to. It is kept in the outbox like every other message."""
    to = test.to.strip()
    if not review.EMAIL.fullmatch(to):
        raise HTTPException(400, f'"{to}" is not an email address.')
    if not settings.mail.configured:
        raise HTTPException(400, "No mail server is set up on this site, so there is nothing to test.")
    site = settings.site_url or str(request.base_url).rstrip("/")
    body = (f"This is a test from {site}.\n\nIf you are reading it, the site can send email. Requests to the contacts of cards, "
            "and the notes to you when they answer, come from this same address.\n\nThere is nothing to do with this message.")
    sent, problem = reviews.post(settings.mail, to=to, subject="Test email from ATLAS V2", body=body, about="", kind="test")
    log.info("review: test email (sent: %s)", sent)
    return {"sent": sent, "problem": problem, "outbox": reviews.outbox()}


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


def _schema_problems(card: dict[str, Any]) -> list[str]:
    """What in a card does not fit the ATLAS schema, as the card creator's server judges it (it holds
    the schema; this site does not). Raises ReviewError when the card creator cannot be asked."""
    if not settings.creator_api_url:
        raise review.ReviewError("This site has no card creator to check the corrected card against the ATLAS schema.")
    request = urllib.request.Request(f"{settings.creator_api_url}/api/validate", data=json.dumps(card).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            verdict = json.loads(response.read().decode("utf-8"))
        return [] if verdict["valid"] else [f'{problem.get("location") or problem.get("pointer")}: {problem.get("message")}'
                                            for problem in verdict["errors"]] or ["it does not fit the schema"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise review.ReviewError("The corrected card could not be checked against the ATLAS schema, because the card creator "
                                 f"did not answer ({type(error).__name__}). Nothing was published; try again.") from None


@app.post("/api/admin/reviews/{card_id}/approve", dependencies=[Depends(require_admin)])
def admin_approve(card_id: str) -> dict[str, Any]:
    """The final OK: from now on everyone sees the card as author-reviewed. A card its author corrected
    is checked against the ATLAS schema once more first, and is then the card this site shows."""
    card = _card_or_404(card_id)["card"]

    def approve() -> dict[str, Any] | None:
        revision = (reviews.get(card_id) or {}).get("revision")
        if revision:
            problems = _schema_problems(revision)
            if problems:
                raise review.ReviewError("The author's version does not fit the ATLAS schema, so it was not published: "
                                         + "; ".join(problems[:5]) + ("; …" if len(problems) > 5 else ""))
        return _admin_view(reviews.approve(card_id, review.fingerprint(card)), card)
    return _changed(approve)


@app.post("/api/admin/reviews/{card_id}/mark", dependencies=[Depends(require_admin)])
def admin_mark(card_id: str, by_hand: ByHand) -> dict[str, Any]:
    """Mark a card as author-reviewed without the email; the reason is kept."""
    card = _card_or_404(card_id)["card"]
    return _changed(lambda: _admin_view(reviews.mark_by_hand(card_id, review.fingerprint(card), by_hand.note), card))


@app.delete("/api/admin/reviews/{card_id}", dependencies=[Depends(require_admin)])
def admin_clear(card_id: str) -> dict[str, Any]:
    reviews.clear(card_id)
    return {"review": None}


# ------------------------------------------------------------------ new cards: not on ATLAS, added as one file
class NewCards(BaseModel):
    cards: list[dict[str, Any]] = Field(max_length=5000)


@app.post("/api/admin/new-cards", dependencies=[Depends(require_admin)])
def admin_add_new_cards(added: NewCards) -> dict[str, Any]:
    """Add cards that are not on ATLAS, for example cards drafted from papers. They are listed with
    ATLAS's cards and always marked as new. A card added before under the same id is replaced."""
    try:
        counts = library.add_new_cards(added.cards)
    except ValueError as error:
        raise HTTPException(400, str(error)) from None
    log.info("library: %d new cards added, %d replaced", counts["added"], counts["replaced"])
    return counts


@app.delete("/api/admin/new-cards", dependencies=[Depends(require_admin)])
def admin_remove_new_cards() -> dict[str, Any]:
    return {"removed": library.remove_new_cards(), "total": 0}


# Serve the built pages from the same container when they are present (single-image deploys).
if settings.static_dir.is_dir():
    app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="frontend")
