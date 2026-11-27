#!/bin/sh
# Installs Another and its `another` command.
#
#   curl -fsSL https://raw.githubusercontent.com/Zfinix/another/main/install.sh | sh
#
# ANOTHER_VERSION=1.0.0  install that version instead of the latest
# ANOTHER_APP_DIR=...    where the app goes
# ANOTHER_BIN_DIR=...    where the another command goes
set -eu

REPO="Zfinix/another"
COMMAND="another"
CLI_NAME="another-cli"

say() { printf '%s\n' "$*"; }
fail() { printf 'another: %s\n' "$*" >&2; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 || fail "this script needs $1"
}

writable() {
    mkdir -p "$1" 2>/dev/null && [ -w "$1" ]
}

on_path() {
    case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac
}

# Prints the download URL for one platform from the updater manifest, latest.json.
platform_url() {
    awk -v key="\"$2\": {" '
        index($0, key) { found = 1; next }
        found && /"url":/ { sub(/.*"url": *"/, ""); sub(/".*/, ""); print; exit }
    ' "$1"
}

link_command() {
    source_path=$1
    bin_dir=${ANOTHER_BIN_DIR:-$2}
    writable "$bin_dir" || bin_dir="$HOME/.local/bin"
    mkdir -p "$bin_dir"
    ln -sf "$source_path" "$bin_dir/$COMMAND"
    linked=1
    say "Installed the $COMMAND command in $bin_dir"
    on_path "$bin_dir" || say "Add $bin_dir to your PATH to run $COMMAND from any folder"
}

install_macos() {
    case "$(uname -m)" in
        arm64) platform="darwin-aarch64" ;;
        x86_64) platform="darwin-x86_64" ;;
        *) fail "Another does not support this Mac ($(uname -m))" ;;
    esac
    url=$(platform_url "$manifest" "$platform")
    [ -n "$url" ] || fail "this release has no build for $platform"

    say "Downloading Another $version"
    curl -fsSL "$url" -o "$tmp/Another.app.tar.gz"
    tar -xzf "$tmp/Another.app.tar.gz" -C "$tmp"
    [ -d "$tmp/Another.app" ] || fail "the download did not contain Another.app"

    app_dir=${ANOTHER_APP_DIR:-/Applications}
    writable "$app_dir" || app_dir="$HOME/Applications"
    mkdir -p "$app_dir"
    if pgrep -f "$app_dir/Another.app/Contents/MacOS/" >/dev/null 2>&1; then
        say "Quit Another to finish updating it, then run this again"
        exit 1
    fi
    rm -rf "$app_dir/Another.app"
    mv "$tmp/Another.app" "$app_dir/Another.app"
    say "Installed Another in $app_dir"

    cli="$app_dir/Another.app/Contents/MacOS/$CLI_NAME"
    if [ -x "$cli" ]; then
        link_command "$cli" /usr/local/bin
    else
        say "This release has no $COMMAND command yet"
    fi
}

install_linux() {
    [ "$(uname -m)" = "x86_64" ] || fail "Another for Linux is x86_64 only for now"
    url=$(platform_url "$manifest" "linux-x86_64")
    [ -n "$url" ] || fail "this release has no Linux build"

    app_dir=${ANOTHER_APP_DIR:-"$HOME/.local/share/another"}
    mkdir -p "$app_dir"
    say "Downloading Another $version"
    curl -fsSL "$url" -o "$tmp/Another.AppImage"
    chmod +x "$tmp/Another.AppImage"

    # Extracting needs no FUSE, so the command and icon come out even where the AppImage cannot mount.
    (cd "$tmp" && ./Another.AppImage --appimage-extract >/dev/null 2>&1) || fail "could not unpack the AppImage"
    mv "$tmp/Another.AppImage" "$app_dir/Another.AppImage"
    cp -L "$tmp/squashfs-root/.DirIcon" "$app_dir/icon.png" 2>/dev/null || true

    apps="$HOME/.local/share/applications"
    mkdir -p "$apps"
    cat >"$apps/another.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Another
Comment=Mirror and control Android phones
Exec="$app_dir/Another.AppImage" %U
Icon=$app_dir/icon.png
Categories=Development;Utility;
MimeType=x-scheme-handler/another;
Terminal=false
EOF
    say "Installed Another in $app_dir"

    cli="$tmp/squashfs-root/usr/bin/$CLI_NAME"
    if [ -x "$cli" ]; then
        cp "$cli" "$app_dir/$CLI_NAME"
        link_command "$app_dir/$CLI_NAME" "$HOME/.local/bin"
    else
        say "This release has no $COMMAND command yet"
    fi
}

linked=0
need curl
need tar
need awk

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -n "${ANOTHER_VERSION:-}" ]; then
    manifest_url="https://github.com/$REPO/releases/download/v${ANOTHER_VERSION#v}/latest.json"
else
    manifest_url="https://github.com/$REPO/releases/latest/download/latest.json"
fi
manifest="$tmp/latest.json"
curl -fsSL "$manifest_url" -o "$manifest" || fail "could not reach the releases on GitHub"
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$manifest" | head -n 1)

case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *) fail "use the Windows installer from https://github.com/$REPO/releases/latest" ;;
esac

if [ "$linked" = 1 ]; then
    say "Done. Open Another, then run: $COMMAND status"
else
    say "Done. Open Another from your applications"
fi
