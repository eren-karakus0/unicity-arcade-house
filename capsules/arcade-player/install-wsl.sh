#!/usr/bin/env bash
# Stage + install the arcade-player capsule on the Astrid kernel (WSL/Linux).
#
# Usage (from WSL):
#   GEMINI_API_KEY=... ASTRID_BIN=~/astrid94/astrid-0.9.4-x86_64-unknown-linux-gnu/astrid \
#     bash install-wsl.sh
#
# NOTE on the key: the strategist's key actually ships INSIDE the locally
# built wasm (gen-local-key.mjs at build time) because on astrid 0.9.4 the
# config surface returns none to JS capsules (UPSTREAM.md finding 4). The
# [env] injection below is kept because the capsule tries runtime config
# FIRST - the moment a fixed kernel/SDK lands, this becomes the delivery and
# the baked key can be dropped. The repo copy of Capsule.toml never carries
# a key. Without GEMINI_API_KEY the capsule installs fine and plays with its
# entropy picker instead.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${STAGE_DIR:-$HOME/capsule-work/arcade-player}"
ASTRID="${ASTRID_BIN:-astrid}"

[ -f "$HERE/target/arcade-player.wasm" ] || {
  echo "error: build first (npm run build) - target/arcade-player.wasm missing" >&2
  exit 1
}

mkdir -p "$STAGE"
cp "$HERE/Capsule.toml" "$STAGE/"
cp "$HERE/target/arcade-player.wasm" "$STAGE/"

if [ -n "${GEMINI_API_KEY:-}" ]; then
  # Manifest [env] entries are EnvDef structs (a bare string fails to parse
  # with "expected struct EnvDef"; `type` is required - discovered empirically
  # via `astrid capsule check` on 0.9.4). `secret` keeps the value masked.
  printf '\n[env]\nGEMINI_API_KEY = { type = "secret", default = "%s" }\n' "$GEMINI_API_KEY" >> "$STAGE/Capsule.toml"
  echo "staged with LLM strategist key ([env] injected - staged copy only)"
else
  echo "staged WITHOUT a Gemini key - the entropy picker will play"
fi

exec "$ASTRID" capsule install "$STAGE"
