#!/usr/bin/env bash
# Builds another-cli and places it where Tauri bundles sidecar binaries.
set -euo pipefail
profile="${1:-release}"
root="$(cd "$(dirname "$0")/.." && pwd)"
triple="$(rustc -vV | sed -n 's/host: //p')"
flags=()
[ "$profile" = "release" ] && flags=(--release)
cargo build ${flags[@]+"${flags[@]}"} -p another-cli --manifest-path "$root/Cargo.toml"
mkdir -p "$root/src-tauri/binaries"
cp "$root/src-tauri/target/$profile/another-cli" "$root/src-tauri/binaries/another-cli-$triple"
