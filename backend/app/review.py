"""Author review of cards.

A card can carry the mark "Author-reviewed": its contact person was asked to check the card,
said it is correct, and an administrator gave the final OK. This module keeps that state in one
small file, makes the personal links, and writes and sends the emails.

The steps of one review:

    requested   the contact was asked (an email was sent, or a link was made to send by hand)
    confirmed   the contact said the card is correct          } answered on the page behind
    changes     the contact said the card needs changes       } the personal link
    approved    an administrator gave the final OK: everyone sees the mark

The mark belongs to the card as it was when it was reviewed. If the card changes afterwards,
the mark is no longer shown until the card is reviewed again.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import smtplib
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable

LINK_DAYS = 60                     # how long a personal link works
STATUSES = ("requested", "confirmed", "changes", "approved")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_WORD_WITH_AT = re.compile(r"[^\s<>()\[\],;:\"']+@[^\s<>()\[\],;:\"']+")
# How addresses usually end; used only to tell an address from one written backwards.
ENDINGS = set("com org edu net gov mil int info io ai health ac at au be br ca ch cl cn co cz de dk eg es eu fi fr gr hk hu ie il in "
              "ir it jp kr lb mx my nl no nz pk pl pt qa ro ru sa se sg th tr tw ua uk us za".split())


def _ending(address: str) -> str:
    return address.rsplit(".", 1)[-1].lower()

DEFAULT_SUBJECT = 'Please check the ATLAS card for "{card}"'
DEFAULT_BODY = """Dear {name},

You are listed as the contact for "{card}", which has a {type} card in RSNA ATLAS, the catalogue of AI models and datasets in radiology.

We would like the people who made each model and dataset to confirm that its card describes it correctly. Could you open the page below, read the card, and tell us whether it is correct or needs changes? It takes a few minutes and needs no account.

{link}

The link is for this card only and works until {until}.

