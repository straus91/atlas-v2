import dataclasses

import pytest
from fastapi.testclient import TestClient

from app import library, main, review
from test_library import DATASET, IDS, fake_atlas

PASSWORD = "only-for-these-tests"
MAIL = review.Mail(host="mail.example.org", sender="atlas@example.org")


@pytest.fixture
def site(tmp_path, monkeypatch):
    """The site with two cards, an admin password and a mail server that only records what it is given."""
    library.reset_for_tests()
    library.configure(tmp_path)
    library.refresh_library(fake_atlas(), pause=0)
    sent: list[dict] = []
    monkeypatch.setattr(review, "send_email", lambda mail, to, subject, body: sent.append({"to": to, "subject": subject, "body": body}))
    monkeypatch.setattr(main, "reviews", review.Reviews(tmp_path / "reviews.json"))
    monkeypatch.setattr(main, "settings", dataclasses.replace(main.settings, admin_password=PASSWORD, mail=MAIL, site_url="https://atlas.example.org"))
    main._sessions.clear()
    main._failed_logins.clear()
    yield TestClient(main.app), sent
    library.reset_for_tests()


def sign_in(client: TestClient) -> None:
    assert client.post("/api/admin/login", json={"password": PASSWORD}).status_code == 200


def test_contacts_come_from_the_card_and_backwards_addresses_are_turned_around():
    card = {"Model": {"Descriptors": {
        "Contact": "Corresponding author: Ann Lee (gro.elpmaxe@eel.nna); or lab@example.org.",
        "Authors": [{"Name": "Ann Lee", "Email": "ann.lee@example.org"}, {"Name": "Bo Kim", "Email": "bo@example.org"}, {"Name": "No Mail"}]}}}
    found = review.contacts_of(card)
    assert [person["email"] for person in found] == ["ann.lee@example.org", "lab@example.org", "bo@example.org"]
    assert found[0]["name"] == "Ann Lee" and "backwards" in found[0]["source"]
    assert review.contacts_of({"Dataset": {"Descriptors": {"Contact": "Radiology department, no address given"}}}) == []
    assert review.contacts_of({"Dataset": {}}) == []


def test_the_whole_review_from_request_to_the_public_mark(site):
    client, sent = site
    card_id = IDS[0]
    assert client.get("/api/admin/reviews").status_code == 401                      # the admin view needs the password
    assert client.post("/api/admin/login", json={"password": "wrong"}).status_code == 401
    sign_in(client)

    # nothing can be sent until validation emails are switched on
    ask = {"cards": [{"id": card_id, "email": "jane@example.org", "name": "Jane Doe"}]}
    assert client.post("/api/admin/reviews/request", json=ask).status_code == 400
    assert client.put("/api/admin/settings", json={"emails_enabled": True}).json()["emails_enabled"]
    result = client.post("/api/admin/reviews/request", json=ask).json()["results"][0]
    assert result == {"id": card_id, "ok": True, "sent": True, "problem": ""}

    [message] = sent
    assert message["to"] == "jane@example.org" and "Liver MRI set" in message["subject"]
    assert "Dear Jane Doe," in message["body"] and "dataset card" in message["body"]
    link = next(word for word in message["body"].split() if word.startswith("https://atlas.example.org/#/validate/"))
    token = link.rsplit("/", 1)[1]

    row = next(row for row in client.get("/api/admin/reviews").json()["cards"] if row["id"] == card_id)
    assert row["review"]["status"] == "requested" and row["review"]["link"] == link and "token" not in row["review"]

    # the contact opens the link without signing in, sees the card, and must say what is wrong to ask for changes
    anyone = TestClient(main.app)
    page = anyone.get(f"/api/validate/{token}").json()
    assert page["status"] == "requested" and page["record"]["card"] == DATASET
    assert anyone.get("/api/validate/not-a-link").status_code == 404
    assert anyone.post(f"/api/validate/{token}", json={"correct": False}).status_code == 400
    assert anyone.post(f"/api/validate/{token}", json={"correct": False, "comment": "The licence is wrong."}).json()["status"] == "changes"
    assert client.post(f"/api/admin/reviews/{card_id}/approve").status_code == 400     # not confirmed: no final OK
    assert anyone.post(f"/api/validate/{token}", json={"correct": True, "name": "Jane Doe"}).json()["status"] == "confirmed"

    # the contact's yes alone does not show the mark; the administrator's final OK does
    assert client.get("/api/library").json()["author_reviewed"] == {}
    assert anyone.post(f"/api/admin/reviews/{card_id}/approve").status_code == 401
    assert client.post(f"/api/admin/reviews/{card_id}/approve").json()["review"]["status"] == "approved"
    marks = client.get("/api/library").json()["author_reviewed"]
    assert list(marks) == [card_id] and marks[card_id] == main.reviews.get(card_id)["approved_at"]
    assert client.get(f"/api/library/{card_id}").json()["facts"]["author_reviewed"] == marks[card_id]
    assert client.get(f"/api/library/{IDS[1]}").json()["facts"]["author_reviewed"] is None
    assert anyone.post(f"/api/validate/{token}", json={"correct": True}).status_code == 400   # nothing to answer any more

    # the mark survives a restart, and removing it also retires the link
    again = review.Reviews(main.reviews._path)
    assert again.get(card_id)["status"] == "approved"
    assert client.delete(f"/api/admin/reviews/{card_id}").status_code == 200
    assert client.get("/api/library").json()["author_reviewed"] == {}
    assert anyone.get(f"/api/validate/{token}").status_code == 404


