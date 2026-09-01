#!/usr/bin/env bash
set -euo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target="darwin-arm64" ;;
  Linux-aarch64 | Linux-arm64) target="linux-arm64" ;;
  Linux-x86_64) target="linux-x64" ;;
  *)
    printf 'Unsupported packaging host: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

version="$(MANIFEST="$root/apps/rika/package.json" bun -e 'console.log((await Bun.file(process.env.MANIFEST).json()).version)')"
archive_root="rika-$version-$target"
archive="$root/artifacts/$archive_root.tar.gz"
temporary="$(mktemp -d)"
clean_home="$(mktemp -d)"
trap 'rm -rf "$temporary" "$clean_home"' EXIT

bun run --cwd "$root" package -- --target "$target"

actual_entries="$(tar -tzf "$archive" | LC_ALL=C sort)"
expected_entries="$(ROOT="$archive_root" bun --cwd "$root" -e 'import { packageBinEntries } from "./scripts/packaging/package-contract"; const root = process.env.ROOT; console.log([`${root}/`, `${root}/INSTALL`, `${root}/bin/`, ...packageBinEntries.map((entry) => `${root}/bin/${entry}`)].sort().join("\n"))')"
if [[ "$actual_entries" != "$expected_entries" ]]; then
  printf 'Packaged inventory mismatch\nExpected:\n%s\nActual:\n%s\n' "$expected_entries" "$actual_entries" >&2
  exit 1
fi

tar -xzf "$archive" -C "$temporary"
bin="$temporary/$archive_root/bin"
binary="$bin/rika"
test -x "$binary"

actual_version="$(env -i HOME="$clean_home" PATH="$PATH" TERM=dumb "$binary" --version)"
test "$actual_version" = "rika v$version"
help="$(env -i HOME="$clean_home" PATH="$PATH" TERM=dumb "$binary" --help)"
grep -Fqi 'Rika coding agent' <<<"$help"
if grep -Fqi relay <<<"$help"; then
  printf 'Obsolete relay command found in packaged help\n' >&2
  exit 1
fi
printf 'Packaged Rika %s (%s) passed inventory and CLI smoke checks\n' "$version" "$target"

if [[ "${1:-}" == "--" ]]; then shift; fi
if (( $# > 0 )); then
  "$binary" "$@"
fi
