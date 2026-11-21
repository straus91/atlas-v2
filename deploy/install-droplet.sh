#!/usr/bin/env bash
# Install or update ATLAS V2 (proposal) on the server that already runs the ROADMAP card
# creator behind the Caddy container of the "casedeck" project (the pedsrad-web droplet).
#
# What it does, in order:
#   1. Downloads (or updates) the code into /opt/atlas-v2.
#   2. Creates its settings file (.env). No API key is needed: this site calls no AI service.
#      If the Admin page has no password yet, asks for one (typed here, never shown).
#   3. Builds and starts it in its own container. No port is opened on the server.
#   4. Adds its address to the front-door Caddy by appending one block to the front file the
#      card creator's installer created, and reloads Caddy without restarting it. The other
#      sites are checked before and after, and the block is REMOVED again if anything changed.
#   5. Tells the card creator that this site may show it in a frame and receive cards from it.
#
# Safe to run again: it then just updates the site.
set -euo pipefail

HOST="${ATLAS_HOST:-atlas-v2.pedsrad.org}"
APP_DIR="${APP_DIR:-/opt/atlas-v2}"
CREATOR_DIR="${CREATOR_DIR:-/opt/card-creator}"
CREATOR_HOST="${CREATOR_HOST:-card-creator.pedsrad.org}"
CASEDECK_DIR="${CASEDECK_DIR:-/home/deploy/casedeck}"
BRANCH="${BRANCH:-main}"
REPO="${REPO:-https://github.com/straus91/atlas-v2.git}"
NETWORK="card-creator-front"      # the small network the front-door Caddy already shares with the card creator
MARK="# --- ATLAS V2 (https://github.com/straus91/atlas-v2) ---"

say()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "run this as root (the web console already is)."
command -v docker >/dev/null || fail "Docker is not installed."
command -v git >/dev/null || fail "git is not installed."
FRONT="$CASEDECK_DIR/caddy/Caddyfile.front"
[ -f "$FRONT" ] || fail "$FRONT was not found. Install the card creator first; its installer creates that file."
CADDY="$(cd "$CASEDECK_DIR" && docker compose ps -q caddy)"
[ -n "$CADDY" ] || fail "the front-door Caddy container is not running."
docker network inspect "$NETWORK" >/dev/null 2>&1 || fail "the network $NETWORK does not exist. Install the card creator first."

# ---------------------------------------------------------------- 1. the code
say "Getting the code into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    git -C "$APP_DIR" checkout --quiet "$BRANCH"
    git -C "$APP_DIR" merge --quiet --ff-only "origin/$BRANCH"
else
    git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
echo "    version: $(git log -1 --format='%h %s')"

# ---------------------------------------------------------------- 2. settings
if [ ! -f .env ]; then
    say "Creating the settings file"
    cp .env.example .env
    sed -i -E "s|^CREATOR_URL=.*|CREATOR_URL=https://${CREATOR_HOST}|" .env
    printf '\n# This server: also apply deploy/docker-compose.droplet.yml (no open port, private network).\nCOMPOSE_FILE=docker-compose.yml:deploy/docker-compose.droplet.yml\n' >> .env
fi
grep -q '^COMPOSE_FILE=' .env || printf '\nCOMPOSE_FILE=docker-compose.yml:deploy/docker-compose.droplet.yml\n' >> .env

# Replace (or add) one line of the settings file without touching the others.
setting() { grep -vE "^$1=" .env > .env.next || true; printf '%s=%s\n' "$1" "$2" >> .env.next; mv -f .env.next .env; }
value()   { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }

# The links in emails to authors must carry this site's public address.
[ -n "$(value SITE_URL)" ] || setting SITE_URL "https://$HOST"

# The Admin page (author review, new cards) stays off until it has a password. It is asked for
# here, typed where nobody sees it, and written only to the settings file on this server.
if [ -z "$(value ADMIN_PASSWORD)" ]; then
    if [ -r /dev/tty ]; then
        say "The Admin page needs a password of your choice"
        echo "    At least 10 characters: letters, digits and . _ - only. Nothing shows while you type."
        echo "    Press Enter without typing to leave the Admin page switched off for now."
        while true; do
            printf '    Password: ' > /dev/tty
            IFS= read -r -s CHOSEN < /dev/tty || CHOSEN=""
            printf '\n' > /dev/tty
            [ -z "$CHOSEN" ] && { echo "    No password given: the Admin page stays off. Run this installer again to set one."; break; }
            if printf '%s' "$CHOSEN" | grep -qE '^[A-Za-z0-9._-]{10,}$'; then
                printf '    Once more: ' > /dev/tty
                IFS= read -r -s AGAIN_PW < /dev/tty || AGAIN_PW=""
                printf '\n' > /dev/tty
                if [ "$CHOSEN" = "$AGAIN_PW" ]; then
                    setting ADMIN_PASSWORD "$CHOSEN"
                    echo "    The Admin page is switched on."
                    break
                fi
                echo "    The two did not match. Try again."
            else
                echo "    That does not fit (10 or more of: letters, digits . _ -). Try again."
            fi
        done
        unset CHOSEN AGAIN_PW
    else
        echo "    NOTE: no keyboard is attached, so no Admin password was asked for; the Admin page stays off."
    fi
fi

# ---------------------------------------------------------------- 3. the site
say "Building and starting ATLAS V2. The first time takes a few minutes; nothing is printed until it finishes."
LOG=/tmp/atlas-v2-build.log
if ! docker compose up -d --build >"$LOG" 2>&1; then
    tail -n 30 "$LOG"
    fail "the site could not be built or started (see the lines above; full log in $LOG). Nothing else was changed."
