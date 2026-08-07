importScripts("router.js");

"use strict";

const { DEFAULTS, sanitizeSettings, normalizeDomain, decideRoute, buildPacScript, isMediaUrl, uniqueDomains } = RouteCore;
const RUNTIME_KEY = "_autoRouteRuntime";
const RUNTIME_DEFAULTS = Object.freeze({
  retryByTab: {},
  mediaProxyDomains: [],
  mediaFailures: {},
  lastStatus: { ok: false, message: "Open the Auto Route companion app", updatedAt: 0 },
  nativeConnected: false
});

function callChrome(method, ...args) {
  return new Promise((resolve, reject) => {
    method(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function readLocal(defaults) {
  return callChrome(chrome.storage.local.get.bind(chrome.storage.local), defaults);
}

async function writeLocal(value) {
  return callChrome(chrome.storage.local.set.bind(chrome.storage.local), value);
}

async function getSettings() {
  return sanitizeSettings(await readLocal(DEFAULTS));
}

async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  await writeLocal(clean);
  return clean;
}

async function getRuntime() {
  const stored = await readLocal({ [RUNTIME_KEY]: RUNTIME_DEFAULTS });
  const source = stored[RUNTIME_KEY] || {};
  return {
    retryByTab: source.retryByTab && typeof source.retryByTab === "object" ? source.retryByTab : {},
    mediaProxyDomains: uniqueDomains(source.mediaProxyDomains),
    mediaFailures: source.mediaFailures && typeof source.mediaFailures === "object" ? source.mediaFailures : {},
    lastStatus: source.lastStatus && typeof source.lastStatus === "object" ? source.lastStatus : RUNTIME_DEFAULTS.lastStatus,
    nativeConnected: Boolean(source.nativeConnected)
  };
}

async function saveRuntime(runtime) {
  await writeLocal({ [RUNTIME_KEY]: runtime });
}

function temporaryDomains(runtime) {
  return uniqueDomains(Object.values(runtime.retryByTab)
    .filter((item) => item && (item.state === "switching" || item.state === "proxy-navigation"))
    .map((item) => item.host));
}

function routingState(runtime) {
  return { temporaryProxyDomains: temporaryDomains(runtime), mediaProxyDomains: runtime.mediaProxyDomains };
}

async function sendNative(payload) {
  return callChrome(chrome.runtime.sendNativeMessage.bind(chrome.runtime), "com.autoroute.app", payload);
}

async function syncNative() {
  const settings = await getSettings();
  const runtime = await getRuntime();
  const pacScript = settings.enabled && settings.proxy.host
    ? buildPacScript(settings, routingState(runtime))
    : "function FindProxyForURL(url, host) { return 'DIRECT'; }";

  try {
    const response = await sendNative({
      type: "applyRouting",
      enabled: settings.enabled,
      pacScript,
      proxyHost: settings.proxy.host,
      proxyPort: settings.proxy.port,
      proxyScheme: settings.proxy.scheme
    });
    runtime.nativeConnected = Boolean(response && response.ok && response.serverReady);
    runtime.lastStatus = {
      ok: Boolean(response && response.ok),
      message: response && response.message ? response.message : "Safari routing rules updated",
      updatedAt: Date.now()
    };
  } catch (error) {
    runtime.nativeConnected = false;
    runtime.lastStatus = { ok: false, message: "Open the Auto Route companion app", updatedAt: Date.now() };
  }
  await saveRuntime(runtime);
  return runtime;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch (_) { return null; }
}

async function beginRetry(tabId, rawUrl, reason) {
  const url = safeUrl(rawUrl);
  if (!url || tabId < 0) return { ok: false, message: "This page cannot be retried" };
  const settings = await getSettings();
  if (!settings.enabled || !settings.proxy.host) return { ok: false, message: "Configure and enable a proxy first" };

  const runtime = await getRuntime();
  const host = normalizeDomain(url.hostname);
  const existing = runtime.retryByTab[String(tabId)];
  if (existing && existing.url === url.href && ["switching", "proxy-navigation", "failed"].includes(existing.state)) {
    return { ok: false, message: existing.state === "failed" ? "The proxy retry also failed" : "A proxy retry is already running" };
  }
  runtime.retryByTab[String(tabId)] = { host, url: url.href, reason, state: "switching", startedAt: Date.now() };
  await saveRuntime(runtime);
  await syncNative();
  await callChrome(chrome.tabs.reload.bind(chrome.tabs), tabId, { bypassCache: true });
  return { ok: true, message: `Retrying ${host} through the proxy` };
}

async function failRetry(tabId, retry) {
  const runtime = await getRuntime();
  runtime.retryByTab[String(tabId)] = { ...retry, state: "failed", finishedAt: Date.now() };
  await saveRuntime(runtime);
  await syncNative();
}

async function completeRetry(tabId, retry) {
  const settings = await getSettings();
  settings.learnedProxyDomains = uniqueDomains([...settings.learnedProxyDomains, retry.host]);
  await saveSettings(settings);
  const runtime = await getRuntime();
  delete runtime.retryByTab[String(tabId)];
  await saveRuntime(runtime);
  await syncNative();
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  (async () => {
    const url = safeUrl(details.url);
    if (!url) return;
    const runtime = await getRuntime();
    const retry = runtime.retryByTab[String(details.tabId)];
    if (retry && retry.state === "switching" && retry.host === normalizeDomain(url.hostname)) {
      runtime.retryByTab[String(details.tabId)] = { ...retry, state: "proxy-navigation" };
      await saveRuntime(runtime);
    } else if (retry && retry.state === "failed" && retry.url !== url.href) {
      delete runtime.retryByTab[String(details.tabId)];
      await saveRuntime(runtime);
    }
  })().catch(console.error);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  (async () => {
    const url = safeUrl(details.url);
    if (!url) return;
    const runtime = await getRuntime();
    const retry = runtime.retryByTab[String(details.tabId)];
    if (retry && retry.state === "proxy-navigation" && retry.host === normalizeDomain(url.hostname)) {
      await completeRetry(details.tabId, retry);
    }
  })().catch(console.error);
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  (async () => {
    const url = safeUrl(details.url);
    if (!url) return;
    const settings = await getSettings();
    const runtime = await getRuntime();
    const retry = runtime.retryByTab[String(details.tabId)];
    if (retry && retry.host === normalizeDomain(url.hostname)) {
      if (retry.state === "proxy-navigation") await failRetry(details.tabId, retry);
      return;
    }
    if (settings.autoRetry && decideRoute(url.hostname, settings, routingState(runtime)) === "direct") {
      await beginRetry(details.tabId, url.href, "navigation-error");
    }
  })().catch(console.error);
});

chrome.webRequest.onCompleted.addListener((details) => {
  if (details.type !== "main_frame" || details.tabId < 0) return;
  (async () => {
    const settings = await getSettings();
    const retryable = details.statusCode === 451 || (settings.retryHttp403 && details.statusCode === 403);
    if (!retryable || !settings.autoRetry) return;
    const url = safeUrl(details.url);
    const runtime = await getRuntime();
    if (url && decideRoute(url.hostname, settings, routingState(runtime)) === "direct") {
      await beginRetry(details.tabId, url.href, `http-${details.statusCode}`);
    }
  })().catch(console.error);
}, { urls: ["<all_urls>"], types: ["main_frame"] });

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (details.tabId < 0 || !(details.type === "media" || isMediaUrl(details.url))) return;
  (async () => {
    const url = safeUrl(details.url);
    if (!url) return;
    const settings = await getSettings();
    const runtime = await getRuntime();
    const host = normalizeDomain(url.hostname);
    if (!settings.mediaFailureFallback || decideRoute(host, settings, routingState(runtime)) !== "direct") return;
    const now = Date.now();
    const recent = (runtime.mediaFailures[host] || []).filter((stamp) => now - stamp < 15000);
    recent.push(now);
    runtime.mediaFailures[host] = recent;
    if (recent.length >= 3) {
      runtime.mediaProxyDomains = uniqueDomains([...runtime.mediaProxyDomains, host]);
      delete runtime.mediaFailures[host];
      await saveRuntime(runtime);
      await syncNative();
    } else await saveRuntime(runtime);
  })().catch(console.error);
}, { urls: ["<all_urls>"] });

