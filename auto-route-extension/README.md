# Auto Route for Chrome and Edge

Auto Route is a lightweight Manifest V3 extension that sends only selected domains through a remote proxy. It routes `.ru` sites automatically, can retry failed pages through the proxy and remember successful retries, and keeps common video/audio requests direct when possible.

## What you need

Auto Route does not provide or operate a proxy server. Obtain a trusted HTTP, HTTPS, SOCKS4, or SOCKS5 proxy endpoint in the country you want to use, including its host, port, and credentials if required.

## Install locally

1. Extract this folder and keep it in a stable location.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this folder.
5. Open Auto Route's **Settings**, enter the proxy endpoint, save, then enable the extension.

## Routing behavior

- `.ru` domains use the proxy before their first request.
- A direct page that fails to navigate is retried once through the proxy. A successful retry is remembered locally.
- HTTP 451 is treated as a blocking response. HTTP 403 handling is optional because legitimate sites also use 403 for access control.
- Manual **Always proxy** and **Always direct** rules include subdomains.
- Common media URLs and learned media/CDN domains stay direct. After three direct media failures within 15 seconds, that media domain temporarily falls back to the proxy for the current browser session.
- Local/private network addresses and the proxy server itself always remain direct.

## Privacy and limitations

There is no analytics or telemetry. Settings and learned domains remain in browser extension storage. Proxy credentials are stored locally by the browser extension and are not encrypted by Auto Route, so use a dedicated proxy credential when possible.

Browser proxy routing is domain/request based; it cannot reliably determine every form of censorship or distinguish every streaming CDN in advance. Other proxy-managing extensions or enterprise policies can take control of Chrome's proxy settings and prevent Auto Route from applying its rules.

The interface automatically follows the operating system's light or dark appearance.
