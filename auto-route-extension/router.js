(function (root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    schemaVersion: 1,
    enabled: false,
    proxy: {
      scheme: "https",
      host: "",
      port: 443,
      username: "",
      password: ""
    },
    proxyRu: true,
    autoRetry: true,
    retryHttp403: false,
    autoDirectMedia: true,
    mediaFailureFallback: true,
    manualProxyDomains: [],
    learnedProxyDomains: [],
    directDomains: [],
    directMediaDomains: []
  });

  const PROXY_SCHEMES = Object.freeze(["http", "https", "socks4", "socks5"]);
  const MEDIA_PATH_RE = /\.(?:m3u8|mpd|m4s|ts|mp4|m4v|webm|mkv|mov|avi|flv|aac|m4a|mp3|ogg|ogv|opus)(?:$|[?#])/i;

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  function normalizeDomain(value) {
    if (typeof value !== "string") return "";
    let candidate = value.trim().toLowerCase();
    if (!candidate) return "";
    candidate = candidate.replace(/^\*\./, "").replace(/^\.+/, "");

    try {
      const url = new URL(candidate.includes("://") ? candidate : `http://${candidate}`);
      candidate = url.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
    } catch (_) {
      candidate = candidate.split(/[/?#]/, 1)[0].replace(/^\.+|\.+$/g, "");
    }

    if (!candidate || /\s/.test(candidate)) return "";
    return candidate;
  }

  function normalizeProxyHost(value) {
    if (typeof value !== "string") return "";
    let candidate = value.trim();
    if (!candidate) return "";
    try {
      const url = new URL(candidate.includes("://") ? candidate : `http://${candidate}`);
      return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch (_) {
      return candidate.replace(/^\[|\]$/g, "").toLowerCase();
    }
  }

  function uniqueDomains(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const domain = normalizeDomain(value);
      if (domain && !seen.has(domain)) {
        seen.add(domain);
        result.push(domain);
      }
    }
    return result.sort();
  }

  function domainMatches(host, rule) {
    const normalizedHost = normalizeDomain(host);
    const normalizedRule = normalizeDomain(rule);
    if (!normalizedHost || !normalizedRule) return false;
    return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
  }

  function anyDomainMatches(host, rules) {
    return uniqueDomains(rules).some((rule) => domainMatches(host, rule));
  }

  function sanitizeSettings(input) {
    const source = input && typeof input === "object" ? input : {};
    const proxySource = source.proxy && typeof source.proxy === "object" ? source.proxy : {};
    const scheme = PROXY_SCHEMES.includes(proxySource.scheme) ? proxySource.scheme : DEFAULTS.proxy.scheme;
    const rawPort = Number(proxySource.port);
    const defaultPort = scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80;
    const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : defaultPort;

    return {
      schemaVersion: 1,
      enabled: Boolean(source.enabled),
      proxy: {
        scheme,
        host: normalizeProxyHost(proxySource.host || ""),
        port,
        username: typeof proxySource.username === "string" ? proxySource.username : "",
        password: typeof proxySource.password === "string" ? proxySource.password : ""
      },
      proxyRu: source.proxyRu !== false,
      autoRetry: source.autoRetry !== false,
      retryHttp403: Boolean(source.retryHttp403),
      autoDirectMedia: source.autoDirectMedia !== false,
      mediaFailureFallback: source.mediaFailureFallback !== false,
      manualProxyDomains: uniqueDomains(source.manualProxyDomains),
      learnedProxyDomains: uniqueDomains(source.learnedProxyDomains),
      directDomains: uniqueDomains(source.directDomains),
      directMediaDomains: uniqueDomains(source.directMediaDomains)
    };
  }

  function isMediaUrl(url) {
    return typeof url === "string" && MEDIA_PATH_RE.test(url);
  }

  function decideRoute(host, settingsInput, runtime) {
    const settings = sanitizeSettings(settingsInput);
    const state = runtime && typeof runtime === "object" ? runtime : {};
    const normalizedHost = normalizeDomain(host);
    if (!normalizedHost || !settings.enabled || !settings.proxy.host) return "direct";

    if (anyDomainMatches(normalizedHost, state.mediaProxyDomains)) return "proxy";
    if (anyDomainMatches(normalizedHost, settings.directDomains)) return "direct";
    if (anyDomainMatches(normalizedHost, settings.directMediaDomains)) return "direct";
    if (anyDomainMatches(normalizedHost, state.temporaryProxyDomains)) return "proxy";
    if (anyDomainMatches(normalizedHost, settings.manualProxyDomains)) return "proxy";
    if (anyDomainMatches(normalizedHost, settings.learnedProxyDomains)) return "proxy";
    if (settings.proxyRu && (normalizedHost === "ru" || normalizedHost.endsWith(".ru"))) return "proxy";
    return "direct";
  }

  function proxyDirective(proxy) {
    const keyword = {
      http: "PROXY",
      https: "HTTPS",
      socks4: "SOCKS",
      socks5: "SOCKS5"
    }[proxy.scheme] || "PROXY";
    const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
    return `${keyword} ${host}:${proxy.port}`;
  }

  function buildPacScript(settingsInput, runtime) {
    const settings = sanitizeSettings(settingsInput);
    const state = runtime && typeof runtime === "object" ? runtime : {};
    const temporary = uniqueDomains(state.temporaryProxyDomains);
    const mediaFallback = uniqueDomains(state.mediaProxyDomains);
    const proxyDomains = uniqueDomains([
      ...temporary,
      ...settings.manualProxyDomains,
      ...settings.learnedProxyDomains
    ]);
    const directDomains = uniqueDomains(settings.directDomains);
    const directMediaDomains = uniqueDomains(settings.directMediaDomains);
    const proxyHost = normalizeDomain(settings.proxy.host);
    const directive = proxyDirective(settings.proxy);

    return `
function FindProxyForURL(url, host) {
  host = (host || "").toLowerCase();
  var proxy = ${JSON.stringify(`${directive}; DIRECT`)};
  var proxyHost = ${JSON.stringify(proxyHost)};
  var proxyDomains = ${JSON.stringify(proxyDomains)};
  var directDomains = ${JSON.stringify(directDomains)};
  var directMediaDomains = ${JSON.stringify(directMediaDomains)};
  var mediaFallback = ${JSON.stringify(mediaFallback)};

  function matches(domain) {
    return host === domain || (host.length > domain.length && host.slice(-(domain.length + 1)) === "." + domain);
  }
  function matchesAny(domains) {
    for (var i = 0; i < domains.length; i++) {
      if (matches(domains[i])) return true;
    }
    return false;
  }
  function isPrivateOrLocal() {
    if (isPlainHostName(host) || host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    var match = /^172\.(\d+)\./.exec(host);
    return match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
  }
  function looksLikeMedia() {
    return /\\.(m3u8|mpd|m4s|ts|mp4|m4v|webm|mkv|mov|avi|flv|aac|m4a|mp3|ogg|ogv|opus)([?#]|$)/i.test(url);
  }

  if (isPrivateOrLocal() || (proxyHost && host === proxyHost)) return "DIRECT";
  if (matchesAny(mediaFallback)) return proxy;
  if (matchesAny(directDomains)) return "DIRECT";
  if (${settings.autoDirectMedia ? "true" : "false"} && looksLikeMedia()) return "DIRECT";
  if (matchesAny(directMediaDomains)) return "DIRECT";
  if (matchesAny(proxyDomains)) return proxy;
  if (${settings.proxyRu ? "true" : "false"} && (host === "ru" || /\\.ru$/.test(host))) return proxy;
  return "DIRECT";
}`.trim();
  }

  const api = {
    DEFAULTS,
    PROXY_SCHEMES,
    cloneDefaults,
    normalizeDomain,
    normalizeProxyHost,
    uniqueDomains,
    domainMatches,
    anyDomainMatches,
    sanitizeSettings,
    isMediaUrl,
    decideRoute,
    proxyDirective,
    buildPacScript
  };

  root.RouteCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
