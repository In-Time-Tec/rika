#!/bin/sh
if [ "$RIKA_INTERNAL_LOCAL_EXECUTOR" = "1" ]; then
  role="local-executor"
else
  role="tui-controller"
fi
printf '%s|%s\n' "$role" "$*" >> "$RIKA_TEST_ROLE_LOG"
if [ "$role" = "tui-controller" ]; then
  if [ "$RIKA_TEST_TUI_FAILURE" = "1" ]; then
    printf '%s\n' 'Railway is unavailable' >&2
    exit 1
  fi
  sleep 0.1
else
  trap 'printf "%s\n" "local-executor-stopped" >> "$RIKA_TEST_ROLE_LOG"; exit 0' TERM
  sleep 10
fi
