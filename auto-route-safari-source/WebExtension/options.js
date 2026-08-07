"use strict";

const fields = ["enabled", "proxyRu", "autoRetry", "retryHttp403", "autoDirectMedia", "mediaFailureFallback"];
const domainFields = ["manualProxyDomains", "directDomains", "learnedProxyDomains", "directMediaDomains"];
const form = document.getElementById("settingsForm");
const feedback = document.getElementById("formFeedback");
let settings = RouteCore.cloneDefaults();

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
  if (!isError) setTimeout(() => { feedback.hidden = true; }, 3500);
}

function splitDomains(value) {
  return RouteCore.uniqueDomains(String(value || "").split(/[\n,]+/));
}

function populate(response) {
  settings = RouteCore.sanitizeSettings(response.settings);
  for (const id of fields) document.getElementById(id).checked = settings[id];
  document.getElementById("scheme").value = settings.proxy.scheme;
  document.getElementById("host").value = settings.proxy.host;
  document.getElementById("port").value = settings.proxy.port;
  document.getElementById("username").value = settings.proxy.username;
  document.getElementById("password").value = settings.proxy.password;
  for (const id of domainFields) document.getElementById(id).value = settings[id].join("\n");

  const safariStatus = document.getElementById("safariStatus");
  if (response.platform === "safari") {
    safariStatus.classList.toggle("unavailable", !response.nativeConnected);
    safariStatus.querySelector("strong").textContent = response.nativeConnected
      ? "Safari companion is connected and active."
      : "Open the Auto Route companion app to apply routing changes.";
  } else {
    safariStatus.classList.add("unavailable");
    safariStatus.querySelector("strong").textContent = "Safari companion is only needed on macOS Safari.";
  }
}

function readForm() {
  const next = { ...settings, proxy: { ...settings.proxy } };
  for (const id of fields) next[id] = document.getElementById(id).checked;
  next.proxy.scheme = document.getElementById("scheme").value;
  next.proxy.host = document.getElementById("host").value;
  next.proxy.port = Number(document.getElementById("port").value);
  next.proxy.username = document.getElementById("username").value;
  next.proxy.password = document.getElementById("password").value;
  for (const id of domainFields) next[id] = splitDomains(document.getElementById(id).value);
  return RouteCore.sanitizeSettings(next);
}

async function load() {
  if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    const preview = RouteCore.cloneDefaults();
    preview.enabled = true;
    preview.proxy = { scheme: "socks5", host: "proxy.example.com", port: 1080, username: "", password: "" };
    preview.manualProxyDomains = ["example.com"];
    preview.directDomains = ["example-cdn.com"];
    preview.learnedProxyDomains = ["news.example.net"];
    preview.directMediaDomains = ["video.example.net"];
    populate({ settings: preview, platform: "safari", nativeConnected: true });
    return;
  }
  try {
    populate(await send({ type: "GET_STATE" }));
  } catch (error) {
    showFeedback(error.message, true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const next = readForm();
    if (next.enabled && !next.proxy.host) throw new Error("Enter a proxy host before enabling Auto Route.");
    const response = await send({ type: "SAVE_SETTINGS", settings: next });
    settings = response.settings;
    showFeedback("Settings saved and routing rules updated.");
  } catch (error) {
    showFeedback(error.message, true);
  }
});

document.getElementById("scheme").addEventListener("change", (event) => {
  const port = document.getElementById("port");
  if (!port.value || ["80", "443", "1080"].includes(port.value)) {
    port.value = event.target.value === "https" ? 443 : event.target.value.startsWith("socks") ? 1080 : 80;
  }
});

document.getElementById("clearLearned").addEventListener("click", async () => {
  document.getElementById("learnedProxyDomains").value = "";
  try {
    const next = readForm();
    await send({ type: "SAVE_SETTINGS", settings: next });
    settings = next;
    showFeedback("Learned domains cleared.");
  } catch (error) { showFeedback(error.message, true); }
});

document.getElementById("clearMedia").addEventListener("click", async () => {
  try {
    await send({ type: "CLEAR_MEDIA_FALLBACKS" });
    showFeedback("Temporary media fallbacks cleared.");
  } catch (error) { showFeedback(error.message, true); }
});

document.querySelectorAll("nav a").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll("nav a").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

load();
