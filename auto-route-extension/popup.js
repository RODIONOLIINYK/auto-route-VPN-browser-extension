"use strict";

const enabledToggle = document.getElementById("enabledToggle");
const currentDomain = document.getElementById("currentDomain");
const currentRoute = document.getElementById("currentRoute");
const connectionStatus = document.getElementById("connectionStatus");
const feedback = document.getElementById("feedback");
const retryButton = document.getElementById("retryButton");
const platformLabel = document.getElementById("platformLabel");
let activeTab = null;
let state = null;

function callChrome(method, ...args) {
  return new Promise((resolve, reject) => {
    method(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function send(message) {
  const response = await callChrome(chrome.runtime.sendMessage.bind(chrome.runtime), message);
  if (!response || response.ok === false) throw new Error((response && response.message) || "The extension did not respond");
  return response;
}

function showFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.classList.toggle("error", isError);
  feedback.hidden = false;
}

function selectedRoute(settings, host) {
  if (!host) return "auto";
  if (settings.directDomains.includes(host)) return "direct";
  if (settings.manualProxyDomains.includes(host)) return "proxy";
  return "auto";
}

function render(response) {
  state = response;
  enabledToggle.checked = response.settings.enabled;
  currentDomain.textContent = response.host || "No web page";
  currentRoute.className = `route-value ${response.settings.enabled ? response.route : "off"}`;
  currentRoute.innerHTML = `<span></span>${response.settings.enabled ? response.route.toUpperCase() : "OFF"}`;

  const configured = Boolean(response.settings.proxy.host);
  if (!configured) connectionStatus.textContent = "Add a proxy server in Settings to begin.";
  else if (!response.settings.enabled) connectionStatus.textContent = "Routing is paused; your browser settings are restored.";
  else connectionStatus.textContent = response.lastStatus.message || "Selective routing is active.";

  const route = selectedRoute(response.settings, response.host);
  document.querySelectorAll(".route-button").forEach((button) => {
    button.classList.toggle("selected", button.dataset.route === route);
    button.disabled = !response.host;
  });
  retryButton.disabled = !response.host || !configured || !response.settings.enabled;
  platformLabel.textContent = response.platform === "safari" ? "Safari companion routing" : "Selective proxy routing";

  if (!response.lastStatus.ok) showFeedback(response.lastStatus.message, true);
}

async function refresh() {
  if (!globalThis.chrome || !chrome.tabs || typeof chrome.tabs.query !== "function" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    render({
      platform: "chromium",
      settings: {
        enabled: true,
        proxy: { host: "proxy.example.com" },
        directDomains: [],
        manualProxyDomains: [],
        learnedProxyDomains: []
      },
      host: "example.com",
      route: "direct",
      lastStatus: { ok: true, message: "Selective routing is active" }
    });
    return;
  }
  try {
    const tabs = await callChrome(chrome.tabs.query.bind(chrome.tabs), { active: true, currentWindow: true });
    activeTab = tabs[0] || null;
    render(await send({ type: "GET_STATE", url: activeTab && activeTab.url }));
  } catch (error) {
    showFeedback(error.message, true);
  }
}

enabledToggle.addEventListener("change", async () => {
  try {
    await send({ type: "SET_ENABLED", enabled: enabledToggle.checked });
    await refresh();
  } catch (error) {
    enabledToggle.checked = !enabledToggle.checked;
    showFeedback(error.message, true);
  }
});

document.querySelectorAll(".route-button").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await send({ type: "SET_CURRENT_ROUTE", route: button.dataset.route, url: activeTab.url, tabId: activeTab.id });
      await refresh();
      showFeedback(`${currentDomain.textContent} now uses ${button.textContent.trim().toLowerCase()} routing.`);
    } catch (error) {
      showFeedback(error.message, true);
    }
  });
});

retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  try {
    const result = await send({ type: "RETRY_CURRENT", url: activeTab.url, tabId: activeTab.id });
    showFeedback(result.message || "Retry started.");
    window.close();
  } catch (error) {
    retryButton.disabled = false;
    showFeedback(error.message, true);
  }
});

document.getElementById("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
refresh();
