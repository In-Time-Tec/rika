#!/bin/sh
# Install or upgrade Rika.
#
#   curl -fsSL https://raw.githubusercontent.com/In-Time-Tec/rika/main/install.sh | sh
#
# Environment:
#   RIKA_VERSION       version to install, without a leading "v" (default: latest release)
#   RIKA_INSTALL_ROOT  install directory (default: $HOME/.local/share/rika/current)
#   RIKA_BIN_DIR       directory for the rika command (default: $HOME/.local/bin)
#   RIKA_FORCE_LINK    set to 1 to replace a rika command this installer does not own
#   RIKA_RELEASE_API_URL   override the latest-release lookup (used by tests)
#   RIKA_RELEASE_BASE_URL  override the release download location (used by tests)
#
# These defaults match scripts/installation/local-install.ts so a curl install and a
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
  api_url="${RIKA_RELEASE_API_URL:-https://api.github.com/repos/${repository}/releases/latest}"
  release_json="$(curl -fsSL "$api_url" 2>/dev/null || echo)"
  [ -n "$release_json" ] || fail "could not read the latest release from ${api_url}.
  Check your network and the GitHub API rate limit, or set RIKA_VERSION to install a specific release."
  tag="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || fail "${api_url} returned no release tag; set RIKA_VERSION to install a specific release."
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
install_root="${RIKA_INSTALL_ROOT:-$HOME/.local/share/rika/current}"
bin_dir="${RIKA_BIN_DIR:-$HOME/.local/bin}"
command_path="$bin_dir/rika"
install_parent="$(dirname "$install_root")"

# An upgrade replaces only the install this script published. Anything else is
# owned by another installer and is never overwritten silently.
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  owned=0
  if [ -L "$command_path" ]; then
    link_target="$(readlink "$command_path" 2>/dev/null || echo)"
    if [ "$link_target" = "${install_root}/bin/rika" ]; then
      owned=1
    fi
  fi
  if [ "$owned" -eq 0 ] && [ "${RIKA_FORCE_LINK:-}" != 1 ]; then
    fail "$command_path already exists and was not installed by this script.
  Remove it, or re-run with RIKA_FORCE_LINK=1 to replace it."
  fi
fi

version="$(resolve_version)"
archive_file="rika-${version}-${target}.tar.gz"
archive_root="rika-${version}-${target}"
base_url="${RIKA_RELEASE_BASE_URL:-https://github.com/${repository}/releases/download/v${version}}"

echo "rika: installing ${version} for ${target}"

mkdir -p "$install_parent" "$bin_dir"

# Stage beside the install root so every publish step is a same-filesystem
# rename, and keep the replaced install outside the staging directory so an
# interrupt can never delete the only working copy.
staging=""
previous=""
cleanup() {
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    if [ -e "$install_root" ]; then
      rm -rf "$previous" || true
    else
      mv "$previous" "$install_root" || true
    fi
  fi
  if [ -n "$staging" ]; then
    rm -rf "$staging" || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

staging="$(mktemp -d "${install_parent}/.rika-install-XXXXXX")"

curl -fsSL "${base_url}/${archive_file}" -o "${staging}/${archive_file}" ||
  fail "could not download ${archive_file} from release v${version}"
curl -fsSL "${base_url}/SHA256SUMS" -o "${staging}/SHA256SUMS" ||
  fail "could not download SHA256SUMS from release v${version}"

verify_checksum "${staging}/${archive_file}" "${staging}/SHA256SUMS" "$archive_file"

tar -xzf "${staging}/${archive_file}" -C "$staging"
[ -x "${staging}/${archive_root}/bin/rika" ] || fail "release archive is missing bin/rika"
[ -f "${staging}/${archive_root}/bin/.rika-interactive" ] || fail "release archive is missing bin/.rika-interactive"
[ -f "${staging}/${archive_root}/bin/.rika-performance" ] || fail "release archive is missing bin/.rika-performance"
[ -f "${staging}/${archive_root}/bin/.rika-server" ] || fail "release archive is missing bin/.rika-server"

previous="${install_parent}/.rika-previous-$$"
if [ -e "$install_root" ]; then
  mv "$install_root" "$previous"
fi
mv "${staging}/${archive_root}" "$install_root" ||
  fail "could not publish the install to $install_root"

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
