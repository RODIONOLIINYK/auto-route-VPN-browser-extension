#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WEB="$ROOT/WebExtension"
OUT="$ROOT/Generated"
VERSION="$(/usr/bin/plutil -extract version raw "$WEB/manifest.json")"
if [[ ! "$VERSION" =~ ^[0-9]+([.][0-9]+){1,2}$ ]]; then
  echo "WebExtension manifest version is not a valid release version: $VERSION"
  exit 1
fi

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
PROJECT="$(find "$OUT" -name '*.xcodeproj' -print -quit)"
PROJECT_FILE="$PROJECT/project.pbxproj"

if [[ -z "$HANDLER" || -z "$APP_DELEGATE" || ! -f "$PROJECT_FILE" ]]; then
  echo "The Apple packager output layout was not recognized."
  exit 1
fi

cp "$ROOT/Native/SafariWebExtensionHandler.swift" "$HANDLER"
cp "$ROOT/Native/AppDelegate.swift" "$APP_DELEGATE"

# Xcode 26.6's packager can derive a containing-app identifier that does not
# contain the requested extension identifier. It also uses the current macOS
# SDK as the app deployment target and macOS 10.14 for the extension, while the
# native handler uses Logger (macOS 11+). Normalize those generated settings.
/usr/bin/sed -i '' \
  -e 's/PRODUCT_BUNDLE_IDENTIFIER = "com\.autoroute\.Auto-Route";/PRODUCT_BUNDLE_IDENTIFIER = com.autoroute.app;/g' \
  -e 's/MACOSX_DEPLOYMENT_TARGET = [0-9][0-9.]*/MACOSX_DEPLOYMENT_TARGET = 11.0/g' \
  -e "s/MARKETING_VERSION = [0-9][0-9.]*/MARKETING_VERSION = $VERSION/g" \
  -e "s/CURRENT_PROJECT_VERSION = [0-9][0-9.]*/CURRENT_PROJECT_VERSION = $VERSION/g" \
  "$PROJECT_FILE"

# Attach the supplied entitlements to both generated targets. The App Group is
# how the WebExtension passes PAC state to the menu-bar companion.
/usr/bin/perl -0pi -e '
  s{(\t\t[^\n]+ /\* (?:Debug|Release) \*/ = \{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = \{\n)(.*?\n\t\t\t\};\n\t\t\tname = (?:Debug|Release);\n\t\t\};)}{
    my ($head, $body) = ($1, $2);
    if ($body =~ /PRODUCT_BUNDLE_IDENTIFIER = com\.autoroute\.app\.Extension;/) {
      $head
        . "\t\t\t\tCODE_SIGN_ENTITLEMENTS = \"../../Native/AutoRouteExtension.entitlements\";\n"
        . "\t\t\t\tREGISTER_APP_GROUPS = YES;\n"
        . $body;
    } elsif ($body =~ /PRODUCT_BUNDLE_IDENTIFIER = com\.autoroute\.app;/) {
      $head
        . "\t\t\t\tCODE_SIGN_ENTITLEMENTS = \"../../Native/AutoRoute.entitlements\";\n"
        . "\t\t\t\tENABLE_INCOMING_NETWORK_CONNECTIONS = YES;\n"
        . "\t\t\t\tINFOPLIST_KEY_LSApplicationCategoryType = \"public.app-category.utilities\";\n"
        . $body;
    } else {
      $head . $body;
    }
  }gse;
' "$PROJECT_FILE"

if ! grep -q 'PRODUCT_BUNDLE_IDENTIFIER = com.autoroute.app;' "$PROJECT_FILE" || \
   ! grep -q 'PRODUCT_BUNDLE_IDENTIFIER = com.autoroute.app.Extension;' "$PROJECT_FILE" || \
   ! grep -q "MARKETING_VERSION = $VERSION;" "$PROJECT_FILE" || \
   ! grep -q 'AutoRoute.entitlements' "$PROJECT_FILE" || \
   ! grep -q 'AutoRouteExtension.entitlements' "$PROJECT_FILE"; then
  echo "The generated Xcode project could not be configured safely."
  exit 1
fi

echo
echo "Generated: $OUT"
echo "Open the Xcode project, then follow SAFARI-XCODE-CHECKLIST.md before building."
open "$PROJECT"
