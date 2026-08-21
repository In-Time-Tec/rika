#!/bin/sh
role="$1"
root="$RIKA_TEST_ROLE_LOG"
touch "$root-$role-started"
if [ "$role" = "tui-controller" ]; then
  sleep 0.1
  touch "$root-$role-exited"
  exit 0
fi
sleep 0.2
exit 0
