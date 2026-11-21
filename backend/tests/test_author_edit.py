"""The contact corrects the card themselves, and cards that are not on ATLAS are added as new."""
import copy

from fastapi.testclient import TestClient

from app import library, main, review
from test_library import DATASET, IDS, MODEL
from test_review import sign_in, site  # noqa: F401 - the fixture


def ask(client: TestClient, card_id: str) -> str:
    """Ask a card's contact; returns the key of their personal link."""
    client.put("/api/admin/settings", json={"emails_enabled": True})
    client.post("/api/admin/reviews/request", json={"cards": [{"id": card_id, "email": "jane@example.org", "name": "Jane Doe"}]})
    return main.reviews.get(card_id)["link"].rsplit("/", 1)[1]


def corrected() -> dict:
    card = copy.deepcopy(DATASET)
    card["Dataset"]["Descriptors"]["License"]["Text"] = "CC BY-NC 4.0"
    card["Dataset"]["Partitions"][2]["Total"]["Patient count"] = 200
    return card


def test_differences_name_each_changed_fact_and_ignore_empty_fields_and_key_order():
    same = {"Dataset": {"Link": "https://example.org/d", "Name": " Liver MRI set ", "Version": "", **{
        key: value for key, value in DATASET["Dataset"].items() if key not in ("Name", "Link")}}}
    assert review.differences(DATASET, same) == []
    card = corrected()
    card["Dataset"]["Indexing"]["Keywords"].append("children")
    del card["Dataset"]["Descriptors"]["Comments"]
    assert review.differences(DATASET, card) == [
        {"where": "Indexing › Keywords", "before": "liver, segmentation", "after": "liver, segmentation, children"},
        {"where": "Descriptors › License › Text", "before": "CC BY 4.0", "after": "CC BY-NC 4.0"},
        {"where": "Descriptors › Comments", "before": "A set of liver MRI studies.", "after": ""},
        {"where": "Partitions › 3 › Total › Patient count", "before": "150", "after": "200"},
    ]


def test_the_contact_corrects_the_card_and_the_final_ok_publishes_their_version(site, monkeypatch):  # noqa: F811
    client, sent = site
    sign_in(client)
    card_id = IDS[0]
    token = ask(client, card_id)
    client.put("/api/admin/settings", json={"admin_email": "admin@example.org"})
    anyone = TestClient(main.app)

    # their work is kept while they go, and they see what they changed so far
    card = corrected()
    assert anyone.put(f"/api/validate/{token}/draft", json={"card": MODEL, "flagged": []}).status_code == 400   # not this kind of card
    draft = anyone.put(f"/api/validate/{token}/draft", json={"card": card, "flagged": ["Imaging"]}).json()
    assert [row["where"] for row in draft["differences"]] == ["Descriptors › License › Text", "Partitions › 3 › Total › Patient count"]
    page = anyone.get(f"/api/validate/{token}").json()
    assert page["status"] == "requested" and page["draft"]["card"] == card and page["draft"]["flagged"] == ["Imaging"]
    assert page["record"]["card"] == DATASET                                       # the published card is untouched
    row = next(row for row in client.get("/api/admin/reviews").json()["cards"] if row["id"] == card_id)
    assert row["review"]["working"] and "draft" not in row["review"]

    # a section marked as not right needs a word of explanation; then the answer arrives as a corrected card
    answer = {"correct": True, "name": "Jane Doe", "card": card, "flagged": ["Imaging"]}
    assert anyone.post(f"/api/validate/{token}", json=answer).status_code == 400
    assert anyone.post(f"/api/validate/{token}", json={**answer, "comment": "The scanner list is incomplete."}).json()["status"] == "edited"

    # the administrator is told, sees each change, and nothing is public yet
    notice = sent[-1]
    assert notice["to"] == "admin@example.org" and "Liver MRI set" in notice["subject"]
    assert "sent a corrected card (2 changes)" in notice["body"] and "CC BY 4.0 -> CC BY-NC 4.0" in notice["body"]
    assert "Imaging" in notice["body"] and notice["body"].rstrip().endswith("https://atlas.example.org/#/admin")
    data = client.get("/api/admin/reviews").json()
    assert [message["kind"] for message in data["outbox"]] == ["notice", "request"] and data["outbox"][0]["sent"]
    row = next(row for row in data["cards"] if row["id"] == card_id)
    assert row["review"]["status"] == "edited" and row["review"]["changes"] == 2 and row["review"]["flagged"] == ["Imaging"]
    assert row["review"]["differences"][0] == {"where": "Descriptors › License › Text", "before": "CC BY 4.0", "after": "CC BY-NC 4.0"}
    assert "revision" not in row["review"]
    assert client.get(f"/api/library/{card_id}").json()["card"] == DATASET

    # the final OK re-checks the corrected card against the schema; a card that does not fit is not published
    monkeypatch.setattr(main, "_schema_problems", lambda card: ["Descriptors › License: is not allowed"])
    refused = client.post(f"/api/admin/reviews/{card_id}/approve")
    assert refused.status_code == 400 and "does not fit the ATLAS schema" in refused.json()["detail"]
    monkeypatch.setattr(main, "_schema_problems", lambda card: [])
    assert client.post(f"/api/admin/reviews/{card_id}/approve").json()["review"]["status"] == "approved"

    # from now on the site shows the author's version, with the mark
    shown = client.get(f"/api/library/{card_id}").json()
    assert shown["card"] == card and shown["facts"]["license"] == "CC BY-NC 4.0" and shown["facts"]["author_edited"]
    listing = client.get("/api/library").json()
    listed = next(row for row in listing["cards"] if row["id"] == card_id)
    assert listed["license"] == "CC BY-NC 4.0" and listed["author_edited"] and card_id in listing["author_reviewed"]
    assert listed["title"] == "Liver MRI set"                                      # the name was not corrected, so neither is the title
    assert anyone.get(f"/api/validate/{token}").json()["record"]["card"] == card

    # removing the review puts ATLAS's own copy back
    client.delete(f"/api/admin/reviews/{card_id}")
    assert client.get(f"/api/library/{card_id}").json()["card"] == DATASET


