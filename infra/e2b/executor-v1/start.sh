#!/bin/sh
set -eu

umask 077
sudo -n /usr/bin/install -d -m 2750 -o rika-executor -g rika-workspace /run/rika
if [ -s /run/e2b/.E2B_SANDBOX_ID ]; then
  E2B_SANDBOX_ID="$(cat /run/e2b/.E2B_SANDBOX_ID)"
elif [ -z "${E2B_SANDBOX_ID:-}" ]; then
  E2B_SANDBOX_ID="template-readiness"
fi
export E2B_SANDBOX_ID
exec bun run /opt/rika/packages/remote-execution/src/host.ts
