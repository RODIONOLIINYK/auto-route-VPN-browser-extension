# Auto Route

Auto Route is a lightweight selective-proxy browser extension for Chrome, Edge, and Safari. It routes `.ru`, manually selected, and successfully retried domains through a user-provided proxy while keeping ordinary browsing and media traffic direct when possible.

The interface automatically follows the operating system's light or dark appearance. There is no analytics or telemetry.

## Features

- Routes `.ru` domains through the configured proxy before their first request.
- Retries failed direct navigations once through the proxy and remembers successful retries locally.
- Treats HTTP 451 as blocked; optional HTTP 403 handling is available.
- Supports manual **Always proxy** and **Always direct** domain rules, including subdomains.
- Keeps common media URLs and learned media/CDN hosts direct, with a temporary proxy fallback after repeated media failures.
- Supports HTTP, HTTPS, SOCKS4, and SOCKS5 endpoints. Chrome does not support SOCKS username/password authentication, so use HTTP for authenticated Webshare-style proxies.
- Keeps private/local network addresses and the proxy host itself direct.

## Downloads

- [`Auto-Route-Chromium-1.0.0.zip`](Auto-Route-Chromium-1.0.0.zip) — Chrome and Edge package.
- [`Auto-Route-Safari-Source-1.0.0.zip`](Auto-Route-Safari-Source-1.0.0.zip) — Safari WebExtension and macOS companion source.
- [`SHA256SUMS.txt`](SHA256SUMS.txt) — archive checksums.

## Chrome and Edge installation

1. Extract `Auto-Route-Chromium-1.0.0.zip`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**, choose **Load unpacked**, and select `auto-route-extension`.
4. Open Auto Route's settings and enter the protocol, host, port, and credentials supplied by your proxy provider.
5. Save settings and enable Auto Route.

The unpacked source is in [`auto-route-extension/`](auto-route-extension/).

## Safari installation

Safari does not expose the proxy API used by Chromium. The Safari build therefore includes a very small macOS menu-bar companion that serves the generated PAC script on loopback and applies its URL to the active macOS network service.

Building and signing the native app requires macOS and Xcode. Follow [`auto-route-safari-source/README.md`](auto-route-safari-source/README.md) and [`SAFARI-XCODE-CHECKLIST.md`](auto-route-safari-source/SAFARI-XCODE-CHECKLIST.md).

## Proxy requirement

Auto Route does not include a proxy or VPN service. Use a trusted HTTP/HTTPS proxy endpoint. For Chrome and Edge, authenticated HTTP proxies are the broadest-compatible choice; Chromium does not support authentication methods for SOCKS5 proxies.

Proxy credentials are stored in browser extension storage. Use dedicated proxy credentials when available. PAC rules include a direct fallback for access reliability, so Auto Route is selective routing—not an anonymity kill switch.

## Development and validation

The routing engine is dependency-free JavaScript. Run:

```powershell
npm test
```

The test suite validates domain normalization, routing precedence, `.ru` handling, PAC output, media behavior, manifests, and automatic system-theme support.

## Repository layout

- `auto-route-extension/` — Chrome and Edge Manifest V3 extension.
- `auto-route-safari-source/WebExtension/` — Safari WebExtension.
- `auto-route-safari-source/Native/` — lightweight Swift companion and native-message handler.
- `tests/` — dependency-free routing and package-integrity tests.

No software license has been granted yet; all rights are reserved unless a license is added later.
