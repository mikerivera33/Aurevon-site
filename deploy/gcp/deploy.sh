#!/bin/bash
# Upload the committed discord/ folder as the bot bundle. The VM picks up a new
# upload within ~2 minutes: it re-reads the env secret, runs `npm ci` and
# restarts the bot. Re-running with no code change still redeploys, which is
# how a secret change takes effect.
#
#   PROJECT=<project-id> deploy/gcp/deploy.sh [git-ref]   (default ref: HEAD)
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT=<gcp project id>}"
REF="${1:-HEAD}"
SHA="$(git rev-parse --short "$REF")"
OUT="$(mktemp -d)/discord-bot.tgz"

git archive --format=tar.gz -o "$OUT" "$REF:discord"
gcloud --project "$PROJECT" --quiet storage cp "$OUT" "gs://${PROJECT}-aurevon-bot/discord-bot.tgz" \
  --custom-metadata="git-sha=$SHA"
rm -f "$OUT"
echo "Uploaded discord/ at $SHA. The VM installs it within ~2 minutes."