async function handleMessage(message) {
  const type = message && message.type;
  if (type === "GET_STATE") {
    const settings = await getSettings();
    const runtime = await getRuntime();
    const url = safeUrl(message.url || "");
    const host = url ? normalizeDomain(url.hostname) : "";
    return {
      ok: true,
      platform: "safari",
      nativeConnected: runtime.nativeConnected,
      settings,
      host,
      route: host ? decideRoute(host, settings, routingState(runtime)) : "direct",
      mediaProxyDomains: runtime.mediaProxyDomains,
      lastStatus: runtime.lastStatus,
      levelOfControl: "native_companion"
    };
  }
  if (type === "SAVE_SETTINGS") {
    const settings = await saveSettings(message.settings);
    await syncNative();
    return { ok: true, settings };
  }
  if (type === "SET_ENABLED") {
    const settings = await getSettings();
    settings.enabled = Boolean(message.enabled);
    await saveSettings(settings);
    await syncNative();
    return { ok: true, settings };
  }
  if (type === "SET_CURRENT_ROUTE") {
    const url = safeUrl(message.url || "");
    if (!url) return { ok: false, message: "Open a normal web page first" };
    const host = normalizeDomain(url.hostname);
    const settings = await getSettings();
    settings.manualProxyDomains = settings.manualProxyDomains.filter((item) => item !== host);
    settings.learnedProxyDomains = settings.learnedProxyDomains.filter((item) => item !== host);
    settings.directDomains = settings.directDomains.filter((item) => item !== host);
    if (message.route === "proxy") settings.manualProxyDomains.push(host);
    if (message.route === "direct") settings.directDomains.push(host);
    await saveSettings(settings);
    await syncNative();
    return { ok: true, host, route: message.route };
  }
  if (type === "RETRY_CURRENT") return beginRetry(message.tabId, message.url, "manual");
  if (type === "CLEAR_MEDIA_FALLBACKS") {
    const runtime = await getRuntime();
    runtime.mediaProxyDomains = [];
    runtime.mediaFailures = {};
    await saveRuntime(runtime);
    await syncNative();
    return { ok: true };
  }
  return { ok: false, message: "Unknown request" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  getSettings().then(saveSettings).then(syncNative).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const runtime = await getRuntime();
    delete runtime.retryByTab[String(tabId)];
    await saveRuntime(runtime);
    await syncNative();
  })().catch(console.error);
});

syncNative().catch(console.error);
