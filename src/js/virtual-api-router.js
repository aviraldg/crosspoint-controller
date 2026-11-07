/* global hubLog, DEFAULT_DEVICE_SECRET, PLUGIN_ROOTS, deobfuscateStr, obfuscateStr, nativeFetch, WEB_HUB_VERSION, FIRMWARE_FAMILY, PLUGIN_API_VERSION, PLUGIN_CAPABILITIES, normalizeVPath, uint8ToBase64, base64ToUint8 */
/* exported activeBackend, loadJsonFile, saveJsonFile, getDeviceSecret, getPluginDeviceId, scanInstalledPlugins, findPluginDir, buildSettingsArray, applySettingsUpdates, jsonResponse, textResponse, fetchWithTimeoutAndRetry, performOutboundFetch, handleVirtualRequest */

let activeBackend = null;

async function loadJsonFile(vpath, fallback = {}) {
  try {
    if (await activeBackend.exists(vpath)) {
      const raw = await activeBackend.readFile(vpath);
      return JSON.parse(new TextDecoder().decode(raw));
    }
  } catch (e) {
    hubLog("warn", "fs", `Failed to parse JSON at ${vpath}: ${e.message || e}`);
  }
  return fallback;
}

async function saveJsonFile(vpath, obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
  await activeBackend.writeFile(vpath, bytes);
}

async function getDeviceSecret() {
  try {
    if (await activeBackend.exists("/.crosspoint/device_secret.bin")) {
      const raw = await activeBackend.readFile("/.crosspoint/device_secret.bin");
      if (raw.length === 32) return raw;
    }
  } catch {
    // Fallback to default device secret
  }
  return DEFAULT_DEVICE_SECRET;
}

