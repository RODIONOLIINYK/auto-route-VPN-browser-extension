importScripts("router.js");

"use strict";

const { DEFAULTS, sanitizeSettings, normalizeDomain, decideRoute, buildPacScript, isMediaUrl, uniqueDomains } = RouteCore;
const RUNTIME_DEFAULTS = Object.freeze({
  retryByTab: {},
  mediaProxyDomains: [],
  mediaFailures: {},
  tabOrigins: {},
  lastStatus: { ok: true, message: "Not configured", updatedAt: 0 }
});

let runtimeState = null;
let applyChain = Promise.resolve();
const proxyAuthAttempts = new Map();

function storageGet(area, defaults) {
  return new Promise((resolve, reject) => {
    area.get(defaults, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    });
  });
}

function storageSet(area, value) {
  return new Promise((resolve, reject) => {
    area.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function proxySet(value) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value, scope: "regular" }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function proxyClear() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function proxyGet() {
  return new Promise((resolve) => chrome.proxy.settings.get({ incognito: false }, resolve));
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function tabsReload(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function getSettings() {
  return sanitizeSettings(await storageGet(chrome.storage.local, DEFAULTS));
}

async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  await storageSet(chrome.storage.local, clean);
  return clean;
}

async function ensureRuntime() {
  if (runtimeState) return runtimeState;
  const stored = await storageGet(chrome.storage.session, RUNTIME_DEFAULTS);
  runtimeState = {
    retryByTab: stored.retryByTab && typeof stored.retryByTab === "object" ? stored.retryByTab : {},
    mediaProxyDomains: uniqueDomains(stored.mediaProxyDomains),
    mediaFailures: stored.mediaFailures && typeof stored.mediaFailures === "object" ? stored.mediaFailures : {},
    tabOrigins: stored.tabOrigins && typeof stored.tabOrigins === "object" ? stored.tabOrigins : {},
    lastStatus: stored.lastStatus && typeof stored.lastStatus === "object" ? stored.lastStatus : RUNTIME_DEFAULTS.lastStatus
  };
  return runtimeState;
}

async function persistRuntime() {
  const state = await ensureRuntime();
  await storageSet(chrome.storage.session, state);
}

function activeTemporaryDomains(state) {
  return uniqueDomains(Object.values(state.retryByTab)
    .filter((retry) => retry && (retry.state === "switching" || retry.state === "proxy-navigation"))
    .map((retry) => retry.host));
}

async function runtimeRoutingState() {
  const state = await ensureRuntime();
  return {
    temporaryProxyDomains: activeTemporaryDomains(state),
    mediaProxyDomains: state.mediaProxyDomains
  };
}

async function setLastStatus(ok, message) {
  const state = await ensureRuntime();
  state.lastStatus = { ok, message, updatedAt: Date.now() };
  await persistRuntime();
}

async function applyProxyNow() {
  const settings = await getSettings();
  const state = await runtimeRoutingState();

  try {
    if (!settings.enabled || !settings.proxy.host) {
      await proxyClear();
      await setLastStatus(true, settings.proxy.host ? "Routing is paused" : "Add a proxy server to begin");
      return;
    }

    const current = await proxyGet();
    const allowed = ["controllable_by_this_extension", "controlled_by_this_extension"];
    if (current && current.levelOfControl && !allowed.includes(current.levelOfControl)) {
      throw new Error("Chrome proxy settings are controlled by another extension or policy");
    }

    await proxySet({
      mode: "pac_script",
      pacScript: {
        data: buildPacScript(settings, state),
        mandatory: true
      }
    });
    await setLastStatus(true, "Selective routing is active");
  } catch (error) {
    await setLastStatus(false, error.message || "Could not apply proxy settings");
    throw error;
  }
}

function queueApplyProxy() {
  applyChain = applyChain.catch(() => undefined).then(applyProxyNow);
  return applyChain;
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

async function setBadge(tabId, text, color, title) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (title) await chrome.action.setTitle({ tabId, title }).catch(() => undefined);
}

async function updateBadgeForTab(tabId, url) {
  const parsed = safeUrl(url);
  if (!parsed) return setBadge(tabId, "", "#64748b", "Auto Route");
  const settings = await getSettings();
  const state = await runtimeRoutingState();
  const route = decideRoute(parsed.hostname, settings, state);
  if (!settings.enabled || !settings.proxy.host) {
    return setBadge(tabId, "OFF", "#64748b", "Auto Route is paused");
  }
  return route === "proxy"
    ? setBadge(tabId, "P", "#6d5dfc", `${parsed.hostname} uses the proxy`)
    : setBadge(tabId, "D", "#16a085", `${parsed.hostname} connects directly`);
}

async function beginRetry(tabId, url, reason) {
  const parsed = safeUrl(url);
  if (!parsed || tabId < 0) return { ok: false, message: "This page cannot be retried" };

  const settings = await getSettings();
  const state = await ensureRuntime();
  if (!settings.enabled || !settings.proxy.host) return { ok: false, message: "Configure and enable a proxy first" };

  const host = normalizeDomain(parsed.hostname);
  const existing = state.retryByTab[String(tabId)];
  if (existing && existing.url === parsed.href && ["switching", "proxy-navigation", "failed"].includes(existing.state)) {
    return { ok: false, message: existing.state === "failed" ? "The proxy retry also failed" : "A proxy retry is already running" };
  }

  state.retryByTab[String(tabId)] = {
    host,
    url: parsed.href,
    state: "switching",
    reason,
    startedAt: Date.now()
  };
  await persistRuntime();
  await queueApplyProxy();
  await setBadge(tabId, "…", "#f59e0b", `Retrying ${host} through the proxy`);
  await tabsReload(tabId);
  return { ok: true, message: `Retrying ${host} through the proxy` };
}

async function failRetry(tabId, retry) {
  const state = await ensureRuntime();
  state.retryByTab[String(tabId)] = { ...retry, state: "failed", finishedAt: Date.now() };
  await persistRuntime();
  await queueApplyProxy();
  await setBadge(tabId, "!", "#dc2626", `Proxy retry failed for ${retry.host}`);
}

async function completeRetry(tabId, retry) {
  const settings = await getSettings();
  settings.learnedProxyDomains = uniqueDomains([...settings.learnedProxyDomains, retry.host]);
  await saveSettings(settings);

  const state = await ensureRuntime();
  delete state.retryByTab[String(tabId)];
  await persistRuntime();
  await queueApplyProxy();
  await setBadge(tabId, "✓", "#16a085", `${retry.host} was learned and will use the proxy`);
}

async function handleNavigationError(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const parsed = safeUrl(details.url);
  if (!parsed) return;

  const settings = await getSettings();
  const state = await ensureRuntime();
  const retry = state.retryByTab[String(details.tabId)];
  if (retry && retry.host === normalizeDomain(parsed.hostname)) {
    if (retry.state === "proxy-navigation") await failRetry(details.tabId, retry);
    return;
  }

  if (!settings.autoRetry || !settings.enabled || !settings.proxy.host) return;
  const route = decideRoute(parsed.hostname, settings, await runtimeRoutingState());
  if (route === "direct") await beginRetry(details.tabId, parsed.href, "navigation-error");
}

async function handleNavigationBefore(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const parsed = safeUrl(details.url);
  if (!parsed) return;
  const state = await ensureRuntime();
  const retry = state.retryByTab[String(details.tabId)];
  if (retry && retry.state === "switching" && retry.host === normalizeDomain(parsed.hostname)) {
    state.retryByTab[String(details.tabId)] = { ...retry, state: "proxy-navigation" };
    await persistRuntime();
  } else if (retry && retry.url !== parsed.href && retry.state === "failed") {
    delete state.retryByTab[String(details.tabId)];
    await persistRuntime();
  }
}

async function handleNavigationCommitted(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const parsed = safeUrl(details.url);
  if (!parsed) return;
  const state = await ensureRuntime();
  state.tabOrigins[String(details.tabId)] = normalizeDomain(parsed.hostname);
  await persistRuntime();
  await updateBadgeForTab(details.tabId, parsed.href);
}

async function handleNavigationCompleted(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const parsed = safeUrl(details.url);
  if (!parsed) return;
  const state = await ensureRuntime();
  const retry = state.retryByTab[String(details.tabId)];
  if (retry && retry.state === "proxy-navigation" && retry.host === normalizeDomain(parsed.hostname)) {
    await completeRetry(details.tabId, retry);
  } else {
    await updateBadgeForTab(details.tabId, parsed.href);
  }
}

async function handleHttpCompletion(details) {
  proxyAuthAttempts.delete(details.requestId);
  if (details.type !== "main_frame" || details.tabId < 0) return;
  const settings = await getSettings();
  const shouldRetry = details.statusCode === 451 || (settings.retryHttp403 && details.statusCode === 403);
  if (!shouldRetry || !settings.autoRetry) return;

  const parsed = safeUrl(details.url);
  if (!parsed) return;
  const route = decideRoute(parsed.hostname, settings, await runtimeRoutingState());
  if (route === "direct") await beginRetry(details.tabId, parsed.href, `http-${details.statusCode}`);
  else {
    const state = await ensureRuntime();
    const retry = state.retryByTab[String(details.tabId)];
    if (retry && retry.state === "proxy-navigation") await failRetry(details.tabId, retry);
  }
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  const header = (headers || []).find((item) => item.name && item.name.toLowerCase() === target);
  return header && typeof header.value === "string" ? header.value : "";
}

function responseLooksLikeMedia(details) {
  return details.type === "media" || /^audio\//i.test(headerValue(details.responseHeaders, "content-type")) ||
    /^video\//i.test(headerValue(details.responseHeaders, "content-type")) || isMediaUrl(details.url);
}

async function handleMediaResponse(details) {
  proxyAuthAttempts.delete(details.requestId);
  if (details.tabId < 0 || !responseLooksLikeMedia(details)) return;
  const parsed = safeUrl(details.url);
  if (!parsed) return;
  const state = await ensureRuntime();
  const pageHost = state.tabOrigins[String(details.tabId)];
  const mediaHost = normalizeDomain(parsed.hostname);
  if (!pageHost || !mediaHost || pageHost === mediaHost) return;

  const settings = await getSettings();
  if (!settings.autoDirectMedia) return;
  const routing = await runtimeRoutingState();
  const pageRoute = decideRoute(pageHost, settings, routing);
  const mediaRoute = decideRoute(mediaHost, settings, routing);
  if (pageRoute === "proxy" && mediaRoute === "proxy" && !settings.directMediaDomains.includes(mediaHost)) {
    settings.directMediaDomains = uniqueDomains([...settings.directMediaDomains, mediaHost]);
    await saveSettings(settings);
    await queueApplyProxy();
  }
}

async function handleRequestError(details) {
  proxyAuthAttempts.delete(details.requestId);
  if (details.tabId < 0 || !(details.type === "media" || isMediaUrl(details.url))) return;
  const parsed = safeUrl(details.url);
  if (!parsed) return;

  const settings = await getSettings();
  if (!settings.enabled || !settings.proxy.host || !settings.mediaFailureFallback) return;
  const host = normalizeDomain(parsed.hostname);
  const routing = await runtimeRoutingState();
  if (decideRoute(host, settings, routing) !== "direct") return;

  const state = await ensureRuntime();
  const now = Date.now();
  const recent = (state.mediaFailures[host] || []).filter((timestamp) => now - timestamp < 15000);
  recent.push(now);
  state.mediaFailures[host] = recent;
  if (recent.length >= 3) {
    state.mediaProxyDomains = uniqueDomains([...state.mediaProxyDomains, host]);
    delete state.mediaFailures[host];
    await persistRuntime();
    await queueApplyProxy();
    await setBadge(details.tabId, "M", "#f59e0b", `${host} media temporarily falls back to the proxy`);
  } else {
    await persistRuntime();
  }
}

async function routeForUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return { host: "", route: "direct" };
  const settings = await getSettings();
  return {
    host: normalizeDomain(parsed.hostname),
    route: decideRoute(parsed.hostname, settings, await runtimeRoutingState())
  };
}

async function handleMessage(message, sender) {
  const type = message && message.type;
  if (type === "GET_STATE") {
    const settings = await getSettings();
    const state = await ensureRuntime();
    const result = await routeForUrl(message.url || (sender.tab && sender.tab.url) || "");
    const proxyInfo = await proxyGet();
    return {
      ok: true,
      platform: "chromium",
      nativeConnected: false,
      settings,
      host: result.host,
      route: result.route,
      mediaProxyDomains: state.mediaProxyDomains,
      lastStatus: state.lastStatus,
      levelOfControl: proxyInfo && proxyInfo.levelOfControl
    };
  }

  if (type === "SAVE_SETTINGS") {
    const settings = await saveSettings(message.settings);
    await queueApplyProxy();
    return { ok: true, settings };
  }

  if (type === "SET_ENABLED") {
    const settings = await getSettings();
    settings.enabled = Boolean(message.enabled);
    const saved = await saveSettings(settings);
    await queueApplyProxy();
    return { ok: true, settings: saved };
  }

  if (type === "SET_CURRENT_ROUTE") {
    const parsed = safeUrl(message.url || "");
    if (!parsed) return { ok: false, message: "Open a normal web page first" };
    const host = normalizeDomain(parsed.hostname);
    const settings = await getSettings();
    settings.manualProxyDomains = settings.manualProxyDomains.filter((item) => item !== host);
    settings.learnedProxyDomains = settings.learnedProxyDomains.filter((item) => item !== host);
    settings.directDomains = settings.directDomains.filter((item) => item !== host);
    if (message.route === "proxy") settings.manualProxyDomains.push(host);
    if (message.route === "direct") settings.directDomains.push(host);
    await saveSettings(settings);
    await queueApplyProxy();
    if (Number.isInteger(message.tabId)) await updateBadgeForTab(message.tabId, parsed.href);
    return { ok: true, host, route: message.route };
  }

  if (type === "RETRY_CURRENT") {
    return beginRetry(message.tabId, message.url, "manual");
  }

  if (type === "CLEAR_MEDIA_FALLBACKS") {
    const state = await ensureRuntime();
    state.mediaProxyDomains = [];
    state.mediaFailures = {};
    await persistRuntime();
    await queueApplyProxy();
    return { ok: true };
  }

  return { ok: false, message: "Unknown request" };
}

chrome.runtime.onInstalled.addListener(() => {
  getSettings().then(saveSettings).then(queueApplyProxy).catch((error) => setLastStatus(false, error.message));
});

chrome.runtime.onStartup.addListener(() => {
  ensureRuntime().then(queueApplyProxy).catch((error) => setLastStatus(false, error.message));
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  handleNavigationBefore(details).catch(console.error);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  handleNavigationCommitted(details).catch(console.error);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  handleNavigationCompleted(details).catch(console.error);
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  handleNavigationError(details).catch(console.error);
});

chrome.webRequest.onCompleted.addListener((details) => {
  handleHttpCompletion(details).catch(console.error);
  handleMediaResponse(details).catch(console.error);
}, { urls: ["<all_urls>"] }, ["responseHeaders"]);

chrome.webRequest.onErrorOccurred.addListener((details) => {
  handleRequestError(details).catch(console.error);
}, { urls: ["<all_urls>"] });

chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  if (!details.isProxy || proxyAuthAttempts.has(details.requestId)) {
    callback();
    return;
  }
  proxyAuthAttempts.set(details.requestId, true);
  getSettings()
    .then((settings) => {
      if (!settings.proxy.username) callback();
      else callback({ authCredentials: { username: settings.proxy.username, password: settings.proxy.password } });
    })
    .catch(() => callback());
}, { urls: ["<all_urls>"] }, ["asyncBlocking"]);

chrome.proxy.onProxyError.addListener((details) => {
  setLastStatus(false, details.error || details.details || "Proxy error").catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureRuntime().then(async (state) => {
    delete state.retryByTab[String(tabId)];
    delete state.tabOrigins[String(tabId)];
    await persistRuntime();
    await queueApplyProxy();
  }).catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) updateBadgeForTab(tabId, changeInfo.url).catch(console.error);
  else if (changeInfo.status === "complete" && tab.url) updateBadgeForTab(tabId, tab.url).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: error.message || "Unexpected error" }));
  return true;
});

ensureRuntime().then(queueApplyProxy).catch((error) => setLastStatus(false, error.message));