fi
APP="$(docker compose ps -q atlas)"
STATE=none
for _ in $(seq 1 40); do
    STATE="$(docker inspect --format '{{.State.Health.Status}}' "$APP" 2>/dev/null || echo none)"
    [ "$STATE" = healthy ] && break
    sleep 3
done
[ "$STATE" = healthy ] || { docker compose logs --tail 30 atlas; fail "the site did not start correctly (see the lines above). Nothing else was changed."; }
echo "    the site is running"

# ---------------------------------------------------------------- 4. the front door
reload() { docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -n 3; }
SITES="$(docker exec "$CADDY" sh -c 'printenv CASEDECK_HOST PEDSRAD_HOST PROGRAM_HOST 2>/dev/null' | grep -vE 'localhost$|^$' || true) $CREATOR_HOST"
probe() { curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$1/" 2>/dev/null || true; }
BEFORE=""; for site in $SITES; do BEFORE="$BEFORE $site=$(probe "$site")"; done
echo "    sites served now:$BEFORE"

if grep -qF "$MARK" "$FRONT" && grep -q "^$HOST {" "$FRONT"; then
    say "Caddy already serves $HOST; nothing to change there"
else
    say "Adding $HOST to the front-door Caddy (one block appended to Caddyfile.front; Caddy is reloaded, not restarted)"
    KEEP="$(mktemp)"; cat "$FRONT" > "$KEEP"
    # Written with >> and "cat >" so the file itself stays the same one Caddy has mounted.
    printf '\n%s\n%s {\n\tencode zstd gzip\n\treverse_proxy atlas-v2:8000\n}\n' "$MARK" "$HOST" >> "$FRONT"

    undo() {
        echo
        echo "UNDOING the Caddy change: $1"
        cat "$KEEP" > "$FRONT"
        reload || true
        sleep 5
        AGAIN=""; for site in $SITES; do AGAIN="$AGAIN $site=$(probe "$site")"; done
        echo "    sites after undoing:$AGAIN"
        fail "ATLAS V2 was NOT added to Caddy; the front file is back as it was. The site itself is still running, unreachable from outside. Send this whole output to whoever is helping you."
    }

    reload || undo "Caddy did not accept the new block"
    AFTER=""
    for _ in 1 2 3 4 5 6; do
        sleep 5
        AFTER=""; for site in $SITES; do AFTER="$AFTER $site=$(probe "$site")"; done
        [ "$AFTER" = "$BEFORE" ] && break
    done
    echo "    sites served after:$AFTER"
    [ "$AFTER" = "$BEFORE" ] || undo "the existing sites answer differently than before"
    rm -f "$KEEP"
fi

# ---------------------------------------------------------------- 5. let the card creator hand cards to this site
if [ -f "$CREATOR_DIR/.env" ]; then
    WANT="https://$HOST"
    NOW="$(grep -E '^EMBED_ORIGINS=' "$CREATOR_DIR/.env" | tail -n 1 | cut -d= -f2- || true)"
    case ",$NOW," in
        *",$WANT,"*) echo; echo "==> The card creator already allows $WANT" ;;
        *)
            say "Allowing the card creator to be shown inside $WANT and to send cards to it"
            NEW="${NOW:-https://atlas.rsna.org},$WANT"
            if grep -qE '^EMBED_ORIGINS=' "$CREATOR_DIR/.env"; then
                sed -i -E "s|^EMBED_ORIGINS=.*|EMBED_ORIGINS=${NEW}|" "$CREATOR_DIR/.env"
            else
                printf '\n# Sites that may show the card creator in a frame and receive cards from it.\nEMBED_ORIGINS=%s\n' "$NEW" >> "$CREATOR_DIR/.env"
            fi
            (cd "$CREATOR_DIR" && docker compose up -d 2>&1 | tail -n 2)
            ;;
    esac
else
    echo
    echo "NOTE: the card creator was not found in $CREATOR_DIR, so its EMBED_ORIGINS setting was not changed."
    echo "      Add https://$HOST to that setting wherever the card creator runs, or the Creator page cannot receive cards."
fi

# ---------------------------------------------------------------- 6. check from outside
say "Checking https://$HOST (the first secure certificate can take a minute)"
CODE=000
for _ in $(seq 1 30); do
    CODE="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$HOST/api/health" 2>/dev/null || true)"
    [ "$CODE" = 200 ] && break
    sleep 5
done
if [ "$CODE" = 200 ]; then
    printf '\nDONE. ATLAS V2 is live at https://%s\n' "$HOST"
    echo "The library fills in by itself over the next minute or two (the cards are being read from ATLAS)."
    echo "To update it later:  cd $APP_DIR && git pull && docker compose up -d --build"
    [ -z "$(value ADMIN_PASSWORD)" ] || echo "Admin page: https://$HOST/#/admin (author review, the outbox, and adding new cards from a file)."
    [ -n "$(value SMTP_HOST)" ] || echo "No mail server is set, so emails to authors are written to the Admin outbox instead of sent (see .env.example to set one)."
else
    printf '\nThe site and Caddy are running, but https://%s answered "%s" instead of 200.\n' "$HOST" "$CODE"
    echo "Existing sites are unaffected. Often this is the certificate still being issued, or the DNS"
    echo "record for $HOST not existing yet: try the address in a browser in a few minutes."
    docker logs --tail 40 "$CADDY" 2>&1 | grep -iE "atlas-v2|obtain|error" | tail -n 6 || true
fi
