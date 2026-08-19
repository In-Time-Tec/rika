#!/bin/sh
set -eu

umask 077
if [ -z "${RIKA_EXECUTOR_INSTANCE_ID:-}" ]; then
  if [ -n "${E2B_SANDBOX_ID:-}" ]; then
    RIKA_EXECUTOR_INSTANCE_ID="$E2B_SANDBOX_ID"
  else
    RIKA_EXECUTOR_INSTANCE_ID="$(cat /run/e2b/.E2B_SANDBOX_ID)"
  fi
fi
export RIKA_EXECUTOR_INSTANCE_ID
exec bun run /opt/rika/src/executor-host.ts