async function getPluginDeviceId(pluginName) {
  const secret = await getDeviceSecret();
  const pBytes = new TextEncoder().encode(
    String(pluginName || "")
      .trim()
      .toLowerCase()
      .slice(0, 64),
  );
  const combined = new Uint8Array(secret.length + pBytes.length);
  combined.set(secret, 0);
  combined.set(pBytes, secret.length);
  const hashBuf = await crypto.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function scanInstalledPlugins() {
  const seen = new Set();
  const out = [];
  for (const root of PLUGIN_ROOTS) {
    const entries = await activeBackend.listDir(root);
    for (const e of entries) {
      if (!e.isDir) continue;
      const key = e.name.toLowerCase();
      if (seen.has(key)) continue;
      const pdir = `${root}/${e.name}`;
      if (!(await activeBackend.exists(`${pdir}/plugin.js`))) continue;
      seen.add(key);
      const item = { name: e.name, dir: pdir, title: e.name, mount: "settings" };
      if (await activeBackend.exists(`${pdir}/manifest.json`)) {
        try {
          const m = await loadJsonFile(`${pdir}/manifest.json`, {});
          if (typeof m.title === "string" && m.title) item.title = m.title;
          if (typeof m.mount === "string" && m.mount) item.mount = m.mount;
        } catch {
          // Ignore malformed manifest.json
        }
      }
      out.push(item);
    }
  }
  hubLog(
    "info",
    "plugins",
    `Discovered ${out.length} web plugin(s)`,
    out.map((p) => p.name),
  );
  return out;
}

async function findPluginDir(name) {
  const target = String(name || "").toLowerCase();
  for (const root of PLUGIN_ROOTS) {
    const entries = await activeBackend.listDir(root);
    for (const e of entries) {
      if (e.isDir && e.name.toLowerCase() === target) return `${root}/${e.name}`;
    }
  }
  return "";
}

async function buildSettingsArray(keysFilter) {
  const stored = await loadJsonFile("/.crosspoint/settings.json", {});
  const kr = await loadJsonFile("/.crosspoint/koreader.json", {});
  const krHeaders = Array.isArray(kr.headers) ? kr.headers : [];
  while (krHeaders.length < 2) krHeaders.push({ name: "", value_obf: "" });
  const krPass = deobfuscateStr(kr.password_obf || "") || kr.password || "";
  const h1Val = deobfuscateStr(krHeaders[0].value_obf || "");
  const h2Val = deobfuscateStr(krHeaders[1].value_obf || "");

  const items = [
    {
      key: "koUsername",
      name: "KOReader Username",
      category: "KOReader Sync",
      type: "string",
      value: kr.username || "",
    },
    {
      key: "koPassword",
      name: "KOReader Password",
      category: "KOReader Sync",
      type: "string",
      value: null,
      hasPassword: !!krPass,
    },
    {
      key: "koServerUrl",
      name: "Sync Server URL",
      category: "KOReader Sync",
      type: "string",
      value: kr.serverUrl ?? kr.server_url ?? "",
    },
    {
      key: "koHeader1Name",
      name: "Custom Header 1 Name",
      category: "KOReader Sync",
      type: "string",
      value: krHeaders[0].name || "",
    },
    {
      key: "koHeader1Value",
      name: "Custom Header 1 Value",
      category: "KOReader Sync",
      type: "string",
      value: null,
      hasPassword: !!h1Val,
    },
    {
      key: "koHeader2Name",
      name: "Custom Header 2 Name",
      category: "KOReader Sync",
      type: "string",
      value: krHeaders[1].name || "",
    },
    {
      key: "koHeader2Value",
      name: "Custom Header 2 Value",
      category: "KOReader Sync",
      type: "string",
      value: null,
      hasPassword: !!h2Val,
    },
    {
      key: "koServerType",
      name: "Server Type",
      category: "KOReader Sync",
      type: "enum",
      value: Number(kr.serverType ?? 0),
      options: ["CrossPoint", "KOReader Sync Server", "Other"],
    },
    {
      key: "koMatchMethod",
      name: "Document Matching",
      category: "KOReader Sync",
      type: "enum",
      value: Number(kr.matchMethod ?? kr.match_method ?? 0),
      options: ["Filename", "Binary"],
    },
    {
      key: "koSendMetadata",
      name: "Send Metadata",
      category: "KOReader Sync",
      type: "toggle",
      value: (kr.sendMetadata ?? kr.send_metadata) ? 1 : 0,
    },
    {
      key: "koSyncBehavior",
      name: "Sync Behavior",
      category: "KOReader Sync",
      type: "enum",
      value: Number(kr.syncBehavior ?? kr.sync_behavior ?? 0),
      options: ["Ask Every Time", "Smart Sync"],
    },
    {
      key: "koSyncClippings",
      name: "Sync Clippings",
      category: "KOReader Sync",
      type: "toggle",
      value: kr.syncClippings ? 1 : 0,
    },
    {
      key: "extraParagraphSpacing",
      name: "Paragraph Spacing",
      category: "Reader",
      type: "toggle",
      value: Number(stored.extraParagraphSpacing ?? 1),
    },
    {
      key: "hyphenationEnabled",
      name: "Hyphenation",
      category: "Reader",
      type: "toggle",
      value: Number(stored.hyphenationEnabled ?? 1),
    },
    {
      key: "screenMargin",
      name: "Screen Margin",
      category: "Reader",
      type: "value",
      value: Number(stored.screenMargin ?? 5),
      min: 0,
      max: 40,
      step: 1,
    },
    {
      key: "showHiddenFiles",
      name: "Show Hidden Files",
      category: "System",
      type: "toggle",
      value: Number(stored.showHiddenFiles ?? 0),
    },
    {
      key: "libraryUseMetadata",
      name: "Library Use Metadata",
      category: "System",
      type: "toggle",
      value: Number(stored.libraryUseMetadata ?? 1),
    },
    {
      key: "clockShowHeader",
      name: "Clock in Header",
      category: "Status Bar",
      type: "toggle",
      value: Number(stored.clockShowHeader ?? 0),
    },
  ];
  if (keysFilter && keysFilter.size > 0) {
    return items.filter((i) => keysFilter.has(i.key));
  }
  return items;
}

async function applySettingsUpdates(updates) {
  const stored = await loadJsonFile("/.crosspoint/settings.json", {});
  const kr = await loadJsonFile("/.crosspoint/koreader.json", {});
  if (!("cfgVersion" in kr)) kr.cfgVersion = 3;
  const krHeaders = Array.isArray(kr.headers) ? kr.headers : [];
  while (krHeaders.length < 2) krHeaders.push({ name: "", value_obf: "" });
  let krChanged = false;
  let storedChanged = false;

  for (const [k, v] of Object.entries(updates || {})) {
    if (k === "koUsername" || k === "koreaderUsername") {
      kr.username = String(v);
      krChanged = true;
    } else if (k === "koPassword" || k === "koreaderPassword") {
      kr.password_obf = obfuscateStr(String(v));
      delete kr.password;
      krChanged = true;
    } else if (k === "koServerUrl" || k === "koreaderSyncServerUrl") {
      kr.serverUrl = String(v);
      krChanged = true;
    } else if (k === "koHeader1Name") {
      krHeaders[0].name = String(v);
      krChanged = true;
    } else if (k === "koHeader1Value") {
      krHeaders[0].value_obf = obfuscateStr(String(v));
      krChanged = true;
    } else if (k === "koHeader2Name") {
      krHeaders[1].name = String(v);
      krChanged = true;
    } else if (k === "koHeader2Value") {
      krHeaders[1].value_obf = obfuscateStr(String(v));
      krChanged = true;
    } else if (k === "koServerType") {
      kr.serverType = Number(v);
      krChanged = true;
    } else if (k === "koMatchMethod" || k === "koreaderMatchMethod") {
      kr.matchMethod = Number(v);
      krChanged = true;
    } else if (k === "koSendMetadata" || k === "koreaderSendMetadata") {
      kr.sendMetadata = Boolean(Number(v));
      krChanged = true;
    } else if (k === "koSyncBehavior" || k === "koreaderSyncBehavior") {
      kr.syncBehavior = Number(v);
      krChanged = true;
    } else if (k === "koSyncClippings") {
      kr.syncClippings = Boolean(Number(v));
      krChanged = true;
    } else {
      stored[k] = v;
      storedChanged = true;
    }
  }
  stored.pluginsEnabled = 1;
  if (krChanged) {
    kr.headers = krHeaders;
    await saveJsonFile("/.crosspoint/koreader.json", kr);
  }
  if (storedChanged || !(await activeBackend.exists("/.crosspoint/settings.json"))) {
    await saveJsonFile("/.crosspoint/settings.json", stored);
  }
}

function jsonResponse(status, obj, extraHeaders = {}) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  return new Response(body, {
    status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, extraHeaders),
  });
}

