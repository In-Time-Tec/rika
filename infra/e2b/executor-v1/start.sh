#!/bin/sh
set -eu

umask 077
if [ -z "${E2B_SANDBOX_ID:-}" ]; then
  E2B_SANDBOX_ID="$(cat /run/e2b/.E2B_SANDBOX_ID)"
fi
export E2B_SANDBOX_ID
exec bun run /opt/rika/src/host.ts
