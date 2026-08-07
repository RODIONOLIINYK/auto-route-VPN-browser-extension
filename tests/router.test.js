"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");
const chromiumDir = path.join(repositoryRoot, "auto-route-extension");
const safariDir = path.join(repositoryRoot, "auto-route-safari-source", "WebExtension");
const core = require(path.join(chromiumDir, "router.js"));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const configured = core.sanitizeSettings({
  enabled: true,
  proxy: { scheme: "socks5", host: "proxy.example.net", port: 1080 },
  proxyRu: true,
  autoDirectMedia: true,
  manualProxyDomains: ["blocked.example"],
  learnedProxyDomains: ["learned.example"],
  directDomains: ["direct.blocked.example"],
  directMediaDomains: ["cdn.blocked.example"]
});

test("normalizes URL, wildcard, case, and duplicate domain input", () => {
  assert.equal(core.normalizeDomain(" HTTPS://News.Example.COM/path "), "news.example.com");
  assert.equal(core.normalizeDomain("*.Example.COM"), "example.com");
  assert.deepEqual(core.uniqueDomains(["EXAMPLE.com", "*.example.com", "two.example"]), ["example.com", "two.example"]);
});

test("matches a domain boundary without false suffix matches", () => {
  assert.equal(core.domainMatches("api.example.com", "example.com"), true);
  assert.equal(core.domainMatches("notexample.com", "example.com"), false);
});

test("sanitizes invalid proxy values conservatively", () => {
  const clean = core.sanitizeSettings({ enabled: 1, proxy: { scheme: "ftp", host: "https://Proxy.Example/path", port: 99999 } });
  assert.equal(clean.enabled, true);
  assert.equal(clean.proxy.scheme, "https");
  assert.equal(clean.proxy.host, "proxy.example");
  assert.equal(clean.proxy.port, 443);
});

test("applies routing precedence correctly", () => {
  assert.equal(core.decideRoute("site.ru", configured), "proxy");
  assert.equal(core.decideRoute("sub.blocked.example", configured), "proxy");
  assert.equal(core.decideRoute("learned.example", configured), "proxy");
  assert.equal(core.decideRoute("direct.blocked.example", configured), "direct");
  assert.equal(core.decideRoute("cdn.blocked.example", configured), "direct");
  assert.equal(core.decideRoute("other.example", configured), "direct");
  assert.equal(core.decideRoute("cdn.blocked.example", configured, { mediaProxyDomains: ["cdn.blocked.example"] }), "proxy");
  assert.equal(core.decideRoute("temporary.example", configured, { temporaryProxyDomains: ["temporary.example"] }), "proxy");
});

test("detects common media URLs", () => {
  assert.equal(core.isMediaUrl("https://cdn.example/segment.m4s?token=1"), true);
  assert.equal(core.isMediaUrl("https://cdn.example/page.html"), false);
});

test("generated PAC keeps local/private traffic and media direct", () => {
  const pac = core.buildPacScript(configured, {
    temporaryProxyDomains: ["temporary.example"],
    mediaProxyDomains: ["fallback-media.example"]
  });
  const context = vm.createContext({ isPlainHostName: (host) => !host.includes(".") });
  vm.runInContext(pac, context);
  const route = (url, host) => context.FindProxyForURL(url, host);

  assert.match(route("https://site.ru/", "site.ru"), /^SOCKS5 proxy\.example\.net:1080/);
  assert.match(route("https://sub.blocked.example/", "sub.blocked.example"), /^SOCKS5 proxy\.example\.net:1080/);
  assert.match(route("https://temporary.example/", "temporary.example"), /^SOCKS5 proxy\.example\.net:1080/);
  assert.match(route("https://fallback-media.example/video.m3u8", "fallback-media.example"), /^SOCKS5 proxy\.example\.net:1080/);
  assert.equal(route("https://site.ru/video.m3u8", "site.ru"), "DIRECT");
  assert.equal(route("https://direct.blocked.example/", "direct.blocked.example"), "DIRECT");
  assert.equal(route("http://192.168.1.4/", "192.168.1.4"), "DIRECT");
  assert.equal(route("http://proxy.example.net/", "proxy.example.net"), "DIRECT");
});

test("both manifests are MV3 and reference files that exist", () => {
  for (const directory of [chromiumDir, safariDir]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    const referenced = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      manifest.options_ui.page
    ];
    for (const file of referenced) assert.equal(fs.existsSync(path.join(directory, file)), true, `${file} is missing`);
  }
});

test("both themes follow the operating-system color scheme", () => {
  for (const directory of [chromiumDir, safariDir]) {
    for (const file of ["popup.css", "options.css"]) {
      const css = fs.readFileSync(path.join(directory, file), "utf8");
      assert.match(css, /color-scheme:\s*light\s+dark/);
      assert.match(css, /prefers-color-scheme:\s*dark/);
    }
    for (const file of ["popup.html", "options.html"]) {
      const html = fs.readFileSync(path.join(directory, file), "utf8");
      assert.match(html, /<meta\s+name="color-scheme"\s+content="light dark">/);
    }
  }
});

console.log("All Auto Route tests passed.");
