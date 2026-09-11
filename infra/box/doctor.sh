#!/bin/sh
set -eu

binary=/usr/local/bin/rika-executor
workspace=/home/user/workspace
metadata=/usr/local/share/rika-box-executor

fail() {
  printf 'box template check failed: %s\n' "$1" >&2
  exit 1
}

for command in git rg bash sh flock sha256sum stat; do
  command -v "$command" >/dev/null 2>&1 || fail "missing $command"
done

[ -f "$binary" ] && [ -x "$binary" ] || fail "executor binary is not installed at $binary"
[ "$(stat -c '%U:%G:%a' "$binary")" = 'root:root:555' ] || fail "executor binary ownership or mode is invalid"
[ -d "$workspace" ] || fail "workspace directory is missing"
[ "$(stat -c '%U:%G:%a' "$workspace")" = 'user:user:750' ] || fail "workspace ownership or mode is invalid"
[ -r "$workspace" ] && [ -w "$workspace" ] && [ -x "$workspace" ] || fail "workspace is not usable"
[ -s /etc/ssl/certs/ca-certificates.crt ] || fail "CA certificate bundle is missing"
[ -f "$metadata/installed.sha256" ] || fail "installed checksum is missing"

expected="$(cat "$metadata/installed.sha256")"
actual="$(sha256sum "$binary")"
actual="${actual%% *}"
[ "$actual" = "$expected" ] || fail "executor binary checksum is invalid"

lock="$(mktemp)"
trap 'rm -f "$lock"' EXIT HUP INT TERM
exec 9>"$lock"
flock -n 9 || fail "flock could not acquire a descriptor lock"
if flock -n "$lock" -c true; then
  fail "flock did not retain the descriptor lock for the process lifetime"
fi
flock -u 9
flock -n "$lock" -c true || fail "flock did not release the descriptor lock"
exec 9>&-

git --version >/dev/null
rg --version >/dev/null
bash --version >/dev/null
sh -c 'exit 0'
flock --version >/dev/null
printf 'box-template-ready\n'