def test_a_corrected_name_becomes_the_title_unless_atlas_gave_the_card_its_own(site, monkeypatch):  # noqa: F811
    client, _ = site
    sign_in(client)
    monkeypatch.setattr(main, "_schema_problems", lambda card: [])
    for card_id, published, expected in ((IDS[0], DATASET, "Liver MRI set, second release"), (IDS[1], MODEL, "FractureNet")):
        token = ask(client, card_id)
        card = copy.deepcopy(published)
        root = "Dataset" if "Dataset" in card else "Model"
        card[root]["Name"] = f'{card[root]["Name"]}, second release'
        if card_id == IDS[1]:
            with library._lock:                                # ATLAS lists this card under a title that is not its name
                library._records[card_id]["title"] = "FractureNet"
                library._records[card_id]["card"]["Model"]["Name"] = "FractureNet model"
        TestClient(main.app).post(f"/api/validate/{token}", json={"correct": True, "card": card})
        assert client.post(f"/api/admin/reviews/{card_id}/approve").status_code == 200
        assert client.get(f"/api/library/{card_id}").json()["facts"]["title"] == expected


def test_a_card_sent_back_unchanged_counts_as_confirmed_and_the_quick_yes_is_remembered(site):  # noqa: F811
    client, sent = site
    sign_in(client)
    token = ask(client, IDS[0])
    anyone = TestClient(main.app)
    assert anyone.post(f"/api/validate/{token}", json={"correct": True, "card": DATASET}).json()["status"] == "confirmed"
    assert main.reviews.get(IDS[0])["how"] == "sections" and "revision" not in main.reviews.get(IDS[0])
    assert anyone.post(f"/api/validate/{token}", json={"correct": True, "how": "quick"}).json()["how"] == "quick"
    assert "quick button" in main.reviews.outbox()[0]["body"]
    assert main.reviews.outbox()[0]["sent"] is False and "no address" in main.reviews.outbox()[0]["problem"]   # no admin address set


def test_the_corrected_card_cannot_be_checked_when_the_card_creator_does_not_answer(site, monkeypatch):  # noqa: F811
    client, _ = site
    sign_in(client)
    token = ask(client, IDS[0])
    TestClient(main.app).post(f"/api/validate/{token}", json={"correct": True, "card": corrected()})

    def unreachable(*args, **kwargs):
        raise OSError("connection refused")
    monkeypatch.setattr(main.urllib.request, "urlopen", unreachable)
    refused = client.post(f"/api/admin/reviews/{IDS[0]}/approve")
    assert refused.status_code == 400 and "Nothing was published" in refused.json()["detail"]
    assert client.get(f"/api/library/{IDS[0]}").json()["card"] == DATASET


def test_cards_that_are_not_on_atlas_are_added_as_new_and_can_be_removed(site, tmp_path):  # noqa: F811
    client, _ = site
    new = {"id": "new-38253604-model", "card": {"Model": {"Name": "MedSAM", "Indexing": {"Content": ["CT"]}}},
           "paper": {"title": "Segment anything in medical images", "journal": "Nat Commun", "year": "2024", "doi": "10.1038/x", "citations": "1165", "secret": "no"}}
    assert client.post("/api/admin/new-cards", json={"cards": [new]}).status_code == 401
    sign_in(client)
    assert client.post("/api/admin/new-cards", json={"cards": [{**new, "id": IDS[0]}]}).status_code == 400    # may not take an ATLAS card's place
    assert client.post("/api/admin/new-cards", json={"cards": [{"id": "new-1-model", "card": {"Name": "no section"}}]}).status_code == 400
    assert client.post("/api/admin/new-cards", json={"cards": [new]}).json() == {"added": 1, "replaced": 0, "total": 1}
    assert client.post("/api/admin/new-cards", json={"cards": [new]}).json() == {"added": 0, "replaced": 1, "total": 1}

    cards = {row["id"]: row for row in client.get("/api/library").json()["cards"]}
    assert len(cards) == 3 and cards[IDS[0]]["origin"] == "atlas" and cards[IDS[0]]["paper"] is None
    added = cards["new-38253604-model"]
    assert added["origin"] == "new" and added["title"] == "MedSAM" and added["atlas_url"] == "" and added["modalities"] == ["CT"]
    assert added["paper"] == {"title": "Segment anything in medical images", "journal": "Nat Commun", "year": "2024", "doi": "10.1038/x", "citations": "1165"}
    assert "nat commun" in added["search"]
    assert client.get("/api/admin/reviews").json()["new_cards"] == 1

    # they are still there after a restart, and after ATLAS's cards are read again
    library.configure(tmp_path)
    assert library.new_card_count() == 1 and len(library.library_index()["cards"]) == 3
    assert client.delete("/api/admin/new-cards").json() == {"removed": 1, "total": 0}
    assert len(client.get("/api/library").json()["cards"]) == 2
