#!/bin/sh
set -eu

case "${RIKA_BENCHMARK_FIXTURE_MODE:-complete}" in
  false-end)
    printf '\033[?2026lnot a frame'
    sleep 30
    ;;
  timeout)
    trap 'rm -f "$RIKA_BENCHMARK_FIXTURE_LOCK"; exit 0' TERM INT
    if ! (set -C; : > "$RIKA_BENCHMARK_FIXTURE_LOCK") 2>/dev/null; then
      printf 'overlap' >> "$RIKA_BENCHMARK_FIXTURE_RESULT"
      exit 9
    fi
    while :; do sleep 1; done
    ;;
  stubborn-descendant)
    if test -f "$RIKA_BENCHMARK_FIXTURE_LOCK"; then
      previous_pid=$(cat "$RIKA_BENCHMARK_FIXTURE_LOCK")
      if kill -0 "$previous_pid" 2>/dev/null; then
        printf 'overlap\n' >> "$RIKA_BENCHMARK_FIXTURE_RESULT"
        exit 9
      fi
    fi
    : > "$RIKA_BENCHMARK_FIXTURE_LOCK"
    sh -c 'trap "" TERM INT HUP; printf "%s\n" "$$" > "$RIKA_BENCHMARK_FIXTURE_LOCK"; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &
    while ! test -s "$RIKA_BENCHMARK_FIXTURE_LOCK"; do sleep 0.01; done
    printf 'started\n' >> "$RIKA_BENCHMARK_FIXTURE_RESULT"
    printf '\033[?2026hfixture frame\033[?2026l'
    sleep 30
    ;;
  *)
    printf '\033[?2026lfalse end\033[?2026hfixture frame'
    printf ' complete\033[?2026l'
    sleep 30
    ;;
esac
