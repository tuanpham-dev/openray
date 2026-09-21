#!/bin/sh
set -eu

# OpenRay's install/update script for Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/tuanpham-dev/openray/main/install.sh | sh
#
# Detects your distro and CPU architecture, downloads the matching release
# from GitHub, and installs it through your system's own package manager
# (apt/dpkg on Debian and Ubuntu, dnf/zypper/rpm on Fedora, RHEL and
# openSUSE) — which is also how it updates: installing a newer package over
# an existing one is an upgrade, the same as `apt upgrade` would do.
#
# macOS and Windows aren't handled by this script — see
# https://github.com/tuanpham-dev/openray#download for those installers.

REPO="tuanpham-dev/openray"

usage() {
  arg0="$0"
  if [ "$0" = sh ]; then
    arg0="curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s --"
  fi

  cat << EOF
Installs or updates OpenRay on Linux.
Detects your distro and architecture, downloads the matching release from
GitHub, and installs it with your system's package manager.

Usage:

  $arg0 [--dry-run] [--version X.X.X]

  --dry-run
      Print the commands this script would run, without running them.

  --version X.X.X
      Install a specific version instead of the latest.

Installs a .deb via apt (Debian, Ubuntu, and derivatives) or a .rpm via dnf,
zypper, or rpm (Fedora, RHEL, openSUSE, and derivatives). Anything else —
including macOS and Windows — isn't handled here; see
https://github.com/$REPO#download for those installers, or the .AppImage,
which runs on any Linux distro without installing anything.

Installing needs root, so this script uses sudo and you'll be asked for
your password.
EOF
}

main() {
  unset DRY_RUN VERSION

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        ;;
      --version)
        VERSION="$(parse_arg "$@")"
        shift
        ;;
      --version=*)
        VERSION="${1#*=}"
        ;;
      -h | --h | -help | --help)
        usage
        exit 0
        ;;
      *)
        echoerr "Unknown argument: $1"
        echoerr "Run with --help to see usage."
        exit 1
        ;;
    esac
    shift
  done

  if ! command_exists curl; then
    echoerr "This script needs curl. Install it, then run this again."
    exit 1
  fi

  OS="$(os)"
  if [ "$OS" != linux ]; then
    echoerr "This script only installs OpenRay on Linux — detected $OS."
    echoerr "See https://github.com/$REPO#download for macOS and Windows installers."
    exit 1
  fi

  echo "Detected: $(distro_name)"

  VERSION="${VERSION:-$(echo_latest_version)}"
  echo "Installing OpenRay v$VERSION"
  echo

  CACHE_DIR="$(echo_cache_dir)"

  if command_exists dpkg; then
    install_deb
  elif command_exists rpm; then
    install_rpm
  else
    echoerr "No supported package manager found (looked for dpkg and rpm)."
    echoerr "Try the .AppImage instead — it runs on any Linux distro without"
    echoerr "installing anything: https://github.com/$REPO/releases/latest"
    exit 1
  fi

  echo_postinstall
}

echo_latest_version() {
  # Follows the /releases/latest redirect and reads where it landed, rather
  # than parsing the GitHub API's JSON — so this script has no dependency on
  # jq or any other JSON tool, just curl.
  # https://gist.github.com/lukechilds/a83e1d7127b78fef38c2914c4ececc3c#gistcomment-2758860
  url="$(curl -fsSLI -o /dev/null -w "%{url_effective}" "https://github.com/$REPO/releases/latest")"
  version="${url#https://github.com/"$REPO"/releases/tag/v}"
  if [ "$version" = "$url" ] || [ -z "$version" ]; then
    echoerr "Couldn't work out the latest version from GitHub (got: $url)."
    exit 1
  fi
  echo "$version"
}

install_deb() {
  arch="$(deb_arch)"
  file="openray_${VERSION}_${arch}.deb"
  path="$CACHE_DIR/$file"
  fetch "https://github.com/$REPO/releases/download/v$VERSION/$file" "$path"

  # `apt install <path>` resolves OpenRay's runtime deps (webkitgtk, gtk3,
  # libayatana-appindicator3) from your configured repos in one step; plain
  # `dpkg -i` would leave them missing on a system that doesn't already have
  # them. Only fall back to dpkg where apt itself isn't installed.
  if command_exists apt-get; then
    sudo_sh_c apt-get install -y "$path"
  else
    sudo_sh_c dpkg -i "$path"
  fi
}

