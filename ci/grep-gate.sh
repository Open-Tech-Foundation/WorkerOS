#!/usr/bin/env bash
# Node-ism grep gate (INV-1 / ADR-007).
#
# The kernel must never contain Node.js concepts. This fails CI if any forbidden
# identifier appears anywhere in the kernel crate — comments included, on
# purpose: the invariant is that the kernel does not even *know* these words. All
# Node semantics belong in the guest-side node layer (workeros-programs/node).
#
# Usage: ci/grep-gate.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KERNEL_SRC="$ROOT/crates/workeros-kernel/src"

# Whole-word, case-insensitive. Add here only with a corresponding ADR.
FORBIDDEN=(
  "require"
  "node_modules"
  "express"
  "commonjs"
  "__dirname"
  "__filename"
)

status=0
for word in "${FORBIDDEN[@]}"; do
  # -w whole word, -n line numbers, -r recursive, -i case-insensitive.
  if matches="$(grep -rniw --include='*.rs' "$word" "$KERNEL_SRC" 2>/dev/null)"; then
    echo "FORBIDDEN Node-ism '$word' found in kernel crate:" >&2
    echo "$matches" >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "grep-gate: OK — no Node-isms in workeros-kernel."
fi
exit "$status"