def test_a_changed_card_loses_its_mark(site):
    client, _ = site
    sign_in(client)
    card_id = IDS[1]
    assert client.post(f"/api/admin/reviews/{card_id}/mark", json={"note": " "}).status_code == 400   # the reason is required
    assert client.post(f"/api/admin/reviews/{card_id}/mark", json={"note": "The author wrote the card."}).status_code == 200
    assert card_id in client.get("/api/library").json()["author_reviewed"]

    with library._lock:                                         # ATLAS publishes a new version of the card
        library._records[card_id]["card"]["Model"]["Name"] = "FractureNet 2"
    assert client.get("/api/library").json()["author_reviewed"] == {}
    row = next(row for row in client.get("/api/admin/reviews").json()["cards"] if row["id"] == card_id)
    assert row["review"]["status"] == "approved" and row["review"]["changed"]


def test_without_a_mail_server_a_link_is_made_but_nothing_is_sent(site):
    client, sent = site
    main.settings = dataclasses.replace(main.settings, mail=review.Mail())
    sign_in(client)
    client.put("/api/admin/settings", json={"emails_enabled": True})
    result = client.post("/api/admin/reviews/request", json={"cards": [
        {"id": IDS[0], "email": "jane@example.org"}, {"id": IDS[1], "email": "not an address"}, {"id": "gone", "email": "x@example.org"}]})
    first, second, third = result.json()["results"]
    assert first["ok"] and not first["sent"] and "no mail server" in first["problem"]
    assert not second["ok"] and not third["ok"] and sent == []
    state = main.reviews.get(IDS[0])
    assert state["link"].startswith("https://atlas.example.org/#/validate/") and "Dear colleague," in state["body"]


def test_the_message_can_be_rewritten_but_always_carries_the_link(site):
    client, sent = site
    sign_in(client)
    assert client.put("/api/admin/settings", json={"body": "No link here."}).status_code == 400
    changed = client.put("/api/admin/settings", json={"emails_enabled": True, "subject": "About {card}", "body": "Hello {name}, see {link}"}).json()
    assert changed["body"] == "Hello {name}, see {link}" and changed["standard_body"] == review.DEFAULT_BODY
    client.post("/api/admin/reviews/request", json={"cards": [{"id": IDS[0], "email": "jane@example.org", "name": "Jane"}]})
    assert sent[0]["subject"] == "About Liver MRI set" and sent[0]["body"].startswith("Hello Jane, see https://atlas.example.org/#/validate/")


def test_the_admin_view_is_off_without_a_password_and_locks_after_wrong_guesses(site):
    client, _ = site
    for _ in range(5):
        assert client.post("/api/admin/login", json={"password": "guess"}).status_code == 401
    assert client.post("/api/admin/login", json={"password": PASSWORD}).status_code == 429
    main.settings = dataclasses.replace(main.settings, admin_password="")
    assert client.get("/api/admin/session").json() == {"configured": False, "signed_in": False}
    assert client.post("/api/admin/login", json={"password": ""}).status_code == 503
    assert client.get("/api/admin/reviews").status_code == 503
