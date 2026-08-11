#!/bin/zsh
# Publish this checkout to the installed Claudio app and restart the webhook.
#
# The webhook is the channel the operator talks through, so a deploy that breaks
# it takes away the means of reporting that it broke: launchd holds KeepAlive,
# and a start-up crash becomes a restart loop every ThrottleInterval seconds
# with no way in. Every step here exists to keep that from happening -- the
# syntax check runs before anything is copied, the health probe is local HTTP
# rather than a Telegram round trip, and a failed probe puts the previous files
# back and restarts again rather than leaving the loop running.

set -euo pipefail

REPO="${0:A:h}"
APP="${CLAUDIO_APP_DIR:-$HOME/Library/Application Support/Claudio/app}"
LABEL="com.aaronrusso.claudio-webhook"
PORT="${TELEGRAM_WEBHOOK_PORT:-3001}"
BACKUP="${TMPDIR:-/tmp}/claudio-deploy-$(date +%Y%m%d-%H%M%S)"
HEALTH_ATTEMPTS=20

# Runtime state that belongs to the installation, never to the checkout: the
# real credentials, the session maps the relay writes, the logs, and the
# installed dependency tree.
EXCLUDES=(
    --exclude '.git/'
    --exclude '.env'
    --exclude 'node_modules/'
    --exclude 'logs/'
    --exclude 'src/data/'
    --exclude 'CLAUDE.md'
    --exclude '.claude/'
    --exclude '.DS_Store'
)

fail() { print -u2 "✗ $1"; exit 1; }

[[ -d "$APP" ]] || fail "Claudio app directory not found: $APP"
command -v rsync >/dev/null || fail "rsync is required"

# 1. What would change, before anything changes.
print "→ files to publish"
# Compared by checksum rather than by timestamp: a checkout is full of files
# whose mtime moved and whose bytes did not, and a deploy that lists those as
# changes teaches the reader to skim the list it exists to make readable.
CHANGED=$(rsync -rnc --itemize-changes "${EXCLUDES[@]}" "$REPO/" "$APP/" | grep -E '^[<>ch]' || true)
if [[ -z "$CHANGED" ]]; then
    print "  nothing to publish; the app already matches this checkout"
    exit 0
fi
print "$CHANGED" | sed 's/^/  /'

# The itemize flags are one space-free field, so the path is everything after the
# first space -- `awk '{print $2}'` loses every path that contains one.
changed_paths() { print -r -- "$CHANGED" | sed 's/^[^ ]* //'; }
created_paths() { print -r -- "$CHANGED" | grep -E '^>f\+{9}' | sed 's/^[^ ]* //' || true; }

# 2. Refuse to ship a file that cannot parse: a start-up crash is the one
#    failure the rollback window does not cover, because launchd retries it.
#    Scoped to what is being published -- the checkout carries scripts that are
#    broken upstream and have nothing to do with the running service, and a
#    guard that blocks on those is a guard that gets bypassed.
print "→ checking syntax"
# `|| true` because a deploy that touches no .js at all is normal, and grep
# exiting 1 under pipefail used to kill the script here without saying anything.
JS_CHANGED=$(changed_paths | grep '\.js$' || true)
if [[ -z "$JS_CHANGED" ]]; then
    print "  no JavaScript in this deploy"
else
    for relative in ${(f)JS_CHANGED}; do
        node --check "$REPO/$relative" >/dev/null 2>&1 || fail "syntax error in $relative"
    done
fi

# 3. Keep the files this deploy is about to overwrite, so the rollback is exact
#    rather than a guess at what the previous version held. Files the deploy
#    creates have no previous bytes to keep, so the rollback removes them
#    instead -- restoring the backup alone would leave them behind.
print "→ backing up to $BACKUP"
mkdir -p "$BACKUP"
CREATED=$(created_paths)
for relative in ${(f)$(changed_paths)}; do
    [[ -f "$APP/$relative" ]] || continue
    mkdir -p "$BACKUP/$(dirname "$relative")"
    cp -p "$APP/$relative" "$BACKUP/$relative"
done

print "→ publishing"
rsync -rc "${EXCLUDES[@]}" "$REPO/" "$APP/"

restart() {
    launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 \
        || fail "could not restart $LABEL; check that the LaunchAgent is loaded"
}

healthy() {
    local attempt
    for attempt in {1..$HEALTH_ATTEMPTS}; do
        sleep 1
        curl --silent --fail --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    done
    return 1
}

print "→ restarting $LABEL"
restart

if healthy; then
    print "✓ webhook healthy on port $PORT"
    print "  backup kept at $BACKUP"
    exit 0
fi

# 4. The probe failed, so the new files are the suspect and they go back. Left
#    alone this is a restart loop, and the channel that would report it is the
#    one that is down.
print -u2 "✗ webhook did not come up; rolling back"
rsync -r "$BACKUP/" "$APP/"
if [[ -n "$CREATED" ]]; then
    for relative in ${(f)CREATED}; do
        rm -f "$APP/$relative"
    done
fi
restart
if healthy; then
    print -u2 "✓ rolled back to the previous files; webhook healthy again"
else
    print -u2 "✗ still unhealthy after rollback -- this is not about the published files"
    print -u2 "  logs: $HOME/Library/Application Support/Claudio/logs/telegram-webhook.err.log"
fi
exit 1
