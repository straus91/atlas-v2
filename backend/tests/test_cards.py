"""Drafts and published cards: what visitors see, what administrators see, and cards sent from the Creator page."""
from fastapi.testclient import TestClient

from app import library, main, review
from test_library import DATASET, IDS, MODEL
from test_review import sign_in, site  # noqa: F401 - the fixture

NEW = {"id": "new-38253604-model", "card": {"Model": {"Name": "MedSAM", "Indexing": {"Content": ["CT"]}}},
       "paper": {"title": "Segment anything in medical images", "journal": "Nat Commun", "year": "2024"}}


def ids(client: TestClient, path: str = "/api/library") -> set[str]:
    return {row["id"] for row in client.get(path).json()["cards"]}


def test_a_draft_is_hidden_from_visitors_and_administrators_publish_in_bulk(site):  # noqa: F811
    client, _ = site
    anyone = TestClient(main.app)
    sign_in(client)
    other = {**NEW, "id": "new-2-model", "card": {"Model": {"Name": "Second"}}}
    client.post("/api/admin/new-cards", json={"cards": [NEW, other]})
    assert {NEW["id"], other["id"]} <= ids(anyone)                                   # cards from a file are published

    assert anyone.post("/api/admin/cards/status", json={"ids": [NEW["id"]], "status": "draft"}).status_code == 401
    assert client.post("/api/admin/cards/status", json={"ids": [NEW["id"]], "status": "hidden"}).status_code == 400
    # any number at once; ATLAS's own cards are always published and are left alone
    assert client.post("/api/admin/cards/status", json={"ids": [NEW["id"], other["id"], IDS[0]], "status": "draft"}).json() == {"changed": 2}
    assert ids(anyone) == set(IDS)
    assert anyone.get(f"/api/library/{NEW['id']}").status_code == 404                # not even by its address
    assert anyone.get(f"/api/admin/library/{NEW['id']}").status_code == 401
    assert anyone.get("/api/admin/library").status_code == 401

    seen = {row["id"]: row for row in client.get("/api/admin/library").json()["cards"]}
    assert seen[NEW["id"]]["draft"] and not seen[IDS[0]]["draft"]
    assert client.get(f"/api/admin/library/{NEW['id']}").json()["facts"]["draft"]
    rows = {row["id"]: row for row in client.get("/api/admin/cards").json()["cards"]}
    assert rows[NEW["id"]]["status"] == "draft" and rows[NEW["id"]]["source"] == "file" and rows[NEW["id"]]["journal"] == "Nat Commun"
    assert IDS[0] not in rows

    # adding the file again keeps the status an administrator chose, and so does a restart
    client.post("/api/admin/new-cards", json={"cards": [NEW]})
    assert NEW["id"] not in ids(anyone)
    assert client.post("/api/admin/cards/status", json={"ids": [NEW["id"]], "status": "published"}).json() == {"changed": 1}
    assert NEW["id"] in ids(anyone) and other["id"] not in ids(anyone)
    assert client.post("/api/admin/cards/remove", json={"ids": [other["id"], IDS[0], "new-nothing"]}).json() == {"removed": 1}
    assert other["id"] not in ids(client, "/api/admin/library") and IDS[0] in ids(anyone)


