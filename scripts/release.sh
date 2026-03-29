#!/bin/bash
set -euo pipefail

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "Error: APPLE_SIGNING_IDENTITY is not set"
  echo "Run: security find-identity -v -p codesigning"
  echo "Then export APPLE_SIGNING_IDENTITY=\"Developer ID Application: Your Name (TEAMID)\""
  exit 1
fi

if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo "Error: Notarization env vars not set. Required:"
  echo "  APPLE_ID        - your Apple ID email"
  echo "  APPLE_PASSWORD  - app-specific password from appleid.apple.com"
  echo "  APPLE_TEAM_ID   - your 10-char team ID"
  exit 1
fi

export APPLE_SIGNING_IDENTITY
export APPLE_ID
export APPLE_PASSWORD
export APPLE_TEAM_ID

echo "Building release..."
bun run tauri build

APP_PATH="src-tauri/target/release/bundle/macos/Another.app"
DMG_PATH="src-tauri/target/release/bundle/dmg/Another_0.1.0_aarch64.dmg"

echo "Signing app..."
codesign --deep --force --options runtime \
  --sign "$APPLE_SIGNING_IDENTITY" \
  "$APP_PATH"

codesign --verify --verbose "$APP_PATH"

if [ -f "$DMG_PATH" ]; then
  echo "Signing DMG..."
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$DMG_PATH"

  echo "Submitting DMG for notarization..."
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  echo "Stapling notarization ticket..."
  xcrun stapler staple "$DMG_PATH"

  echo "Done! Release DMG: $DMG_PATH"
else
  echo "DMG not found at $DMG_PATH, notarizing .app instead..."
  ditto -c -k --keepParent "$APP_PATH" "/tmp/Another.zip"

  xcrun notarytool submit "/tmp/Another.zip" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  xcrun stapler staple "$APP_PATH"
  echo "Done! Release app: $APP_PATH"
fi
