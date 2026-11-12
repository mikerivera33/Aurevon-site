#!/usr/bin/env bash
# =============================================================================
# Aurevon Ventures LLC — Vercel environment setup (interactive)
# =============================================================================
# Prompts for each env var NAME that api/health.js checks (REQUIRED_ENV, and
# with --optional also OPTIONAL_ENV), read from that file at run time so the
# two never drift. Input is hidden and values are never printed or logged.
# docs/nft-pipeline-setup.md says what each name is and where to get it.
#
# Run locally where the Vercel CLI is authenticated (`vercel login`) and the
# project is linked (`vercel link`).
#
# Usage:
#   bash scripts/set-vercel-env.sh              # required names only
#   bash scripts/set-vercel-env.sh --optional   # required, then optional names
#
# A blank answer skips that name (an existing value is left as it is).
# Re-running is safe: a name you answer is removed, then re-added.
# Then redeploy, and check authed GET /api/health for anything still missing.
# =============================================================================

set -euo pipefail

GREEN="\033[32m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
TARGETS=(production preview development)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH="$ROOT/api/health.js"

need_cli() {
  command -v vercel >/dev/null 2>&1 || { echo "Vercel CLI not found. Install: npm i -g vercel"; exit 1; }
}

# Quoted names inside `const <LIST> = [ … ];` in api/health.js.
names_from() {
  awk -v list="$1" '
    $0 ~ "const " list " = \\[" { inside = 1; next }
    inside && /\];/ { exit }
    inside {
      sub(/\/\/.*/, "")
      while (match($0, /'\''[A-Z0-9_]+'\''/)) {
        print substr($0, RSTART + 1, RLENGTH - 2)
        $0 = substr($0, RSTART + RLENGTH)
      }
    }
  ' "$HEALTH"
}

set_var() {
  local key="$1" val="$2"
  for env in "${TARGETS[@]}"; do
    vercel env rm "$key" "$env" -y >/dev/null 2>&1 || true
    if printf '%s' "$val" | vercel env add "$key" "$env" >/dev/null 2>&1; then
      echo -e "  ${GREEN}✓${RESET} $key ($env)"
    else
      echo -e "  ${YELLOW}!${RESET} $key ($env) — failed (check auth/link)"
    fi
  done
}

prompt_list() {
  local list="$1" names name val
  names="$(names_from "$list")"
  if [[ -z "$names" ]]; then
    echo "Could not read $list from api/health.js — aborting." >&2
    exit 1
  fi
  echo -e "\n${BOLD}${list}${RESET} (blank = skip; input is hidden)"
  while IFS= read -r name; do
    val=""
    read -r -s -p "  $name: " val </dev/tty || true
    echo
    [[ -n "$val" ]] && set_var "$name" "$val"
  done <<< "$names"
  val=""
}

need_cli
prompt_list REQUIRED_ENV
if [[ "${1:-}" == "--optional" ]]; then
  prompt_list OPTIONAL_ENV
fi

echo -e "\n${BOLD}Done.${RESET} Redeploy to apply:  ${BOLD}vercel --prod${RESET}"
echo "Then check: authed GET /api/health (see docs/nft-pipeline-setup.md, O11)."
