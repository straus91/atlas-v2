# ATLAS V2 (proposal)

A working proposal for how [RSNA ATLAS](https://atlas.rsna.org) could present its model and
dataset cards. It is not the official ATLAS site and stores no cards of its own: it reads the
cards ATLAS publishes and shows them differently.

- **Browse**: every published card, with a search box and filters that stay at the top of the
  screen (type, modality, subspecialty, task, population, year, metric, license, size). List
  and grid views; the list's columns follow the type (patients, exams, images and sites for
  datasets; task and results for models). Each row has a download button and a button that
  opens the dataset or publication.
- **Card page**: a summary of the facts a reader chooses by, then every section the card
  contains, with partitions and results as tables.
- **Overview**: what the library covers and where it is thin (modality by subspecialty, cards
  per year, completeness, tasks, metrics). Every number is a link to those cards.
- **Author review**: a card can carry a gold star, "Author-reviewed". In the **Admin** page an
  administrator switches on validation emails, ticks cards, and their contact persons get a
  personal link. Behind it they either confirm the card with one button or go through it section
  by section in the card creator and correct what is wrong. After the administrator's final OK
  the star appears in Browse (with a filter), on the card page and as a share in the Overview,
  and a corrected card replaces the old one. Cards are published either way; the star is extra.
  See [Author review](#author-review).
- **New cards**: cards that are not on ATLAS (for example drafted from published papers) can be
  added in the Admin page as one file. They are listed with ATLAS's cards and always marked
  "New", with the paper they came from. See [New cards](#new-cards).
- **Creator**: the [ROADMAP card creator](https://github.com/straus91/roadmap-json), a separate
  project, shown in a frame as on the real ATLAS. Its "Send to ATLAS" button hands the finished
  card to this site, and "Open in the card creator" on a card page sends a card the other way.

## Run it

```bash
docker compose up --build
```

Then open http://localhost:8001. The library fills in after a minute or two, while the cards
are read from ATLAS for the first time. No API key is needed.

Settings are optional and described in [.env.example](.env.example).

## How it is put together

| Part | What it is |
|---|---|
| `backend/` | A small FastAPI app. `library.py` reads the cards from ATLAS's public pages (at start-up, then daily), holds the new cards beside them, and works out the facts to filter by. `review.py` keeps the author reviews in one small file and writes and sends the emails. No database, no AI calls; the only account is the administrator's password. |
| `frontend/` | React + Vite pages, built to static files and served by the same container. |
| `backend/app/data/metric_results.json` | Result values read once from the model cards' free text by a language model, each checked to appear in that text. See `backend/app/results.py`. |
| `deploy/` | Installer for the droplet that already runs the card creator. |

Where the cards come from: ATLAS has no export or public API, so `library.py` reads each public
card page, which carries the complete card. A redesign of those pages would break this; a real
ATLAS V2 would read its own database instead.

## Author review

Off by default. To use it, set `ADMIN_PASSWORD` in `.env` and restart; the **Admin** page then asks
for that password.

| Step | Who | What happens |
|---|---|---|
| 1 | Administrator | Switches on "Validation emails", ticks cards and confirms the list of recipients. The address comes from the card (its contact, else its authors) and can be changed. |
| 2 | Site | Makes a personal link for each card (it works for 60 days) and emails it. Without a mail server nothing is sent: the link is shown, to send by hand. |
| 3 | Contact person | Opens the link (no account; the link is the key). Either presses "I have read the card and it is correct", or chooses "Check and correct it section by section". |
| 3b | Contact person | Section by section: the card opens in the card creator, in a frame. Every section starts ticked as right. Correcting a field marks the section "Changed by you"; a section can also be unticked, with a comment on what is wrong. The work is kept on the server as they go, so they can come back with the same link. "Mark as reviewed" finishes; the card creator first confirms that the card fits the ATLAS schema. |
| 4 | Site | Writes a note to the administrator: who answered, how, and every change as before → after. |
| 5 | Administrator | Gives the final OK. Only then does everyone see the star. For a corrected card the site first checks it against the ATLAS schema once more (by asking the card creator's server), then shows the contact's version in place of the old card. |

The Admin list shows whether a contact used the quick button or went through the sections, and
for a corrected card each changed fact. The administrator can also mark a card by hand (with the
reason, which is kept), remove a mark (which also puts ATLAS's own copy back), set a corrected
card aside, or withdraw a request. The text of the email can be changed in the Admin page.

Every message the site writes, to a contact or to the administrator, is kept in the **Outbox** on
the Admin page, sent or not, so it can be read exactly as it went out. That makes the whole
flow visible on a site without a mail server.

Reviews, the contacts' corrected cards and the outbox are kept in `reviews.json` in the data
volume, next to the copy of the cards. ATLAS itself is never written to: a corrected card is
shown on this site and can be downloaded from its page.

This proposal site has no accounts for authors, so the personal link is the key. On the real
ATLAS the same page would sit behind the author's sign-in.

To send emails, give the SMTP settings of any mail provider in `.env` (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`) and set `SITE_URL` to the site's public address. On the
real ATLAS the same steps would use its own accounts and mail service.

The section-by-section check needs the card creator (`CREATOR_URL`), and the card creator must
list this site in its `EMBED_ORIGINS`. On your own computer, with both sites in Docker, also set
`CREATOR_API_URL=http://host.docker.internal:8000` so this server can reach the card creator
for the schema check; on a server the default is right.

## New cards

Cards that are not on ATLAS can be added from one JSON file: Admin → New cards → "Add cards
from a file". The file is `{"cards": [{"id": "new-…", "card": {…}, "title", "paper": {title,
journal, year, doi, pmid, pmcid, citations}}]}`; the harvest project makes it with `bundle.py`.
Adding the same file again replaces the same cards. "Remove all new cards" takes them out again.

New cards are listed in Browse and counted in the Overview with ATLAS's cards. They always carry
"New", can be filtered with More → Source, and their page says which paper they were drafted
from and that nobody has checked them against it yet (until their author has reviewed them).
They are kept in `new-cards.json` in the data volume.

## The card creator is a separate project

This site and the card creator share no code and run in separate containers at separate
addresses. They talk only through the browser, with the messages described in
[frontend/src/host.ts](frontend/src/host.ts) and in the card creator's `docs/send-to-atlas.md`.
For the hand-over to work, the card creator must list this site's address in its
`EMBED_ORIGINS` setting.

## Tests

```bash
cd backend && python -m pytest -q
cd frontend && npm test
```

## Putting it on the droplet

The site is installed next to the card creator on the same server, behind the same front-door
Caddy, at its own address. Before running the installer:

1. Create the DNS record for the address (for example `atlas-v2.pedsrad.org`) pointing at the
   server, the same way as for the card creator.
2. Make sure the card creator there is up to date (`cd /opt/card-creator && git pull && docker compose up -d --build`).

Then, in the server's console:

```bash
curl -fsSL https://raw.githubusercontent.com/straus91/atlas-v2/main/deploy/install-droplet.sh | bash
```

The installer starts the site in its own container, adds its address to Caddy with a reload
(no restart), checks that the other sites still answer as before and undoes its change if they
do not, and adds this site's address to the card creator's `EMBED_ORIGINS` so the two can
exchange cards. To use another address: `... | ATLAS_HOST=another.name.org bash`.

To update later: `cd /opt/atlas-v2 && git pull && docker compose up -d --build`.