Thank you,
The ATLAS V2 proposal team"""


class ReviewError(Exception):
    """Something the administrator or the contact asked for cannot be done; the text says why."""


def now() -> datetime:
    return datetime.now(timezone.utc)


def fingerprint(card: dict[str, Any]) -> str:
    """Changes whenever anything in the card changes."""
    return hashlib.sha256(json.dumps(card, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def contacts_of(card: dict[str, Any]) -> list[dict[str, str]]:
    """The people a card names with an email address: its contact first, then its authors.

    Some cards carry an address written backwards (a publisher's protection against address
    collectors, copied along with the text); those are turned around and flagged."""
    body = card.get("Dataset") or card.get("Model") or {}
    descriptors = body.get("Descriptors") if isinstance(body, dict) else None
    descriptors = descriptors if isinstance(descriptors, dict) else {}
    authors = [a for a in descriptors.get("Authors") or [] if isinstance(a, dict)]
    found: list[dict[str, str]] = []

    contact = descriptors.get("Contact")
    text = contact if isinstance(contact, str) else json.dumps(contact, ensure_ascii=False) if contact else ""
    for word in _WORD_WITH_AT.findall(text):
        word = word.strip(".")
        forward, backward = bool(EMAIL.fullmatch(word)), bool(EMAIL.fullmatch(word[::-1]))
        # "moc.elpmaxe@eel.nna" also looks like an address: the one that ends like an address wins
        if backward and (not forward or (_ending(word[::-1]) in ENDINGS and _ending(word) not in ENDINGS)):
            found.append({"email": word[::-1], "name": "", "source": "the card's contact (written backwards in the card)"})
        elif forward:
            found.append({"email": word, "name": "", "source": "the card's contact"})
    for author in authors:
        email = str(author.get("Email") or "").strip().strip(".")
        if EMAIL.fullmatch(email):
            found.append({"email": email, "name": str(author.get("Name") or "").strip(), "source": "the card's authors"})

    names = {str(a.get("Email") or "").strip().lower(): str(a.get("Name") or "").strip() for a in authors}
    unique: dict[str, dict[str, str]] = {}
    for person in found:
        key = person["email"].lower()
        if key not in unique:
            unique[key] = {**person, "name": person["name"] or names.get(key, "")}
    return list(unique.values())


# ------------------------------------------------------------------ email
@dataclass(frozen=True)
class Mail:
    """The mail server emails are sent through. Without a host nothing is ever sent."""
    host: str = ""
    port: int = 587
    user: str = ""
    password: str = ""
    sender: str = ""          # the From address
    reply_to: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.host and EMAIL.fullmatch(self.sender))


def send_email(mail: Mail, to: str, subject: str, body: str) -> None:
    """Send one plain-text email. Raises ReviewError with a reason a person can act on."""
    message = EmailMessage()
    message["From"] = mail.sender
    message["To"] = to
    message["Subject"] = " ".join(subject.split())[:200]
    if mail.reply_to:
        message["Reply-To"] = mail.reply_to
    message.set_content(body)
    try:
        if mail.port == 465:
            server: smtplib.SMTP = smtplib.SMTP_SSL(mail.host, mail.port, timeout=30)
        else:
            server = smtplib.SMTP(mail.host, mail.port, timeout=30)
        with server:
            if mail.port != 465:
                server.ehlo()
                if server.has_extn("starttls"):
                    server.starttls()
                    server.ehlo()
                elif mail.user:
                    raise ReviewError("the mail server does not offer a protected connection, so the password was not sent")
            if mail.user:
                server.login(mail.user, mail.password)
            server.send_message(message)
    except smtplib.SMTPAuthenticationError:
        raise ReviewError("the mail server rejected the user name or password") from None
    except smtplib.SMTPRecipientsRefused:
        raise ReviewError("the mail server refused this address") from None
    except (smtplib.SMTPException, OSError) as error:
        raise ReviewError(f"the mail server could not be used ({type(error).__name__})") from None


def write_message(subject: str, body: str, *, name: str, card: str, card_type: str, link: str, until: str) -> tuple[str, str]:
    """Fill in the message. The link is always in it, whatever the administrator wrote."""
    values = {"{name}": name.strip() or "colleague", "{card}": card, "{type}": card_type, "{link}": link, "{until}": until}
    if "{link}" not in body:
        body = body.rstrip() + "\n\n{link}"
    for mark, value in values.items():
        subject, body = subject.replace(mark, value), body.replace(mark, value)
    return subject, body


# ------------------------------------------------------------------ the reviews
class Reviews:
    """Every card's review, kept in one JSON file. Safe to use from several requests at once."""

    def __init__(self, path: Path | None):
        self._path = path
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {"settings": {}, "reviews": {}}
        if path is not None and path.exists():
            try:
                saved = json.loads(path.read_text(encoding="utf-8"))
                self._data = {"settings": dict(saved.get("settings") or {}), "reviews": dict(saved.get("reviews") or {})}
            except (OSError, ValueError):
                pass  # an unreadable file is replaced at the next change; the cards themselves are untouched

    def _save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        temporary.replace(self._path)

    # ---- settings the administrator changes on the page
    def settings(self) -> dict[str, Any]:
        with self._lock:
            saved = self._data["settings"]
            return {"emails_enabled": bool(saved.get("emails_enabled")),
                    "subject": saved.get("subject") or DEFAULT_SUBJECT, "body": saved.get("body") or DEFAULT_BODY,
                    "standard_subject": DEFAULT_SUBJECT, "standard_body": DEFAULT_BODY}

    def change_settings(self, emails_enabled: bool | None = None, subject: str | None = None, body: str | None = None) -> None:
        if body is not None and body.strip() and "{link}" not in body:
            raise ReviewError("The message must contain {link}, the place where the personal link goes.")
        with self._lock:
            saved = self._data["settings"]
            if emails_enabled is not None:
                saved["emails_enabled"] = bool(emails_enabled)
            if subject is not None:
                saved["subject"] = " ".join(subject.split())[:200]
            if body is not None:
                saved["body"] = body.strip()[:5000]
            self._save()

    # ---- reading
    def get(self, card_id: str) -> dict[str, Any] | None:
        with self._lock:
            found = self._data["reviews"].get(card_id)
            return json.loads(json.dumps(found)) if found else None

    def all(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return json.loads(json.dumps(self._data["reviews"]))

    def marks(self, fingerprint_of: Callable[[str], str | None]) -> dict[str, str]:
        """card id -> the day it became author-reviewed, for cards unchanged since their review."""
        with self._lock:
            approved = {card_id: (review.get("fingerprint"), review.get("approved_at", ""))
                        for card_id, review in self._data["reviews"].items() if review.get("status") == "approved"}
        return {card_id: day[:10] for card_id, (reviewed, day) in approved.items() if reviewed and reviewed == fingerprint_of(card_id)}

    def by_token(self, token: str) -> tuple[str, dict[str, Any]] | None:
        """The card a personal link is for. None when the link is unknown, replaced or too old."""
        if not token:
            return None
        with self._lock:
            for card_id, review in self._data["reviews"].items():
                if secrets.compare_digest(str(review.get("token") or ""), token):
                    if review.get("expires_at", "") < now().isoformat():
                        return None
                    return card_id, json.loads(json.dumps(review))
        return None

    # ---- the steps
    def _note(self, review: dict[str, Any], what: str) -> None:
        review.setdefault("history", []).append({"at": now().isoformat(timespec="seconds"), "what": what})
        del review["history"][:-30]

    def request(self, card_id: str, *, title: str, card_type: str, email: str, name: str, site: str,
                mail: Mail) -> dict[str, Any]:
        """Ask a card's contact to check it: make a new personal link and send it if a mail server
        is set up. Any earlier link for the card stops working."""
        email = email.strip()
        if not EMAIL.fullmatch(email):
            raise ReviewError(f'"{email}" is not an email address.')
        template = self.settings()
        token = secrets.token_urlsafe(32)
        expires = now() + timedelta(days=LINK_DAYS)
        link = f"{site.rstrip('/')}/#/validate/{token}"
        subject, body = write_message(template["subject"], template["body"], name=name, card=title, card_type=card_type,
                                      link=link, until=f"{expires:%B} {expires.day}, {expires.year}")
        sent, problem = False, ""
        if mail.configured:
            try:
                send_email(mail, email, subject, body)
                sent = True
            except ReviewError as error:
                problem = str(error)
        else:
            problem = "no mail server is set up on this site"
        with self._lock:
            review = self._data["reviews"].setdefault(card_id, {})
            history = review.get("history", [])
            review.clear()
            review.update(status="requested", email=email, name=name.strip(), token=token, link=link,
                          requested_at=now().isoformat(timespec="seconds"), expires_at=expires.isoformat(timespec="seconds"),
                          email_sent=sent, email_problem=problem, subject=subject, body=body, history=history)
            self._note(review, f"asked {email}: " + ("email sent" if sent else f"email not sent ({problem})"))
            self._save()
            return json.loads(json.dumps(review))

    def answer(self, token: str, *, correct: bool, name: str, comment: str, card_fingerprint: str) -> dict[str, Any]:
        """The contact's answer, given on the page behind the personal link."""
        found = self.by_token(token)
        if found is None:
            raise ReviewError("This link is no longer valid.")
        card_id, _ = found
        comment = comment.strip()[:4000]
        if not correct and not comment:
            raise ReviewError("Please say what needs to change.")
        with self._lock:
            review = self._data["reviews"][card_id]
            if review.get("status") == "approved":
                raise ReviewError("This card has already been marked as author-reviewed.")
            review.update(status="confirmed" if correct else "changes", answered_at=now().isoformat(timespec="seconds"),
                          answered_by=name.strip()[:200], comment=comment, fingerprint=card_fingerprint)
            self._note(review, "the contact said the card is correct" if correct else "the contact asked for changes")
            self._save()
            return json.loads(json.dumps(review))

    def approve(self, card_id: str, current_fingerprint: str) -> dict[str, Any]:
        """The administrator's final OK, possible once the contact has said the card is correct."""
        with self._lock:
            review = self._data["reviews"].get(card_id)
            if not review or review.get("status") != "confirmed":
                raise ReviewError("The contact has not confirmed this card yet.")
            if review.get("fingerprint") != current_fingerprint:
                raise ReviewError("The card has changed since the contact confirmed it. Ask them again.")
            review.update(status="approved", approved_at=now().isoformat(timespec="seconds"))
            self._note(review, "final OK given: marked as author-reviewed")
            self._save()
            return json.loads(json.dumps(review))

    def mark_by_hand(self, card_id: str, current_fingerprint: str, note: str) -> dict[str, Any]:
        """Mark a card as author-reviewed without the email, for example when the author wrote
        the card or confirmed it some other way. The reason is kept."""
        note = note.strip()[:500]
        if not note:
            raise ReviewError("Say how you know the author reviewed this card.")
        with self._lock:
            review = self._data["reviews"].setdefault(card_id, {})
            history = review.get("history", [])
            review.clear()
            review.update(status="approved", by_hand=True, note=note, fingerprint=current_fingerprint,
                          approved_at=now().isoformat(timespec="seconds"), history=history)
            self._note(review, f"marked as author-reviewed by hand: {note}")
            self._save()
            return json.loads(json.dumps(review))

    def clear(self, card_id: str) -> None:
        """Forget a card's review: the mark goes, and its personal link stops working."""
        with self._lock:
            if self._data["reviews"].pop(card_id, None) is not None:
                self._save()
