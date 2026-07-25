#!/bin/sh
# Install Rika.
#
#   curl -fsSL https://raw.githubusercontent.com/In-Time-Tec/rika/main/install.sh | sh
#
# Environment:
#   RIKA_VERSION       version to install, without a leading "v" (default: latest release)
#   RIKA_INSTALL_ROOT  install directory (default: $HOME/.local/share/rika/current)
#   RIKA_BIN_DIR       directory for the rika command (default: $HOME/.local/bin)
#   RIKA_RELEASE_BASE_URL  override the release download location (used by tests)
#
# These defaults match scripts/local-install.ts so a curl install and a
# build-from-source install land in the same place.

set -eu

repository="In-Time-Tec/rika"

fail() {
  echo "rika: $1" >&2
  exit 1
}

detect_target() {
  kernel="$(uname -s)"
  machine="$(uname -m)"
  case "$kernel" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) fail "unsupported operating system: $kernel (supported: macOS, Linux)" ;;
  esac
  case "$machine" in
    arm64 | aarch64) architecture="arm64" ;;
    x86_64 | amd64) architecture="x64" ;;
    *) fail "unsupported architecture: $machine (supported: arm64, x86_64)" ;;
  esac
  case "${os}-${architecture}" in
    darwin-arm64 | linux-arm64 | linux-x64) ;;
    *) fail "no Rika build for ${os}-${architecture} (supported: darwin-arm64, linux-arm64, linux-x64)" ;;
  esac
  echo "${os}-${architecture}"
}

resolve_version() {
  if [ -n "${RIKA_VERSION:-}" ]; then
    echo "${RIKA_VERSION#v}"
    return
  fi
  tag="$(curl -fsSL "https://api.github.com/repos/${repository}/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || fail "could not resolve the latest release; set RIKA_VERSION to install a specific one"
  echo "${tag#v}"
}

verify_checksum() {
  archive_path="$1"
  sums_path="$2"
  archive_file="$3"
  expected="$(awk -v name="$archive_file" '$2 == name { print $1 }' "$sums_path" | head -n 1)"
  [ -n "$expected" ] || fail "$archive_file is not listed in SHA256SUMS"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive_path" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
  else
    fail "neither sha256sum nor shasum is available to verify the download"
  fi
  [ "$expected" = "$actual" ] ||
    fail "checksum mismatch for $archive_file
  expected $expected
  actual   $actual"
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
[ -n "${HOME:-}" ] || fail "HOME is not set"

target="$(detect_target)"
version="$(resolve_version)"
install_root="${RIKA_INSTALL_ROOT:-$HOME/.local/share/rika/current}"
bin_dir="${RIKA_BIN_DIR:-$HOME/.local/bin}"
command_path="$bin_dir/rika"
archive_file="rika-${version}-${target}.tar.gz"
archive_root="rika-${version}-${target}"
base_url="${RIKA_RELEASE_BASE_URL:-https://github.com/${repository}/releases/download/v${version}}"

echo "rika: installing ${version} for ${target}"

staging="$(mktemp -d)"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT INT TERM

curl -fsSL "${base_url}/${archive_file}" -o "${staging}/${archive_file}" ||
  fail "could not download ${archive_file} from release v${version}"
curl -fsSL "${base_url}/SHA256SUMS" -o "${staging}/SHA256SUMS" ||
  fail "could not download SHA256SUMS from release v${version}"

verify_checksum "${staging}/${archive_file}" "${staging}/SHA256SUMS" "$archive_file"

tar -xzf "${staging}/${archive_file}" -C "$staging"
[ -x "${staging}/${archive_root}/bin/rika" ] || fail "release archive is missing bin/rika"
[ -f "${staging}/${archive_root}/bin/.rika-runtime" ] || fail "release archive is missing bin/.rika-runtime"

mkdir -p "$(dirname "$install_root")" "$bin_dir"

# Publish the install by rename so a failed download never replaces a working one.
previous="${staging}/previous"
if [ -e "$install_root" ]; then
  mv "$install_root" "$previous"
fi
if ! mv "${staging}/${archive_root}" "$install_root"; then
  [ -e "$previous" ] && mv "$previous" "$install_root"
  fail "could not publish the install to $install_root"
fi

# Swap the command symlink atomically.
staged_command="${bin_dir}/.rika-install-$$"
ln -sfn "${install_root}/bin/rika" "$staged_command"
mv -f "$staged_command" "$command_path"

echo "rika: installed to $install_root"
echo "rika: linked $command_path"

case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *)
    echo "rika: $bin_dir is not on your PATH. Add this to your shell profile:"
    echo "  export PATH=\"$bin_dir:\$PATH\""
    ;;
esac
