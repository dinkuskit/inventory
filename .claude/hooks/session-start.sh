#!/usr/bin/env bash
# Prepares a Claude Code cloud session for Inventory work: the Node version CI
# pins, a lockfile install and the pinned agent skills. Local sessions are
# left alone. Every step is idempotent and a failed step is reported, not
# fatal, so the session still starts and can say what is missing.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$root" || exit 0

status=()
report() {
  printf 'Inventory cloud session setup:\n'
  printf -- '- %s\n' "${status[@]}"
}

# Node: there is no .nvmrc; CI (.github/workflows/repo-contract.yml) pins it.
want="v$(sed -n 's/^ *node-version: *//p' .github/workflows/repo-contract.yml | head -n 1 | tr -d "[:space:]\"'")"
nvm_bin="$HOME/.nvm/versions/node/$want/bin"
if [ "$(node -v 2>/dev/null)" != "$want" ] && [ -x "$nvm_bin/node" ]; then
  export PATH="$nvm_bin:$PATH"
  [ -n "${CLAUDE_ENV_FILE:-}" ] && printf 'export PATH="%s:$PATH"\n' "$nvm_bin" >> "$CLAUDE_ENV_FILE"
fi
have="$(node -v 2>/dev/null || echo none)"
if [ "$have" != "$want" ]; then
  status+=("node $have does not match CI's $want; dependencies were not installed. Fix the cloud environment's setup script.")
  report
  exit 0
fi
status+=("node $have (npm $(npm -v)), as pinned in CI")

# Dependencies: npm ci from the lockfile, skipped when node_modules was already
# installed from this exact lockfile with this Node.
stamp_file=node_modules/.session-start-stamp
stamp="$have $(sha256sum package-lock.json | cut -d' ' -f1)"
if [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$stamp" ]; then
  status+=("dependencies already match package-lock.json")
elif npm ci --no-audit --no-fund >&2; then
  printf '%s' "$stamp" > "$stamp_file"
  status+=("dependencies installed with npm ci")
else
  status+=("npm ci failed; see the hook output. Do not regenerate the lockfile to fix it.")
fi

# Pinned GrillTrack and EmDash skills into the ignored .cursor/skills/.
if ./scripts/agent-skills >&2; then
  status+=("GrillTrack CLI and EmDash skills installed (./scripts/grilltrack --project . validate)")
else
  status+=("./scripts/agent-skills failed; GrillTrack ledger reads are unavailable")
fi

report
exit 0
