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
| `backend/` | A small FastAPI app. `library.py` reads the cards from ATLAS's public pages (at start-up, then daily) and works out the facts to filter by. No database, no accounts, no AI calls. |
| `frontend/` | React + Vite pages, built to static files and served by the same container. |
| `backend/app/data/metric_results.json` | Result values read once from the model cards' free text by a language model, each checked to appear in that text. See `backend/app/results.py`. |
| `deploy/` | Installer for the droplet that already runs the card creator. |

Where the cards come from: ATLAS has no export or public API, so `library.py` reads each public
card page, which carries the complete card. A redesign of those pages would break this; a real
ATLAS V2 would read its own database instead.

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