install_rpm() {
  arch="$(rpm_arch)"
  # The trailing "-1" is the RPM package's own release number, which this
  # project's build has never had a reason to bump past 1.
  file="openray-${VERSION}-1.${arch}.rpm"
  path="$CACHE_DIR/$file"
  fetch "https://github.com/$REPO/releases/download/v$VERSION/$file" "$path"

  # Same reasoning as install_deb: prefer whichever manager resolves
  # dependencies (webkit2gtk4.1, gtk3, libappindicator) from configured
  # repos, and only fall back to plain rpm — which won't — if neither exists.
  if command_exists dnf; then
    sudo_sh_c dnf install -y "$path"
  elif command_exists zypper; then
    sudo_sh_c zypper --non-interactive install "$path"
  else
    sudo_sh_c rpm -U "$path"
  fi
}

echo_postinstall() {
  echo
  cat << EOF
OpenRay is installed. It starts in the background with a bolt icon in your
tray — press Alt+Space to open it.

Log out and back in (or reboot) if "Launch at Login" doesn't take effect
until then on your desktop environment.
EOF
}

parse_arg() {
  case "${2-}" in
    "" | -*)
      echoerr "$1 requires an argument"
      echoerr "Run with --help to see usage."
      exit 1
      ;;
    *)
      echo "$2"
      ;;
  esac
}

# POSIX sh has no `local`, so `url`/`file` here are the same global variables
# as anything else in the script that happens to use those names — a caller
# must capture the path it cares about into its own variable *before*
# calling this, rather than reading `$file`/`$url` again afterward.
fetch() {
  url="$1"
  file="$2"

  if [ -e "$file" ]; then
    echo "+ Reusing $file"
    return
  fi

  sh_c mkdir -p "$CACHE_DIR"
  sh_c curl -#fL -o "$file.incomplete" "$url"
  sh_c mv "$file.incomplete" "$file"
}

os() {
  case "$(uname)" in
    Linux) echo linux ;;
    Darwin) echo macos ;;
    *) echo "$(uname)" ;;
  esac
}

# Debian package archive naming.
deb_arch() {
  case "$(uname -m)" in
    x86_64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *)
      echoerr "No release built for this architecture ($(uname -m))."
      exit 1
      ;;
  esac
}

# RPM's own architecture naming, which doesn't match Debian's.
rpm_arch() {
  case "$(uname -m)" in
    x86_64) echo x86_64 ;;
    aarch64 | arm64) echo aarch64 ;;
    *)
      echoerr "No release built for this architecture ($(uname -m))."
      exit 1
      ;;
  esac
}

# A human-readable line for the "Detected: ..." message — not used to decide
# how to install, which instead goes by whichever package manager is
# actually on PATH (see main()). A pretty distro name that turned out to
# have neither dpkg nor rpm would be a dead end either way.
distro_name() {
  if [ -f /etc/os-release ]; then
    (
      . /etc/os-release
      echo "${PRETTY_NAME:-$ID} ($(uname -m))"
    )
    return
  fi
  uname -sr
}

command_exists() {
  command -v "$1" > /dev/null 2>&1
}

sh_c() {
  echo "+ $*"
  if [ ! "${DRY_RUN-}" ]; then
    "$@"
  fi
}

sudo_sh_c() {
  if [ "$(id -u)" = 0 ]; then
    sh_c "$@"
  elif command_exists sudo; then
    echo "+ sudo $*"
    if [ ! "${DRY_RUN-}" ]; then
      sudo "$@"
    fi
  else
    echoerr "This needs to run as root, and no sudo was found:"
    echoerr "  $*"
    exit 1
  fi
}

echo_cache_dir() {
  if [ "${XDG_CACHE_HOME-}" ]; then
    echo "$XDG_CACHE_HOME/openray-install"
  else
    echo "$HOME/.cache/openray-install"
  fi
}

echoerr() {
  echo "$@" >&2
}

main "$@"