def test_a_card_sent_from_the_creator_waits_as_a_draft_until_it_is_published(site, monkeypatch):  # noqa: F811
    client, sent = site
    anyone = TestClient(main.app)
    monkeypatch.setattr(main, "_schema_problems", lambda card: [])
    monkeypatch.setattr(main, "_submitted_at", [])
    sign_in(client)
    client.put("/api/admin/settings", json={"admin_email": "admin@example.org"})

    assert anyone.post("/api/submissions", json={"card": {"Name": "no section"}}).status_code == 400
    assert anyone.post("/api/submissions", json={"card": MODEL, "email": "not an address"}).status_code == 400
    answer = anyone.post("/api/submissions", json={"card": MODEL, "description": "A test.", "name": " Ann  Lee ", "email": "ann@example.org"})
    assert answer.status_code == 200 and answer.json()["ok"]
    assert ids(anyone) == set(IDS)                                                   # nobody sees it yet
    assert "ann@example.org" in sent[-1]["body"] and sent[-1]["to"] == "admin@example.org" and "/#/admin/submissions" in sent[-1]["body"]

    [row] = [row for row in client.get("/api/admin/cards").json()["cards"] if row["source"] == "submission"]
    assert row["status"] == "draft" and row["submitted"]["name"] == "Ann Lee" and row["submitted"]["email"] == "ann@example.org"
    record = client.get(f"/api/admin/library/{row['id']}").json()
    assert record["card"] == MODEL and record["description"] == "A test." and record["facts"]["submission"] and "submitted" not in record

    # its contact can be asked to check it while it is still a draft
    client.put("/api/admin/settings", json={"emails_enabled": True})
    client.post("/api/admin/reviews/request", json={"cards": [{"id": row["id"], "email": "ann@example.org", "name": "Ann Lee"}]})
    token = main.reviews.get(row["id"])["link"].rsplit("/", 1)[1]
    assert anyone.get(f"/api/validate/{token}").json()["record"]["card"] == MODEL

    client.post("/api/admin/cards/status", json={"ids": [row["id"]], "status": "published"})
    published = anyone.get(f"/api/library/{row['id']}").json()
    assert published["facts"]["origin"] == "new" and "submitted" not in published and "ann@example.org" not in str(published["facts"])
    # "remove all new cards" takes out the cards from a file, never what people sent
    client.post("/api/admin/new-cards", json={"cards": [NEW]})
    assert client.delete("/api/admin/new-cards").json()["removed"] == 1
    assert row["id"] in ids(anyone)

    # a card that does not fit the schema is refused in words, and so is a flood
    monkeypatch.setattr(main, "_schema_problems", lambda card: ["Model › Name: is required"])
    refused = anyone.post("/api/submissions", json={"card": MODEL})
    assert refused.status_code == 400 and "is required" in refused.json()["detail"]

    def unreachable(card):
        raise review.ReviewError("The corrected card could not be checked against the ATLAS schema, because the card creator did not answer (URLError). Nothing was published; try again.")
    monkeypatch.setattr(main, "_schema_problems", unreachable)
    assert "Nothing was sent" in anyone.post("/api/submissions", json={"card": MODEL}).json()["detail"]
    monkeypatch.setattr(main, "_schema_problems", lambda card: [])
    monkeypatch.setattr(main, "SUBMISSIONS_PER_HOUR", 0)
    assert anyone.post("/api/submissions", json={"card": DATASET}).status_code == 429


def test_every_card_names_the_journal_of_its_paper_in_full():
    refs = [{"Title": "no source"}, {"Source": "Radiology: Artificial Intelligence. 2023;5(2):e220132"}]
    assert library.journal_of({}, refs) == "Radiology: Artificial Intelligence"
    assert library.journal_of({"journal": "Sci Data"}, refs) == "Scientific Data"            # the paper a new card was drafted from comes first
    assert library.journal_of({}, [{"Source": "Radiol Artif Intell"}]) == "Radiology: Artificial Intelligence"
    assert library.journal_of({}, [{"Source": "Radiology: Artificial Intelligence. 2024 Jan;6(1):e230132. Published"}]) == "Radiology: Artificial Intelligence"
    assert library.journal_of({}, [{"Source": "arXiv preprint arXiv:1711.05225"}]) == "arXiv"
    assert library.journal_of({}, [{"Source": "medRxiv 2021.02.26.21252537 [preprint]"}]) == "medRxiv"
    assert library.journal_of({}, [{"Source": "2017 IEEE Conference on Computer Vision and Pattern Recognition"}]) == "IEEE Conference on Computer Vision and Pattern Recognition"
    assert library.journal_of({}, []) == "" and library.journal_of({}, ["not a reference"]) == ""
