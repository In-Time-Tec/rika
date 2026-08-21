#!/bin/sh
if [ "$RIKA_INTERNAL_LOCAL_EXECUTOR" = "1" ]; then
  role="local-executor"
else
  role="tui-controller"
fi
printf '%s|%s\n' "$role" "$*" >> "$RIKA_TEST_ROLE_LOG"
if [ "$role" = "tui-controller" ]; then
  sleep 0.1
else
  trap 'printf "%s\n" "local-executor-stopped" >> "$RIKA_TEST_ROLE_LOG"; exit 0' TERM
  sleep 10
fi