function textResponse(
  status,
  text,
  contentType = "text/plain; charset=utf-8",
  extraHeaders = {},
) {
  return new Response(text, {
    status,
    headers: Object.assign({ "Content-Type": contentType }, extraHeaders),
  });
}

async function fetchWithTimeoutAndRetry(
  doFetch,
  url,
  fetchOpts,
  timeoutMs = 30000,
  maxAttempts = 3,
) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl
      ? setTimeout(() => ctrl.abort(new Error(`HTTP timeout after ${timeoutMs}ms`)), timeoutMs)
      : null;
    try {
      const opts = ctrl ? Object.assign({}, fetchOpts, { signal: ctrl.signal }) : fetchOpts;
      const resp = await doFetch(url, opts);
      if ((resp.status === 429 || resp.status >= 502) && attempt < maxAttempts) {
        hubLog(
          "warn",
          "http-retry",
          `HTTP ${resp.status} from ${url}, retrying (${attempt + 1}/${maxAttempts})…`,
        );
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        hubLog(
          "warn",
          "http-retry",
          `Fetch error for ${url} (attempt ${attempt}/${maxAttempts}): ${err.message || err}`,
        );
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function performOutboundFetch(url, method, headersObj, bodyStr) {
  const doFetch = window.__outboundFetch || nativeFetch;
  const fetchOpts = {
    method,
    headers: headersObj || {},
    credentials: "omit",
    mode: "cors",
  };
  if (method !== "GET" && method !== "HEAD" && bodyStr) {
    fetchOpts.body = bodyStr;
  }
  try {
    return await fetchWithTimeoutAndRetry(doFetch, url, fetchOpts, 30000, 2);
  } catch {
    if (activeBackend && typeof activeBackend.relayHttp === "function") {
      try {
        const rel = await activeBackend.relayHttp({
          url,
          method,
          headers: headersObj || {},
          body: bodyStr || "",
        });
        return new Response(rel.bodyBytes, {
          status: rel.status,
          headers: { "Content-Type": "application/octet-stream" },
        });
      } catch (serialRelayErr) {
        hubLog(
          "warn",
          "relay",
          "Playdate WebSerial HTTP relay fallback failed: " +
            (serialRelayErr.message || serialRelayErr),
        );
      }
    }
    const proxyUrl = "https://corsproxy.io/?url=" + encodeURIComponent(url);
    return await fetchWithTimeoutAndRetry(doFetch, proxyUrl, fetchOpts, 30000, 2);
  }
}

async function handleVirtualRequest(urlObj, method, init) {
  const route = urlObj.pathname;
  const qs = urlObj.searchParams;

  const parseBodyText = async () => {
    if (!init || !init.body) return "";
    if (typeof init.body === "string") return init.body;
    if (init.body instanceof URLSearchParams) return init.body.toString();
    if (init.body instanceof FormData) {
      const obj = {};
      for (const [k, v] of init.body.entries()) {
        if (typeof v === "string") obj[k] = v;
      }
      return JSON.stringify(obj);
    }
    return await new Response(init.body).text();
  };

  if (route === "/api/status" && method === "GET") {
    const resp = {
      version:
        activeBackend && activeBackend.deviceVersion
          ? activeBackend.deviceVersion
          : WEB_HUB_VERSION,
      hubVersion: WEB_HUB_VERSION,
      firmwareFamily: FIRMWARE_FAMILY,
      pluginApi: PLUGIN_API_VERSION,
      pluginCapabilities: PLUGIN_CAPABILITIES,
      ip: "127.0.0.1",
      mode: "STA",
      rssi: -45,
      freeHeap: 8388608,
      uptime: 3600,
      device: "Playdate",
      deviceModel: "Playdate",
      psramBytes: 16 * 1024 * 1024,
      serial: "Playdate",
      storageMode: activeBackend.modeName,
      storageTarget: activeBackend.targetDescription,
    };
    const plugin = qs.get("plugin");
    if (plugin) resp.deviceId = await getPluginDeviceId(plugin);
    return jsonResponse(200, resp);
  }

  if (route === "/api/plugins" && method === "GET") {
    return jsonResponse(200, await scanInstalledPlugins());
  }

  if (route === "/plugin" && method === "GET") {
    const name = qs.get("name") || qs.get("id") || "";
    const fn = qs.get("file") || "";
    if (!name || !fn || name.includes("..") || fn.includes("..")) {
      return textResponse(400, "bad plugin path");
    }
    const pdir = await findPluginDir(name);
    if (!pdir) return textResponse(404, "not found");
    const vpath = `${pdir}/${fn}`;
    if (!(await activeBackend.exists(vpath))) return textResponse(404, "not found");
    const bytes = await activeBackend.readFile(vpath);
    let mime = "application/octet-stream";
    if (fn.endsWith(".js")) mime = "application/javascript; charset=utf-8";
    else if (fn.endsWith(".json")) mime = "application/json; charset=utf-8";
    else if (fn.endsWith(".css")) mime = "text/css; charset=utf-8";
    else if (fn.endsWith(".html")) mime = "text/html; charset=utf-8";
    return new Response(bytes, { status: 200, headers: { "Content-Type": mime } });
  }

  if (route === "/api/relay" && method === "POST") {
    const req = JSON.parse((await parseBodyText()) || "{}");
    const targetUrl = req.url || "";
    const reqMethod = String(req.method || "GET").toUpperCase();
    const reqHeaders = req.headers || {};
    const reqBody = req.body || "";
    try {
      const up = await performOutboundFetch(targetUrl, reqMethod, reqHeaders, reqBody);
      const buf = await up.arrayBuffer();
      const hdrList = [];
      up.headers.forEach((v, k) => hdrList.push([k, v]));
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Relay-Status": String(up.status),
          "X-Relay-Headers": JSON.stringify(hdrList),
        },
      });
    } catch (e) {
      hubLog("error", "relay", `/api/relay failed for ${targetUrl}: ${e.message || e}`);
      return jsonResponse(502, { error: "relay failed: " + e.message });
    }
  }

  if (route === "/api/fetch" && method === "POST") {
    const req = JSON.parse((await parseBodyText()) || "{}");
    const targetUrl = req.url || "";
    const dest = normalizeVPath(req.dest || req.path || "");
    const reqMethod = String(req.method || "GET").toUpperCase();
    const reqHeaders = req.headers || {};
    const reqBody = req.body || "";
    if (!targetUrl || !dest || dest === "/") {
      return jsonResponse(400, { error: "bad url/dest" });
    }
    try {
      const doFetch = window.__outboundFetch || nativeFetch;
      let up;
      try {
        const fetchOpts = {
          method: reqMethod,
          headers: reqHeaders,
          credentials: "omit",
          mode: "cors",
        };
        if (reqMethod !== "GET" && reqMethod !== "HEAD" && reqBody) {
          fetchOpts.body = reqBody;
        }
        up = await fetchWithTimeoutAndRetry(doFetch, targetUrl, fetchOpts, 30000, 3);
      } catch {
        if (activeBackend && typeof activeBackend.relayHttp === "function") {
          const rel = await activeBackend.relayHttp({
            url: targetUrl,
            method: reqMethod,
            headers: reqHeaders,
            body: reqBody,
            dest,
          });
          return jsonResponse(200, {
            status: rel.status,
            bytes: rel.bytes,
            total: rel.bytes,
            complete: rel.status >= 200 && rel.status < 300,
          });
        }
        up = await performOutboundFetch(targetUrl, reqMethod, reqHeaders, reqBody);
      }
      const bytes = new Uint8Array(await up.arrayBuffer());
      if (up.status < 200 || up.status >= 300) {
        const errText = new TextDecoder().decode(bytes.subarray(0, 512));
        return jsonResponse(200, {
          status: up.status,
          bytes: 0,
          complete: false,
          error: "http status",
          body: errText,
        });
      }
      await activeBackend.writeFile(dest, bytes);
      return jsonResponse(200, {
        status: up.status,
        bytes: bytes.length,
        total: bytes.length,
        complete: true,
      });
    } catch (e) {
      hubLog(
        "error",
        "fetchToSd",
        `/api/fetch failed for ${targetUrl} -> ${dest}: ${e.message || e}`,
      );
      return jsonResponse(200, {
        status: -1,
        bytes: 0,
        complete: false,
        error: "transport failure: " + e.message,
      });
    }
  }

  if (route === "/api/plugin-fs" && method === "POST") {
    const target = normalizeVPath(qs.get("path") || "");
    if (!target || target === "/" || target === "/.crosspoint/device_secret.bin") {
      return jsonResponse(400, { error: "bad path" });
    }
    let bytes = null;
    if (init && init.body instanceof FormData) {
      const filePart = init.body.get("file");
      if (filePart && typeof filePart.arrayBuffer === "function") {
        bytes = new Uint8Array(await filePart.arrayBuffer());
      }
    }
    if (!bytes && init && init.body) {
      bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    }
    if (!bytes || bytes.length === 0) {
      return jsonResponse(400, { error: "empty body" });
    }
    await activeBackend.writeFile(target, bytes);
    return jsonResponse(200, { ok: true, bytes: bytes.length });
  }

  if (route === "/api/crypto" && method === "POST") {
    const req = JSON.parse((await parseBodyText()) || "{}");
    const op = req.op || "";
    if (op === "random") {
      const len = Math.max(0, Math.min(4096, Number(req.len ?? 16)));
      const buf = new Uint8Array(len);
      crypto.getRandomValues(buf);
      return jsonResponse(200, { data: uint8ToBase64(buf) });
    }
    if (op === "sha1" || op === "sha256") {
      const d = base64ToUint8(req.data || "");
      const digest = await crypto.subtle.digest(op === "sha1" ? "SHA-1" : "SHA-256", d);
      return jsonResponse(200, { data: uint8ToBase64(new Uint8Array(digest)) });
    }
    if (op === "aesenc" || op === "aesdec") {
      const k = base64ToUint8(req.key || "");
      const iv = base64ToUint8(req.iv || "");
      const d = base64ToUint8(req.data || "");
      const cryptoKey = await crypto.subtle.importKey("raw", k, { name: "AES-CBC" }, false, [
        op === "aesenc" ? "encrypt" : "decrypt",
      ]);
      const res = await crypto.subtle[op === "aesenc" ? "encrypt" : "decrypt"](
        { name: "AES-CBC", iv },
        cryptoKey,
        d,
      );
      return jsonResponse(200, { data: uint8ToBase64(new Uint8Array(res)) });
    }
    return jsonResponse(200, { error: "unsupported crypto op: " + op });
  }

  if (route === "/api/book-key" && method === "POST") {
    const req = JSON.parse((await parseBodyText()) || "{}");
    const bookPath = normalizeVPath(req.path || "");
    const keyBytes = base64ToUint8(req.key || "");
    const expires = BigInt(req.expires || 0);
    if (!bookPath || (keyBytes.length !== 16 && keyBytes.length !== 32)) {
      return jsonResponse(400, { error: "bad path/key" });
    }
    const blob = new Uint8Array(1 + 8 + keyBytes.length);
    blob[0] = keyBytes.length;
    const dv = new DataView(blob.buffer);
    dv.setBigInt64(1, expires, true);
    blob.set(keyBytes, 9);
    await activeBackend.writeFile(bookPath + ".key", blob);
    return jsonResponse(200, { ok: true });
  }

  if (route === "/api/settings" && method === "GET") {
    const keysParam = qs.get("keys") || "";
    const filter = keysParam
      ? new Set(
          keysParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : null;
    return jsonResponse(200, await buildSettingsArray(filter));
  }

  if (route === "/api/settings" && method === "POST") {
    const updates = JSON.parse((await parseBodyText()) || "{}");
    await applySettingsUpdates(updates);
    return textResponse(200, "OK");
  }

  if (route === "/api/files" && method === "GET") {
    const vpath = normalizeVPath(qs.get("path") || "/");
    const entries = await activeBackend.listDir(vpath);
    const stored = await loadJsonFile("/.crosspoint/settings.json", {});
    const showHidden = !!stored.showHiddenFiles;
    const inPluginDir =
      vpath.startsWith("/.crosspoint/plugins") || vpath.startsWith("/.plugins");
    const out = [];
    for (const e of entries) {
      if (!showHidden && !inPluginDir && e.name.startsWith(".")) continue;
      out.push({
        name: e.name,
        isDirectory: e.isDir,
        size: e.size,
        isEpub: !e.isDir && /\.(epub|xtc|xtch|txt|md)$/i.test(e.name),
      });
    }
    return jsonResponse(200, out);
  }

  if (route === "/download" && method === "GET") {
    const vpath = normalizeVPath(qs.get("path") || "");
    const hasHiddenSegment = vpath.split("/").some((seg) => seg.startsWith("."));
    if (!vpath || vpath === "/" || hasHiddenSegment) {
      return textResponse(403, "Cannot access system files");
    }
    if (!(await activeBackend.exists(vpath))) {
      return textResponse(404, "Item not found");
    }
    const bytes = await activeBackend.readFile(vpath);
    return new Response(bytes, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  if (route === "/upload" && method === "POST") {
    const destDir = normalizeVPath(qs.get("path") || "/");
    if (init && init.body instanceof FormData) {
      let lastFn = "";
      for (const [, val] of init.body.entries()) {
        if (val && typeof val.arrayBuffer === "function") {
          const fn = val.name || "uploaded.bin";
          const bytes = new Uint8Array(await val.arrayBuffer());
          await activeBackend.writeFile(normalizeVPath(`${destDir}/${fn}`), bytes);
          lastFn = fn;
        }
      }
      return textResponse(200, "File uploaded successfully: " + lastFn);
    }
    return textResponse(400, "No file uploaded");
  }

  if (route === "/mkdir" && method === "POST") {
    const bodyText = await parseBodyText();
    const params = new URLSearchParams(bodyText);
    const name = params.get("name") || "";
    const pathArg = params.get("path") || "/";
    const target = name ? normalizeVPath(`${pathArg}/${name}`) : normalizeVPath(pathArg);
    await activeBackend.mkdir(target);
    return textResponse(200, "Folder created: " + target);
  }

  if (route === "/rename" && method === "POST") {
    const params = new URLSearchParams(await parseBodyText());
    const oldPath = normalizeVPath(params.get("path") || "");
    const newName = (params.get("name") || "").trim();
    const parent = oldPath.slice(0, oldPath.lastIndexOf("/")) || "/";
    const ok = await activeBackend.rename(oldPath, normalizeVPath(`${parent}/${newName}`));
    return textResponse(ok ? 200 : 404, ok ? "Renamed" : "Failed");
  }

  if (route === "/delete" && method === "POST") {
    const bodyText = await parseBodyText();
    let paths = [];
    try {
      const j = JSON.parse(bodyText);
      paths = Array.isArray(j.paths) ? j.paths : j.path ? [j.path] : [];
    } catch {
      const params = new URLSearchParams(bodyText);
      if (params.get("paths")) {
        try {
          paths = JSON.parse(params.get("paths"));
        } catch {
          paths = [params.get("paths")];
        }
      } else if (params.get("path")) {
        paths = [params.get("path")];
      }
    }
    for (const p of paths) {
      await activeBackend.remove(normalizeVPath(p));
    }
    return textResponse(200, "All items deleted successfully");
  }

  if (route === "/api/opds" && method === "GET") {
    const doc = await loadJsonFile("/.crosspoint/opds.json", { servers: [] });
    const servers = (doc.servers || []).map((s, idx) => ({
      index: idx,
      name: s.name || "",
      url: s.url || "",
      username: s.username || "",
      hasPassword: !!(s.password_obf || s.password),
    }));
    return jsonResponse(200, servers);
  }

  if (route === "/api/opds" && method === "POST") {
    const doc = await loadJsonFile("/.crosspoint/opds.json", { servers: [] });
    const servers = doc.servers || [];
    const body = JSON.parse((await parseBodyText()) || "{}");
    const entry = {
      name: body.name || "",
      url: body.url || "",
      username: body.username || "",
      password_obf: obfuscateStr(body.password || ""),
    };
    if (typeof body.index === "number" && body.index >= 0 && body.index < servers.length) {
      if (!("password" in body) && servers[body.index].password_obf) {
        entry.password_obf = servers[body.index].password_obf;
      }
      servers[body.index] = entry;
    } else {
      servers.push(entry);
    }
    doc.servers = servers;
    await saveJsonFile("/.crosspoint/opds.json", doc);
    return textResponse(200, "OK");
  }

  if (route === "/api/opds/delete" && method === "POST") {
    const doc = await loadJsonFile("/.crosspoint/opds.json", { servers: [] });
    const body = JSON.parse((await parseBodyText()) || "{}");
    if (
      typeof body.index === "number" &&
      body.index >= 0 &&
      body.index < (doc.servers || []).length
    ) {
      doc.servers.splice(body.index, 1);
      await saveJsonFile("/.crosspoint/opds.json", doc);
    }
    return textResponse(200, "OK");
  }

  if (route === "/api/fonts" && method === "GET") {
    const entries = await activeBackend.listDir("/.crosspoint/fonts");
    const families = [];
    for (const e of entries) {
      if (!e.isDir) continue;
      const sub = await activeBackend.listDir(`/.crosspoint/fonts/${e.name}`);
      const files = sub
        .filter((s) => !s.isDir && /\.(cpfont|epdfont|ttf|otf)$/i.test(s.name))
        .map((s) => ({ name: s.name, size: s.size }));
      if (files.length) families.push({ name: e.name, sizes: [], files });
    }
    return jsonResponse(200, { vectorFonts: true, families });
  }

  if (route === "/api/fonts/upload" && method === "POST") {
    if (init && init.body instanceof FormData) {
      const family = String(init.body.get("family") || "CustomFont").replace(
        /[^A-Za-z0-9_-]/g,
        "_",
      );
      const file = init.body.get("file");
      if (file && typeof file.arrayBuffer === "function") {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await activeBackend.writeFile(`/.crosspoint/fonts/${family}/${file.name}`, bytes);
        return jsonResponse(200, { ok: true });
      }
    }
    return jsonResponse(400, { ok: false, error: "Invalid font upload" });
  }

  if (route === "/api/fonts/delete" && method === "POST") {
    const body = JSON.parse((await parseBodyText()) || "{}");
    const fam = String(body.family || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (fam) await activeBackend.remove(`/.crosspoint/fonts/${fam}`);
    return jsonResponse(200, { ok: true });
  }

  if (route.startsWith("/api/plugin-jobs")) {
    return jsonResponse(200, {});
  }

  return jsonResponse(404, { error: "Unknown virtual route: " + route });
}

// Intercept window.fetch for virtual CrossPoint endpoints (supports root / and subpaths like /crosspoint-controller/)
const VIRTUAL_EXACT_ROUTES = new Set([
  "/plugin",
  "/download",
  "/upload",
  "/mkdir",
  "/rename",
  "/move",
  "/delete",
]);

function normalizeVirtualPathname(pathname) {
  if (!pathname) return "";
  if (pathname.startsWith("/api/") || VIRTUAL_EXACT_ROUTES.has(pathname)) {
    return pathname;
  }
  const baseDir = window.location.pathname.replace(/\/[^/]*$/, "");
  if (baseDir && baseDir !== "/" && pathname.startsWith(baseDir + "/")) {
    const stripped = pathname.slice(baseDir.length);
    if (stripped.startsWith("/api/") || VIRTUAL_EXACT_ROUTES.has(stripped)) {
      return stripped;
    }
  }
  return "";
}

window.fetch = async function (input, init) {
  let rawUrl = "";
  if (typeof input === "string") rawUrl = input;
  else if (input instanceof URL) rawUrl = input.href;
  else if (input && typeof input.url === "string") rawUrl = input.url;

  let isLocalRoute = false;
  let urlObj = null;
  try {
    if (rawUrl.startsWith("/")) {
      const candidate = new URL(rawUrl, "http://crosspoint.local");
      const vpath = normalizeVirtualPathname(candidate.pathname);
      if (vpath) {
        candidate.pathname = vpath;
        isLocalRoute = true;
        urlObj = candidate;
      }
    } else if (rawUrl) {
      const parsed = new URL(rawUrl, window.location.href);
      const sameOriginOrFile =
        parsed.origin === window.location.origin ||
        (window.location.protocol === "file:" && parsed.protocol === "file:");
      if (sameOriginOrFile) {
        const vpath = normalizeVirtualPathname(parsed.pathname);
        if (vpath) {
          parsed.pathname = vpath;
          isLocalRoute = true;
          urlObj = parsed;
        }
      }
    }
  } catch {
    // Pass through to nativeFetch
  }

  if (isLocalRoute && urlObj) {
    const method = (
      (init && init.method) ||
      (typeof input === "object" && input && input.method) ||
      "GET"
    ).toUpperCase();
    if (!activeBackend) {
      hubLog(
        "warn",
        "api",
        `${method} ${urlObj.pathname} called before Playdate was connected`,
      );
      return jsonResponse(503, { error: "Playdate not connected yet" });
    }
    try {
      const t0 = performance.now();
      const resp = await handleVirtualRequest(urlObj, method, init);
      const ms = (performance.now() - t0).toFixed(0);
      hubLog(
        "debug",
        "api",
        `${method} ${urlObj.pathname}${urlObj.search} -> HTTP ${resp.status} (${ms}ms)`,
      );
      return resp;
    } catch (err) {
      hubLog(
        "error",
        "api",
        `Exception in ${method} ${urlObj.pathname}: ${err.message || err}`,
        err,
      );
      return jsonResponse(500, { error: err.message || String(err) });
    }
  }
  return await nativeFetch(input, init);
};
