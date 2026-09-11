#!/bin/sh
set -eu

[ "$#" -eq 1 ] || {
  printf 'usage: install.sh <box-executor-artifact-directory>\n' >&2
  exit 2
}
[ "$(id -u)" -eq 0 ] || {
  printf 'box executor installation requires root\n' >&2
  exit 1
}

artifacts="$1"
case "$(uname -m)" in
  aarch64 | arm64) filename=rika-executor-linux-arm64 ;;
  x86_64 | amd64) filename=rika-executor-linux-x64 ;;
  *)
    printf 'unsupported Box executor architecture\n' >&2
    exit 1
    ;;
esac

[ -f "$artifacts/$filename" ] || {
  printf 'Box executor artifact is missing\n' >&2
  exit 1
}
[ -f "$artifacts/SHA256SUMS" ] && [ -f "$artifacts/inventory.json" ] || {
  printf 'Box executor artifact metadata is missing\n' >&2
  exit 1
}
matches="$(grep -c "  $filename\$" "$artifacts/SHA256SUMS" || true)"
[ "$matches" -eq 1 ] || {
  printf 'Box executor checksum inventory is invalid\n' >&2
  exit 1
}

checksum="$(grep "  $filename\$" "$artifacts/SHA256SUMS")"
(cd "$artifacts" && printf '%s\n' "$checksum" | sha256sum -c - >/dev/null)
digest="${checksum%% *}"
id user >/dev/null 2>&1 || {
  printf 'Box workspace user is missing\n' >&2
  exit 1
}

install -d -m 0750 -o user -g user /home/user/workspace
install -m 0555 -o root -g root "$artifacts/$filename" /usr/local/bin/rika-executor
install -d -m 0755 -o root -g root /usr/local/share/rika-box-executor
install -m 0444 -o root -g root "$artifacts/inventory.json" /usr/local/share/rika-box-executor/inventory.json
printf '%s\n' "$digest" > /usr/local/share/rika-box-executor/installed.sha256
chmod 0444 /usr/local/share/rika-box-executor/installed.sha256
install -m 0555 -o root -g root "$(dirname "$0")/doctor.sh" /usr/local/bin/rika-box-doctor
/usr/local/bin/rika-box-doctor
