#!/usr/bin/env bash
# Stage + install the arcade-player capsule on the Astrid kernel (WSL/Linux).
#
# Usage (from WSL):
#   GEMINI_API_KEY=... ASTRID_BIN=~/astrid94/astrid-0.9.4-x86_64-unknown-linux-gnu/astrid \
#     bash install-wsl.sh
#
# The LLM strategist's key is injected into the STAGED Capsule.toml as an
# [env] entry (the kernel hands [env] values to the capsule at load time via
# astrid:sys get-config). The repo copy of Capsule.toml never carries the key.
# Without GEMINI_API_KEY the capsule installs fine and plays with its entropy
# picker instead.
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
  printf '\n[env]\nGEMINI_API_KEY = "%s"\n' "$GEMINI_API_KEY" >> "$STAGE/Capsule.toml"
  echo "staged with LLM strategist key ([env] injected - staged copy only)"
else
  echo "staged WITHOUT a Gemini key - the entropy picker will play"
fi

exec "$ASTRID" capsule install "$STAGE"
