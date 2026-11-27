#!/usr/bin/env bash
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
PLATFORM="${ANDROID_PLATFORM:-34}"
BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-36.1.0}"
STUDIO="${ANDROID_STUDIO:-/Applications/Android Studio.app/Contents}"
KOTLINC_HOME="${KOTLINC_HOME:-$STUDIO/plugins/Kotlin/kotlinc}"
export JAVA_HOME="${JAVA_HOME_FOR_KOTLIN:-$STUDIO/jbr/Contents/Home}"

ANDROID_JAR="$ANDROID_HOME/platforms/android-$PLATFORM/android.jar"
R8_JAR="$ANDROID_HOME/build-tools/$BUILD_TOOLS/lib/d8.jar"
STDLIB_JAR="$KOTLINC_HOME/lib/kotlin-stdlib.jar"

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="${1:-$SERVER_DIR/../src-tauri/resources/another-server}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

bash "$KOTLINC_HOME/bin/kotlinc" \
    -classpath "$ANDROID_JAR" \
    -jvm-target 1.8 \
    -no-reflect \
    -Xno-param-assertions -Xno-call-assertions -Xno-receiver-assertions \
    -d "$BUILD_DIR/classes.jar" \
    "$SERVER_DIR/src/main/kotlin"

"$JAVA_HOME/bin/java" -cp "$R8_JAR" com.android.tools.r8.R8 \
    --release \
    --min-api 21 \
    --lib "$ANDROID_JAR" \
    --pg-conf "$SERVER_DIR/proguard-rules.pro" \
    --output "$BUILD_DIR/dex.zip" \
    "$BUILD_DIR/classes.jar" "$STDLIB_JAR"

mv "$BUILD_DIR/dex.zip" "$OUTPUT"
echo "Built $OUTPUT ($(wc -c < "$OUTPUT" | tr -d ' ') bytes)"
