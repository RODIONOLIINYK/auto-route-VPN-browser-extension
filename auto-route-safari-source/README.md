# Auto Route for Safari — macOS source package

Safari does not expose the WebExtensions proxy API used by Chrome and Edge. This package therefore contains the Safari WebExtension plus a small native macOS menu-bar companion.

The extension owns the settings, failure learning, and PAC generation. It sends the current PAC script to the native extension handler, which shares it with the companion through an App Group. The companion serves that PAC only on `127.0.0.1:17654` and can install the URL for the active macOS network service.

This is intentionally lightweight: the companion has no main window, database, analytics, or VPN tunnel. It runs a local PAC HTTP listener and a 15-second heartbeat. Because macOS automatic proxy configuration is a network-service setting, its PAC is visible to other apps that honor the system proxy; the PAC sends all non-selected traffic direct.

## Build on a Mac

1. Install current Xcode and its command-line tools.
2. Run `chmod +x build-safari.sh && ./build-safari.sh` from this folder, or use Apple's Safari Web Extension packaging command on the `WebExtension` folder.
3. Open the generated Xcode project.
4. Follow `SAFARI-XCODE-CHECKLIST.md` exactly to add the Swift files, App Group, entitlements, identifiers, signing team, and menu-bar app settings.
5. Build and run the macOS app, enable Auto Route in Safari's extension settings, then choose **Install for Current Network…** from the `AR` menu-bar icon.

The one-click network setup asks for an administrator password and records the previous automatic-proxy URL/state before making a change. **Restore Previous Proxy Setting…** restores that captured state. If one-click setup is unavailable, **Setup Help** shows the same local PAC URL for manual entry in System Settings.

## Requirements and limitations

- A trusted remote HTTP, HTTPS, SOCKS4, or SOCKS5 proxy endpoint is required; it is not included.
- Safari/macOS may prompt for proxy credentials and can store them in Keychain.
- Building, signing, and testing the native target require macOS and Xcode. The shared routing engine and WebExtension JavaScript can be validated on other platforms, but this Windows-generated package is source, not a signed `.app`.
- The interface automatically follows macOS light or dark appearance.
