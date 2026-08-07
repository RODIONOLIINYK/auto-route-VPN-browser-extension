#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WEB="$ROOT/WebExtension"
OUT="$ROOT/Generated"

if xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
  PACKAGER="safari-web-extension-packager"
else
  PACKAGER="safari-web-extension-converter"
fi

xcrun "$PACKAGER" "$WEB" \
  --project-location "$OUT" \
  --app-name "Auto Route" \
  --bundle-identifier "com.autoroute.app" \
  --swift \
  --macos-only \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force

HANDLER="$(find "$OUT" -name SafariWebExtensionHandler.swift -print -quit)"
APP_DELEGATE="$(find "$OUT" -name AppDelegate.swift -print -quit)"

if [[ -z "$HANDLER" || -z "$APP_DELEGATE" ]]; then
  echo "The Apple packager output layout was not recognized."
  exit 1
fi

cp "$ROOT/Native/SafariWebExtensionHandler.swift" "$HANDLER"
cp "$ROOT/Native/AppDelegate.swift" "$APP_DELEGATE"

echo
echo "Generated: $OUT"
echo "Open the Xcode project, then follow SAFARI-XCODE-CHECKLIST.md before building."
open "$(find "$OUT" -name '*.xcodeproj' -print -quit)"
