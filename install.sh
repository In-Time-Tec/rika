#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/In-Time-Tec/rika/main/install.sh | sh
# Optional: RIKA_VERSION, RIKA_INSTALL_ROOT, RIKA_BIN_DIR, RIKA_FORCE_LINK=1.
# RIKA_RELEASE_BASE_URL overrides the download directory for offline verification.
set -eu

fail() { echo "rika: $*" >&2; exit 1; }
for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done
[ -n "${HOME:-}" ] || fail "HOME is not set"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  Linux-x86_64|Linux-amd64) target=linux-x64 ;;
  *) fail "supported platforms: darwin-arm64, linux-arm64, linux-x64" ;;
esac
if command -v sha256sum >/dev/null 2>&1; then checksum="sha256sum"
elif command -v shasum >/dev/null 2>&1; then checksum="shasum -a 256"
else fail "sha256sum or shasum is required"; fi

install_root="${RIKA_INSTALL_ROOT:-$HOME/.local/share/rika/current}"
bin_dir="${RIKA_BIN_DIR:-$HOME/.local/bin}"
for directory in "$install_root" "$bin_dir"; do
  case "$directory" in /) fail "an install directory cannot be /" ;; /*) ;; *) fail "install directories must be absolute paths" ;; esac
done
command_path="$bin_dir/rika"
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  [ ! -d "$command_path" ] || fail "$command_path is a directory"
  if [ "$(readlink "$command_path" 2>/dev/null || true)" != "$install_root/bin/rika" ]; then
    [ "${RIKA_FORCE_LINK:-}" = 1 ] || fail "$command_path belongs to another install. Use rika update, or set RIKA_FORCE_LINK=1 to replace this command."
  fi
fi

releases="https://github.com/In-Time-Tec/rika/releases"
requested="${RIKA_VERSION:-}"
requested="${requested#v}"
case "$requested" in *[!0-9A-Za-z.-]*) fail "invalid RIKA_VERSION" ;; esac
base="${RIKA_RELEASE_BASE_URL:-${releases}/latest/download}"
if [ -n "$requested" ]; then base="${RIKA_RELEASE_BASE_URL:-${releases}/download/v${requested}}"; fi

parent="$(dirname "$install_root")"
mkdir -p "$parent" "$bin_dir"
staging="$(mktemp -d "$parent/.rika-install-XXXXXX")"
previous="$parent/.rika-previous-$$"
staged_command=""
cleanup() {
  if [ -e "$previous" ]; then
    if [ -e "$install_root" ]; then rm -rf "$previous"
    else mv "$previous" "$install_root" || { echo "rika: previous install retained at $previous" >&2; return; }; fi
  fi
  rm -rf "$staging"
  if [ -n "$staged_command" ]; then rm -f "$staged_command"; fi
}
[ ! -e "$previous" ] || fail "backup path already exists: $previous"
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM

# The checksum index selects the version and target; no GitHub API or JSON parser.
curl -fsSL "$base/SHA256SUMS" -o "$staging/SHA256SUMS" || fail "could not download release checksums"
entry="$(awk -v target="$target" '$2 ~ ("^rika-[0-9][0-9A-Za-z.-]*-" target "\\.tar\\.gz$") { print $1, $2 }' "$staging/SHA256SUMS")"
set -f
set -- $entry
[ "$#" -eq 2 ] || fail "release must contain exactly one archive for $target"
expected="$1"
archive="$2"
case "$expected" in *[!0-9a-f]*|'') fail "invalid SHA256 checksum" ;; esac
[ "${#expected}" -eq 64 ] || fail "invalid SHA256 checksum"
root="${archive%.tar.gz}"
version="${root#rika-}"
version="${version%-$target}"
[ -z "$requested" ] || [ "$requested" = "$version" ] || fail "release does not match RIKA_VERSION"
# Pin the archive request even if GitHub's latest release changes in between requests.
base="${RIKA_RELEASE_BASE_URL:-${releases}/download/v${version}}"
echo "rika: installing $version for $target"
curl -fsSL "$base/$archive" -o "$staging/$archive" || fail "could not download $archive"
actual="$($checksum "$staging/$archive" | awk '{ print $1 }')"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive; install unchanged"

inventory="$(tar -tzf "$staging/$archive" | LC_ALL=C sort)"
[ "$inventory" = "$(printf '%s\n' "$root/" "$root/INSTALL" "$root/bin/" "$root/bin/rika" | LC_ALL=C sort)" ] || fail "unexpected archive contents"
tar -xzf "$staging/$archive" -C "$staging"
binary="$staging/$root/bin/rika"
[ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] || fail "archive is missing the native executable"
[ "$(env -i HOME="$HOME" PATH="$PATH" TERM=dumb "$binary" --version)" = "rika v$version" ] || fail "release executable failed its version check"

# Same-filesystem renames preserve the previous install until publication succeeds.
if [ -e "$install_root" ]; then mv "$install_root" "$previous"; fi
mv "$staging/$root" "$install_root"
link="$bin_dir/.rika-install-$$"
ln -s "$install_root/bin/rika" "$link"
staged_command="$link"
mv -f "$link" "$command_path"
echo "rika: installed $version. Run rika update for future updates."
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "rika: add $bin_dir to PATH: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
