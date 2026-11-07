/* global activeBackend:writable, showWebConfirm, showWebAlert, showWebToast, hubLog, clearDebugLogs, copyDebugLogs, normalizeVPath, uint8ToBase64, base64ToUint8, obfuscateStr, deobfuscateStr, setConnectionStatus, isVerboseSerialEnabled, FileSystemAccessBackend, WebSerialBackend, connectDirectoryPicker, connectWebSerial, isConnected, switchTab, refreshActiveTab, reloadPluginsTab, reloadFilesTab, downloadPlaydateFile, uploadSelectedFiles, promptCreateFolder, saveSettings, reloadFontsTab, uploadSelectedFonts, loadJsonFile, saveJsonFile, performOutboundFetch */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  build,
  getGitShortSha,
  resolveCrossPointReaderDir,
  transformPluginHostJs,
} from "../scripts/build.mjs";

// Set up simulated browser DOM & Web APIs in globalThis before loading src/js/*
const elements = new Map();

function makeElement(tag = "div", id = "") {
  const el = {
    tagName: tag.toUpperCase(),
    id,
    className: "",
    textContent: "",
    innerHTML: "",
    value: "",
    returnValue: "",
    hidden: false,
    open: false,
    checked: false,
    scrollTop: 0,
    scrollHeight: 100,
    style: { display: "", textAlign: "", marginRight: "" },
    dataset: {},
    children: [],
    files: [],
    href: "",
    download: "",
    onclick: null,
    listeners: new Map(),
    classList: {
      classes: new Set(),
      toggle(cls, force) {
        if (force === undefined ? !this.classes.has(cls) : force) {
          this.classes.add(cls);
        } else {
          this.classes.delete(cls);
        }
      },
      contains(cls) {
        return this.classes.has(cls);
      },
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = [...items];
    },
    remove() {},
    click() {
      if (typeof this.onclick === "function") {
        this.onclick({ preventDefault() {} });
      }
    },
    querySelector(sel) {
      if (sel === "a") return this.children[0] || makeElement("a");
      return makeElement("div");
    },
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    },
    dispatchEvent(type, ev = {}) {
      const fn = this.listeners.get(type);
      if (fn) fn(ev);
    },
    showModal() {
      this.open = true;
      setTimeout(() => {
        if (this.returnValue === "") {
          this.returnValue = globalThis.__nextDialogAction || "confirm";
        }
        this.open = false;
        this.dispatchEvent("close");
      }, 1);
    },
  };
  if (id) elements.set(id, el);
  return el;
}

function initDomElements() {
  elements.clear();
  for (const id of [
    "webMessageDialog",
    "webDialogTitle",
    "webDialogMessage",
    "webDialogCancel",
    "webDialogConfirm",
    "webToast",
    "debugLogOutput",
    "debugLogCount",
    "debugDrawer",
    "pdDot",
    "pdModeLabel",
    "pdTargetLabel",
    "chkVerboseSerial",
    "empty-state",
    "empty-state-msg",
    "plugin-container",
    "filesBreadcrumb",
    "filesTableContainer",
    "fileUploadInput",
    "settings-container",
    "save-container",
    "families",
    "fontFilesInput",
  ]) {
    const el = makeElement("div", id);
    globalThis[id] = el;
  }
}

initDomElements();

const windowListeners = new Map();
globalThis.window = globalThis;
globalThis.window.location = {
  origin: "https://www.aviraldg.com",
  protocol: "https:",
  pathname: "/crosspoint-controller/index.html",
  href: "https://www.aviraldg.com/crosspoint-controller/index.html",
};
globalThis.window.addEventListener = (type, fn) => {
  windowListeners.set(type, fn);
};
globalThis.document = {
  cookie: "",
  body: makeElement("body"),
  getElementById(id) {
    if (!elements.has(id)) {
      makeElement("div", id);
    }
    return elements.get(id);
  },
  createElement(tag) {
    return makeElement(tag);
  },
  querySelectorAll(sel) {
    if (sel.includes("nav-links")) {
      return ["plugins", "files", "settings", "fonts"].map((t) => {
        const a = makeElement("a");
        a.dataset.tab = t;
        return a;
      });
    }
    if (sel.includes("hub-section")) {
      return ["plugins", "files", "settings", "fonts"].map((t) =>
        makeElement("section", "tab-" + t),
      );
    }
    return [];
  },
};

Object.defineProperty(globalThis, "navigator", {
  value: {
    clipboard: {
      writeText: async (text) => {
        if (globalThis.__failClipboard) throw new Error("Clipboard denied");
        globalThis.__copiedClipboard = text;
      },
    },
    serial: {
      requestPort: async (opts) => {
        if (globalThis.__serialPortFactory) return globalThis.__serialPortFactory(opts);
        const err = new Error("No port selected");
        err.name = "NotFoundError";
        throw err;
      },
    },
  },
  configurable: true,
  writable: true,
});

globalThis.prompt = () => globalThis.__nextPromptValue ?? "NewFolder";
globalThis.loadPlugins = async () => globalThis.__loadPluginsResult ?? true;
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:https://www.aviraldg.com/mock-blob";
}

// Load source scripts via vm.runInThisContext so V8 tracks line/branch/function coverage on src/js/*.js
const jsFiles = [
  "dialogs-and-logger.js",
  "utils-and-crypto.js",
  "web-serial-backend.js",
  "fs-access-backend.js",
  "virtual-api-router.js",
  "ui-controllers.js",
];

for (const fn of jsFiles) {
  const fullPath = path.resolve("src/js", fn);
  const src = fs.readFileSync(fullPath, "utf-8");
  vm.runInThisContext(src, { filename: fullPath });
}

// Helper for in-memory FileSystemDirectoryHandle / FileSystemFileHandle simulation
class MemFileHandle {
  constructor(name, bytes = new Uint8Array(0)) {
    this.kind = "file";
    this.name = name;
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }
  async getFile() {
    const b = this.bytes;
    return {
      name: this.name,
      size: b.byteLength,
      async arrayBuffer() {
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    };
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (data) => {
        const u8 =
          data instanceof Uint8Array
            ? data
            : typeof data === "string"
              ? new TextEncoder().encode(data)
              : new Uint8Array(data);
        chunks.push(u8);
      },
      close: async () => {
        const total = chunks.reduce((a, c) => a + c.length, 0);
        const out = new Uint8Array(total);
        let pos = 0;
        for (const c of chunks) {
          out.set(c, pos);
          pos += c.length;
        }
        this.bytes = out;
      },
    };
  }
}

class MemDirHandle {
  constructor(name) {
    this.kind = "directory";
    this.name = name;
    this.map = new Map();
  }
  async *entries() {
    for (const [k, v] of this.map.entries()) {
      yield [k, v];
    }
  }
  async getDirectoryHandle(name, opts = {}) {
    const cur = this.map.get(name);
    if (cur && cur.kind === "directory") return cur;
    if (opts.create) {
      const d = new MemDirHandle(name);
      this.map.set(name, d);
      return d;
    }
    throw new Error("Directory not found: " + name);
  }
  async getFileHandle(name, opts = {}) {
    const cur = this.map.get(name);
    if (cur && cur.kind === "file") return cur;
    if (opts.create) {
      const f = new MemFileHandle(name);
      this.map.set(name, f);
      return f;
    }
    throw new Error("File not found: " + name);
  }
  async removeEntry(name) {
    if (!this.map.has(name)) throw new Error("Not found: " + name);
    this.map.delete(name);
  }
}

// Helper for simulated WebSerialPort
class MockSerialPort {
  constructor(handler) {
    this.handler = handler;
    this.readQueue = [];
    this.readWaiters = [];
    this.closed = false;
    this.txLines = [];
    this.readable = {
      getReader: () => ({
        read: async () => {
          if (this.readQueue.length > 0) {
            return { value: this.readQueue.shift(), done: false };
          }
          if (this.closed) return { value: undefined, done: true };
          return new Promise((resolve, reject) => {
            this.readWaiters.push({ resolve, reject });
          });
        },
        cancel: async () => {
          this.closed = true;
          while (this.readWaiters.length) {
            this.readWaiters.shift().resolve({ value: undefined, done: true });
          }
        },
        releaseLock: () => {},
      }),
    };
    this.writable = {
      getWriter: () => ({
        write: async (u8) => {
          const text = new TextDecoder().decode(u8);
          for (const rawLine of text.split(/\r?\n/)) {
            if (!rawLine.trim()) continue;
            this.txLines.push(rawLine);
            const respLines = (await this.handler(rawLine, this)) || [];
            for (const rl of respLines) {
              this.pushRx(rl + "\r\n");
            }
          }
        },
        releaseLock: () => {},
      }),
    };
  }
  async open() {}
  async setSignals() {}
  async close() {
    this.closed = true;
    while (this.readWaiters.length) {
      this.readWaiters.shift().resolve({ value: undefined, done: true });
    }
  }
  pushRx(str) {
    const bytes = new TextEncoder().encode(str);
    if (this.readWaiters.length > 0) {
      this.readWaiters.shift().resolve({ value: bytes, done: false });
    } else {
      this.readQueue.push(bytes);
    }
  }
}

test("dialogs-and-logger: dialogs, toast, hubLog, clearDebugLogs, copyDebugLogs, error handlers", async () => {
  clearDebugLogs();
  assert.equal(window.__hubLogs.length, 0);

  globalThis.__nextDialogAction = "confirm";
  const okConfirm = await showWebConfirm("Proceed?");
  assert.equal(okConfirm, true);

  globalThis.__nextDialogAction = "cancel";
  const cancelConfirm = await showWebConfirm("Cancel?");
  assert.equal(cancelConfirm, false);

  await showWebAlert("Hello alert");

  showWebToast("Saved!", false);
  assert.equal(elements.get("webToast").className, "toast");
  showWebToast("Error!", true);
  assert.equal(elements.get("webToast").className, "toast error");

  hubLog("debug", "test", "Debug msg", { a: 1 });
  hubLog("info", "test", "Info msg", "plain detail");
  hubLog("warn", "test", "Warn msg", new Error("boom"));
  const circular = {};
  circular.self = circular;
  hubLog("error", "test", "Error msg", circular);
  assert.equal(elements.get("debugDrawer").open, true);

  globalThis.__failClipboard = false;
  await copyDebugLogs();
  assert.match(globalThis.__copiedClipboard, /Warn msg/);

  globalThis.__failClipboard = true;
  await copyDebugLogs();
  globalThis.__failClipboard = false;

  windowListeners.get("error")({
    message: "Script failed",
    filename: "app.js",
    lineno: 10,
    colno: 2,
  });
  windowListeners.get("error")({});
  windowListeners.get("unhandledrejection")({ reason: new Error("Async boom") });
  windowListeners.get("unhandledrejection")({ reason: "string rejection" });

  clearDebugLogs();
  assert.equal(window.__hubLogs.length, 0);
});

test("utils-and-crypto: normalizeVPath, base64, obfuscation, status bar", () => {
  assert.equal(normalizeVPath(""), "/");
  assert.equal(normalizeVPath("/a/b/../c/./d\\e"), "/a/c/d/e");
  assert.equal(normalizeVPath("/../../root"), "/root");

  const sample = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const b64 = uint8ToBase64(sample);
  assert.deepEqual(base64ToUint8(b64), sample);
  assert.deepEqual(base64ToUint8(""), new Uint8Array(0));

  assert.equal(obfuscateStr(""), "");
  assert.equal(deobfuscateStr(""), "");
  assert.equal(deobfuscateStr("!!!invalid-base64!!!"), "");
  const obf = obfuscateStr("my-secret-pw-123");
  assert.notEqual(obf, "my-secret-pw-123");
  assert.equal(deobfuscateStr(obf), "my-secret-pw-123");

  setConnectionStatus("connected", "Connected", "Playdate USB");
  assert.equal(elements.get("pdDot").className, "pd-dot connected");
  setConnectionStatus("busy", "Connecting", "Wait");
  assert.equal(elements.get("pdDot").className, "pd-dot busy");
  setConnectionStatus("disconnected", "Disconnected", "Idle");
  assert.equal(elements.get("pdDot").className, "pd-dot");

  elements.get("chkVerboseSerial").checked = true;
  assert.equal(isVerboseSerialEnabled(), true);
  elements.get("chkVerboseSerial").checked = false;
  assert.equal(isVerboseSerialEnabled(), false);
});

test("fs-access-backend: resolveCrossPointDataHandle and full filesystem CRUD", async () => {
  // 1. Picked PLAYDATE root drive containing Data/user.123.com.crosspoint.reader/.crosspoint
  const playdateDrive = new MemDirHandle("PLAYDATE");
  const dataDir = await playdateDrive.getDirectoryHandle("Data", { create: true });
  await dataDir.getDirectoryHandle("com.crosspoint.reader", { create: true });
  const userAppDir = await dataDir.getDirectoryHandle("user.99.com.crosspoint.reader", {
    create: true,
  });
  await userAppDir.getDirectoryHandle(".crosspoint", { create: true });

  const resolved1 = await FileSystemAccessBackend.resolveCrossPointDataHandle(playdateDrive);
  assert.equal(resolved1.label, "PLAYDATE/Data/user.99.com.crosspoint.reader");

  // 2. Picked Data dir with no existing app dir -> creates com.crosspoint.reader
  const emptyDataDir = new MemDirHandle("Data");
  const resolved2 = await FileSystemAccessBackend.resolveCrossPointDataHandle(emptyDataDir);
  assert.equal(resolved2.label, "Data/com.crosspoint.reader");

  // 3. Picked com.crosspoint.reader directly
  const directAppDir = new MemDirHandle("com.crosspoint.reader");
  const resolved3 = await FileSystemAccessBackend.resolveCrossPointDataHandle(directAppDir);
  assert.equal(resolved3.label, "com.crosspoint.reader");

  // 4. Picked arbitrary folder
  const otherDir = new MemDirHandle("CustomFolder");
  const resolved4 = await FileSystemAccessBackend.resolveCrossPointDataHandle(otherDir);
  assert.equal(resolved4.label, "CustomFolder");

  // 5. CRUD operations on FileSystemAccessBackend
  const backend = new FileSystemAccessBackend(resolved2.handle, resolved2.label);
  assert.deepEqual(await backend.stat("/"), { exists: true, isDir: true, size: 0 });
  assert.equal(await backend.exists("/missing.txt"), false);
  assert.equal(await backend.isDir("/"), true);

  await backend.mkdir("/");
  await backend.mkdir("/books/sci-fi");
  assert.equal(await backend.isDir("/books/sci-fi"), true);

  const payload = new TextEncoder().encode("Dune by Frank Herbert");
  await backend.writeFile("/books/sci-fi/dune.txt", payload);
  const st = await backend.stat("/books/sci-fi/dune.txt");
  assert.deepEqual(st, { exists: true, isDir: false, size: payload.byteLength });

  const readBack = await backend.readFile("/books/sci-fi/dune.txt");
  assert.deepEqual(readBack, payload);

  const listing = await backend.listDir("/books");
  assert.equal(listing.length, 1);
  assert.equal(listing[0].name, "sci-fi");
  assert.equal(listing[0].isDir, true);

  const fileListing = await backend.listDir("/books/sci-fi");
  assert.equal(fileListing.length, 1);
  assert.equal(fileListing[0].name, "dune.txt");
  assert.equal(fileListing[0].isDir, false);
  assert.equal(fileListing[0].size, payload.byteLength);

  assert.deepEqual(await backend.listDir("/nonexistent"), []);

  const renamed = await backend.rename("/books/sci-fi/dune.txt", "/books/sci-fi/dune2.txt");
  assert.equal(renamed, true);
  assert.equal(await backend.exists("/books/sci-fi/dune.txt"), false);
  assert.equal(await backend.exists("/books/sci-fi/dune2.txt"), true);
  assert.equal(await backend.rename("/missing", "/other"), false);

  assert.equal(await backend.remove("/"), false);
  assert.equal(await backend.remove("/missing"), false);
  assert.equal(await backend.remove("/books/sci-fi/dune2.txt"), true);
  assert.equal(await backend.exists("/books/sci-fi/dune2.txt"), false);
});

test("web-serial-backend: open, ping, stat, listDir, readFile, writeFile (WCHUNK & legacy fallback), mkdir, remove, rename, relayHttp", async () => {
  elements.get("chkVerboseSerial").checked = true;
  const files = new Map();
  let currentWritePath = "";
  let currentWriteChunks = [];
  let supportWchunk = true;
  let failFirstStat = true;

  const port = new MockSerialPort(async (line, self) => {
    self.pushRx("console noise line\r\n");
    const m = line.match(/^msg !CP (\S+)(?:\s+(.*))?$/);
    if (!m) return [];
    const [, cmd, rest = ""] = m;
    if (cmd === "PING") {
      return ['@CP OK {"ok":true,"device":"Playdate","version":"2.0.0-playdate-test"}'];
    }
    if (cmd === "STAT") {
      if (failFirstStat) {
        failFirstStat = false;
        // Simulate a malformed JSON response once, then normal
        return ["@CP OK {bad-json"];
      }
      if (rest === "/err") return ['@CP ERR {"error":"stat error"}'];
      const f = files.get(rest);
      if (!f) return ['@CP OK {"exists":false,"isDir":false,"size":0}'];
      return [
        `@CP OK {"exists":true,"isDir":${!!f.isDir},"size":${f.bytes ? f.bytes.length : 0}}`,
      ];
    }
    if (cmd === "LIST") {
      if (rest === "/err") return ['@CP ERR {"error":"not a dir"}'];
      return [
        '@CP ITEM {"name":"b.txt","isDir":false,"size":12}',
        "@CP ITEM malformed-json",
        '@CP ITEM {"name":"a_dir","isDir":true,"size":0}',
        '@CP OK {"count":2}',
      ];
    }
    if (cmd === "READ") {
      const [offStr, lenStr, ...pParts] = rest.split(" ");
      const vpath = pParts.join(" ");
      if (vpath === "/read-err") {
        return ['@CP ERR {"error":"read failed"}'];
      }
      const f = files.get(vpath);
      const slice = f.bytes.subarray(Number(offStr), Number(offStr) + Number(lenStr));
      return [`@CP DATA ${uint8ToBase64(slice)}`, `@CP OK {"bytes":${slice.length}}`];
    }
    if (cmd === "WOPEN") {
      currentWritePath = rest;
      currentWriteChunks = [];
      return ['@CP OK {"ok":true}'];
    }
    if (cmd === "WCHUNK") {
      if (!supportWchunk) {
        return ['@CP ERR {"ok":false,"error":"unknown command"}'];
      }
      currentWriteChunks.push(base64ToUint8(rest));
      const written = currentWriteChunks.reduce((a, c) => a + c.length, 0);
      return [`@CP OK {"ok":true,"written":${written}}`];
    }
    if (cmd === "WDATA") {
      currentWriteChunks.push(base64ToUint8(rest));
      return [];
    }
    if (cmd === "WFLUSH") {
      const written = currentWriteChunks.reduce((a, c) => a + c.length, 0);
      return [`@CP OK {"ok":true,"written":${written}}`];
    }
    if (cmd === "WCLOSE") {
      const total = currentWriteChunks.reduce((a, c) => a + c.length, 0);
      const merged = new Uint8Array(total);
      let pos = 0;
      for (const c of currentWriteChunks) {
        merged.set(c, pos);
        pos += c.length;
      }
      files.set(currentWritePath, { isDir: false, bytes: merged });
      return [`@CP OK {"ok":true,"size":${total}}`];
    }
    if (cmd === "MKDIR") {
      files.set(rest, { isDir: true });
      return ['@CP OK {"ok":true}'];
    }
    if (cmd === "RM") {
      files.delete(rest);
      return ['@CP OK {"ok":true}'];
    }
    if (cmd === "RENAME") {
      const [oldP, newP] = rest.split("\t");
      const v = files.get(oldP);
      if (!v) return ['@CP ERR {"error":"missing"}'];
      files.set(newP, v);
      files.delete(oldP);
      return ['@CP OK {"ok":true}'];
    }
    if (cmd === "RELAY") {
      const bodyB64 = uint8ToBase64(new TextEncoder().encode('{"relayed":true}'));
      return [`@CP DATA ${bodyB64}`, '@CP OK {"status":200,"bytes":16}'];
    }
    return ['@CP ERR {"error":"unhandled"}'];
  });

  const backend = new WebSerialBackend(port);
  await backend.open();
  assert.equal(backend.deviceVersion, "2.0.0-playdate-test");

  // First stat gets malformed JSON -> returns exists: false
  assert.deepEqual(await backend.stat("/any"), { exists: false, isDir: false, size: 0 });
  assert.deepEqual(await backend.stat("/err"), { exists: false, isDir: false, size: 0 });

  await backend.mkdir("/docs");
  assert.equal(await backend.isDir("/docs"), true);

  // Write large file (>8KB) via WCHUNK fast path
  const bigBytes = new Uint8Array(9000);
  for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = i & 0xff;
  await backend.writeFile("/docs/big.bin", bigBytes);
  assert.equal(await backend.exists("/docs/big.bin"), true);

  const readBig = await backend.readFile("/docs/big.bin");
  assert.deepEqual(readBig, bigBytes);

  // Test legacy WDATA + WFLUSH fallback when WCHUNK is unsupported
  supportWchunk = false;
  backend._supportsWchunk = undefined;
  const smallBytes = new TextEncoder().encode("Hello legacy WDATA");
  await backend.writeFile("/docs/small.txt", smallBytes);
  assert.deepEqual(await backend.readFile("/docs/small.txt"), smallBytes);

  const dirItems = await backend.listDir("/docs");
  assert.equal(dirItems.length, 2);
  assert.equal(dirItems[0].name, "a_dir");
  assert.equal(dirItems[1].name, "b.txt");
  assert.deepEqual(await backend.listDir("/err"), []);

  assert.equal(await backend.rename("/docs/small.txt", "/docs/small2.txt"), true);
  assert.equal(await backend.remove("/docs/small2.txt"), true);

  const relayRes = await backend.relayHttp({ url: "https://example.com/api", method: "GET" });
  assert.equal(relayRes.status, 200);
  assert.equal(new TextDecoder().decode(relayRes.bodyBytes), '{"relayed":true}');

  await backend.close();
  elements.get("chkVerboseSerial").checked = false;

  // Also test failed PING during open() and _cmdWithRetry timeout recovery
  let pingCalls = 0;
  const badPort = new MockSerialPort(async () => {
    pingCalls++;
    return ['@CP ERR {"ok":false}'];
  });
  const badBackend = new WebSerialBackend(badPort);
  await assert.rejects(() => badBackend.open(), /did not respond to !CP PING/);
  assert.equal(pingCalls, 1);
});

test("virtual-api-router and ui-controllers: full end-to-end routes and UI actions", async () => {
  const rootDir = new MemDirHandle("com.crosspoint.reader");
  globalThis.__serialPortFactory = null;
  window.showDirectoryPicker = async () => rootDir;

  await connectDirectoryPicker();
  assert.equal(isConnected(), true);

  // Seed a sample plugin in /.crosspoint/plugins/readest
  await activeBackend.writeFile(
    "/.crosspoint/plugins/readest/plugin.js",
    new TextEncoder().encode("console.log('readest loaded');"),
  );
  await activeBackend.writeFile(
    "/.crosspoint/plugins/readest/style.css",
    new TextEncoder().encode("body { color: black; }"),
  );
  await activeBackend.writeFile(
    "/.crosspoint/plugins/readest/index.html",
    new TextEncoder().encode("<div>Readest</div>"),
  );
  await activeBackend.writeFile(
    "/.crosspoint/plugins/readest/manifest.json",
    new TextEncoder().encode(JSON.stringify({ title: "Readest Sync", mount: "settings" })),
  );

  // 1. /api/status (root and subpath)
  const stRes = await window.fetch(
    "https://www.aviraldg.com/crosspoint-controller/api/status?plugin=readest",
  );
  assert.equal(stRes.status, 200);
  const stJson = await stRes.json();
  assert.equal(stJson.device, "Playdate");
  assert.equal(stJson.deviceId.length, 64);

  // Custom 32-byte device_secret.bin
  const customSecret = new Uint8Array(32).fill(0x42);
  await activeBackend.writeFile("/.crosspoint/device_secret.bin", customSecret);
  const stRes2 = await window.fetch("/api/status?plugin=readest");
  const stJson2 = await stRes2.json();
  assert.notEqual(stJson2.deviceId, stJson.deviceId);

  // 2. /api/plugins & /plugin
  const plRes = await window.fetch("/api/plugins");
  const plList = await plRes.json();
  assert.equal(plList.length, 1);
  assert.equal(plList[0].title, "Readest Sync");

  assert.equal((await window.fetch("/plugin?name=..&file=plugin.js")).status, 400);
  assert.equal((await window.fetch("/plugin?name=missing&file=plugin.js")).status, 404);
  assert.equal((await window.fetch("/plugin?name=readest&file=missing.js")).status, 404);
  assert.equal((await window.fetch("/plugin?name=readest&file=plugin.js")).status, 200);
  assert.equal((await window.fetch("/plugin?name=readest&file=manifest.json")).status, 200);
  assert.equal((await window.fetch("/plugin?name=readest&file=style.css")).status, 200);
  assert.equal((await window.fetch("/plugin?name=readest&file=index.html")).status, 200);

  // 3. /api/settings GET & POST
  const getSet1 = await (
    await window.fetch("/api/settings?keys=koUsername,screenMargin")
  ).json();
  assert.equal(getSet1.length, 2);

  const postSetRes = await window.fetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      koUsername: "aviral",
      koPassword: "pw1",
      koServerUrl: "https://sync.koreader.rocks",
      koHeader1Name: "X-Auth-1",
      koHeader1Value: "val1",
      koHeader2Name: "X-Auth-2",
      koHeader2Value: "val2",
      koServerType: 1,
      koMatchMethod: 1,
      koSendMetadata: 1,
      koSyncBehavior: 1,
      koSyncClippings: 1,
      screenMargin: 12,
    }),
  });
  assert.equal(postSetRes.status, 200);

  // 4. /api/crypto & /api/book-key
  const randRes = await (
    await window.fetch("/api/crypto", {
      method: "POST",
      body: JSON.stringify({ op: "random", len: 16 }),
    })
  ).json();
  assert.equal(base64ToUint8(randRes.data).length, 16);

  const sha1Res = await (
    await window.fetch("/api/crypto", {
      method: "POST",
      body: JSON.stringify({ op: "sha1", data: btoa("abc") }),
    })
  ).json();
  assert.ok(sha1Res.data);

  const sha256Res = await (
    await window.fetch("/api/crypto", {
      method: "POST",
      body: JSON.stringify({ op: "sha256", data: btoa("abc") }),
    })
  ).json();
  assert.ok(sha256Res.data);

  const keyB64 = uint8ToBase64(new Uint8Array(16).fill(7));
  const ivB64 = uint8ToBase64(new Uint8Array(16).fill(3));
  const plainB64 = uint8ToBase64(new TextEncoder().encode("secret-book-content"));
  const encRes = await (
    await window.fetch("/api/crypto", {
      method: "POST",
      body: JSON.stringify({ op: "aesenc", key: keyB64, iv: ivB64, data: plainB64 }),
    })
  ).json();
  const decRes = await (
    await window.fetch("/api/crypto", {
      method: "POST",
      body: JSON.stringify({ op: "aesdec", key: keyB64, iv: ivB64, data: encRes.data }),
    })
  ).json();
  assert.equal(decRes.data, plainB64);

  const badCrypto = await (
    await window.fetch("/api/crypto", {
      method: "POST",
      body: JSON.stringify({ op: "unknown" }),
    })
  ).json();
  assert.match(badCrypto.error, /unsupported crypto op/);

  assert.equal(
    (
      await window.fetch("/api/book-key", {
        method: "POST",
        body: JSON.stringify({ path: "/book.epub", key: btoa("short") }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await window.fetch("/api/book-key", {
        method: "POST",
        body: JSON.stringify({ path: "/book.epub", key: keyB64, expires: 1700000000 }),
      })
    ).status,
    200,
  );

  // 5. /api/plugin-fs, /upload, /mkdir, /rename, /download, /delete, /api/files
  assert.equal(
    (
      await window.fetch("/api/plugin-fs?path=/.crosspoint/device_secret.bin", {
        method: "POST",
      })
    ).status,
    400,
  );
  assert.equal(
    (await window.fetch("/api/plugin-fs?path=/test.bin", { method: "POST" })).status,
    400,
  );
  assert.equal(
    (
      await window.fetch("/api/plugin-fs?path=/test.bin", {
        method: "POST",
        body: "raw-plugin-fs-body",
      })
    ).status,
    200,
  );

  const fd = new FormData();
  fd.append("file", new Blob(["epub-bytes"]), "novel.epub");
  assert.equal(
    (await window.fetch("/upload?path=/books", { method: "POST", body: fd })).status,
    200,
  );
  assert.equal((await window.fetch("/upload?path=/books", { method: "POST" })).status, 400);

  assert.equal(
    (
      await window.fetch("/mkdir", {
        method: "POST",
        body: new URLSearchParams({ path: "/books", name: "sub" }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await window.fetch("/rename", {
        method: "POST",
        body: new URLSearchParams({ path: "/books/novel.epub", name: "renamed.epub" }),
      })
    ).status,
    200,
  );

  assert.equal((await window.fetch("/download?path=/.crosspoint/settings.json")).status, 403);
  assert.equal((await window.fetch("/download?path=/books/missing.epub")).status, 404);
  const dlResp = await window.fetch("/download?path=/books/renamed.epub");
  assert.equal(dlResp.status, 200);
  assert.equal(await dlResp.text(), "epub-bytes");

  const filesResp = await (await window.fetch("/api/files?path=/books")).json();
  assert.equal(filesResp.length, 2);

  await window.fetch("/delete", {
    method: "POST",
    body: JSON.stringify({ paths: ["/books/renamed.epub"] }),
  });
  await window.fetch("/delete", {
    method: "POST",
    body: new URLSearchParams({ path: "/books/sub" }).toString(),
  });

  // 6. /api/opds, /api/fonts, /api/plugin-jobs, /api/relay, /api/fetch
  await window.fetch("/api/opds", {
    method: "POST",
    body: JSON.stringify({
      name: "Calibre",
      url: "https://opds.example.com",
      username: "u",
      password: "p",
    }),
  });
  await window.fetch("/api/opds", {
    method: "POST",
    body: JSON.stringify({
      index: 0,
      name: "Calibre Edited",
      url: "https://opds.example.com",
      username: "u",
    }),
  });
  const opdsList = await (await window.fetch("/api/opds")).json();
  assert.equal(opdsList.length, 1);
  assert.equal(opdsList[0].name, "Calibre Edited");
  assert.equal(opdsList[0].hasPassword, true);
  await window.fetch("/api/opds/delete", {
    method: "POST",
    body: JSON.stringify({ index: 0 }),
  });

  const fontFd = new FormData();
  fontFd.append("family", "Bookerly");
  fontFd.append("file", new Blob(["font-bytes"]), "Bookerly-Regular.ttf");
  assert.equal(
    (await window.fetch("/api/fonts/upload", { method: "POST", body: fontFd })).status,
    200,
  );
  assert.equal((await window.fetch("/api/fonts/upload", { method: "POST" })).status, 400);

  const fontsData = await (await window.fetch("/api/fonts")).json();
  assert.equal(fontsData.families.length, 1);
  assert.equal(fontsData.families[0].name, "Bookerly");

  // Exercise UI tabs: switchTab, reloadFilesTab, reloadSettingsTab, saveSettings, reloadFontsTab, uploadSelectedFonts
  await switchTab("files");
  await reloadFilesTab("/books");
  await downloadPlaydateFile("/test.bin", "test.bin");
  await uploadSelectedFiles([new File(["abc"], "up.epub")]);
  await promptCreateFolder();

  await switchTab("settings");
  await saveSettings();

  await switchTab("fonts");
  elements.get("fontFilesInput").files = [new File(["ttf"], "Literata-Regular.ttf")];
  await uploadSelectedFonts();

  await window.fetch("/api/fonts/delete", {
    method: "POST",
    body: JSON.stringify({ family: "Bookerly" }),
  });

  assert.equal((await window.fetch("/api/plugin-jobs")).status, 200);
  assert.equal((await window.fetch("/api/unknown-endpoint")).status, 404);

  // /api/relay & /api/fetch with mocked __outboundFetch
  window.__outboundFetch = async (url) => {
    if (url.includes("fail")) throw new Error("network down");
    if (url.includes("404")) return new Response("not found", { status: 404 });
    return new Response("remote-payload", {
      status: 200,
      headers: { "X-Custom": "1" },
    });
  };

  const relayOk = await window.fetch("/api/relay", {
    method: "POST",
    body: JSON.stringify({ url: "https://api.example.com/data", method: "POST", body: "hi" }),
  });
  assert.equal(relayOk.status, 200);
  assert.equal(await relayOk.text(), "remote-payload");

  const relayFail = await window.fetch("/api/relay", {
    method: "POST",
    body: JSON.stringify({ url: "https://api.example.com/fail" }),
  });
  assert.equal(relayFail.status, 502);

  assert.equal(
    (await window.fetch("/api/fetch", { method: "POST", body: JSON.stringify({}) })).status,
    400,
  );
  const fetchOk = await (
    await window.fetch("/api/fetch", {
      method: "POST",
      body: JSON.stringify({ url: "https://api.example.com/file.bin", dest: "/dl/file.bin" }),
    })
  ).json();
  assert.equal(fetchOk.complete, true);

  const fetch404 = await (
    await window.fetch("/api/fetch", {
      method: "POST",
      body: JSON.stringify({ url: "https://api.example.com/404", dest: "/dl/404.bin" }),
    })
  ).json();
  assert.equal(fetch404.complete, false);
  assert.equal(fetch404.status, 404);
});

test("ui-controllers & virtual-api-router: unconnected state, retries, FormData, and UI callbacks", async () => {
  // 1. Unconnected 503 & UI unconnected states
  activeBackend = null;
  assert.equal(isConnected(), false);
  const res503 = await window.fetch("/api/status");
  assert.equal(res503.status, 503);
  await refreshActiveTab();
  await reloadPluginsTab();

  // Pass-through nativeFetch for external URL and URL object
  window.__nativeFetchCalled = 0;
  const externalRes = await window.fetch(new URL("https://example.com/other"));
  assert.ok(externalRes);

  // Missing navigator.serial and missing window.showDirectoryPicker
  const savedSerial = navigator.serial;
  delete navigator.serial;
  await connectWebSerial(false);
  navigator.serial = savedSerial;

  const savedPicker = window.showDirectoryPicker;
  delete window.showDirectoryPicker;
  await connectDirectoryPicker();

  // AbortError and generic error in connectDirectoryPicker
  window.showDirectoryPicker = async () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  };
  await connectDirectoryPicker();

  window.showDirectoryPicker = async () => {
    throw new Error("Disk read error");
  };
  await connectDirectoryPicker();
  window.showDirectoryPicker = savedPicker;

  // 2. Connect WebSerial with filter NotFoundError fallback -> retry without filter -> succeeds
  let reqCount = 0;
  globalThis.__serialPortFactory = async () => {
    reqCount++;
    if (reqCount === 1) {
      const err = new Error("No filtered device");
      err.name = "NotFoundError";
      throw err;
    }
    return new MockSerialPort(async (line) => {
      if (line.includes("!CP PING")) {
        return ['@CP OK {"ok":true,"device":"Playdate","version":"2.0.0-playdate"}'];
      }
      if (line.includes("!CP LIST")) {
        return ['@CP OK {"count":0}'];
      }
      return ['@CP OK {"ok":true}'];
    });
  };
  await connectWebSerial(false);
  assert.equal(isConnected(), true);

  // 3. Test _cmdWithRetry retry path & WCHUNK retry recovery via WFLUSH
  let attemptCount = 0;
  let wchunkFaultOnce = true;
  const retryPort = new MockSerialPort(async (line) => {
    if (line.includes("!CP PING")) {
      return ['@CP OK {"ok":true,"device":"Playdate","version":"2.0.0-playdate"}'];
    }
    if (line.includes("!CP STAT")) {
      attemptCount++;
      if (attemptCount === 1) {
        throw new Error("Simulated transient serial glitch");
      }
      return ['@CP OK {"exists":true,"isDir":false,"size":4}'];
    }
    if (line.includes("!CP WOPEN") || line.includes("!CP WCLOSE")) {
      return ['@CP OK {"ok":true}'];
    }
    if (line.includes("!CP WCHUNK")) {
      if (wchunkFaultOnce) {
        wchunkFaultOnce = false;
        throw new Error("Simulated WCHUNK transient timeout");
      }
      return ['@CP OK {"ok":true,"written":5}'];
    }
    if (line.includes("!CP WFLUSH")) {
      return ['@CP OK {"ok":true,"written":5}'];
    }
    return ['@CP OK {"ok":true}'];
  });
  const retryBackend = new WebSerialBackend(retryPort);
  await retryBackend.open();
  const st = await retryBackend.stat("/test.txt");
  assert.equal(st.exists, true);
  await retryBackend.writeFile("/recover.txt", new Uint8Array([1, 2, 3, 4, 5]));
  await retryBackend.close();

  // 4. Reconnect DirectoryPicker and test UI callbacks (row click, delete button, loadPlugins failure)
  const rootDir = new MemDirHandle("com.crosspoint.reader");
  window.showDirectoryPicker = async () => rootDir;
  await connectDirectoryPicker();

  globalThis.__loadPluginsResult = false;
  window.__lastPluginLoadError = "Simulated load error";
  await reloadPluginsTab();
  globalThis.__loadPluginsResult = true;

  await activeBackend.mkdir("/books/sub");
  await activeBackend.writeFile("/books/sub/item.epub", new TextEncoder().encode("book-data"));
  await activeBackend.writeFile(
    "/.crosspoint/settings.json",
    new TextEncoder().encode("{bad-json"),
  );
  await loadJsonFile("/.crosspoint/settings.json", {});
  await saveJsonFile("/.crosspoint/settings.json", { showHiddenFiles: 1 });

  await reloadFilesTab("/books/sub");
  const table = elements.get("filesTableContainer").children[0];
  const tbody = table.children[0];
  // Click parent folder link
  tbody.children[0].querySelector("a").click();
  // Reload /books/sub and trigger file download + delete button
  await reloadFilesTab("/books/sub");
  const tbody2 = elements.get("filesTableContainer").children[0].children[0];
  const fileRow = tbody2.children[1];
  // Click file link (triggers download)
  fileRow.children[0].children[0].click();
  // Click Delete button in actions column
  globalThis.__nextDialogAction = "confirm";
  await fileRow.children[2].children[1].onclick();

  // FormData body in parseBodyText & /api/plugin-fs FormData upload & /delete URL-encoded paths JSON
  const pfd = new FormData();
  pfd.append("file", new Blob(["plugin-data"]), "data.bin");
  assert.equal(
    (await window.fetch("/api/plugin-fs?path=/p.bin", { method: "POST", body: pfd })).status,
    200,
  );
  await window.fetch("/delete", {
    method: "POST",
    body: new URLSearchParams({ paths: JSON.stringify(["/p.bin"]) }).toString(),
  });

  // HTTP 503 retry in fetchWithTimeoutAndRetry & activeBackend.relayHttp fallback in performOutboundFetch & /api/fetch
  let httpCalls = 0;
  window.__outboundFetch = async () => {
    httpCalls++;
    if (httpCalls === 1) return new Response("busy", { status: 503 });
    return new Response("ok-after-retry", { status: 200 });
  };
  const retryHttpResp = await performOutboundFetch("https://example.com/retry", "GET", {}, "");
  assert.equal(retryHttpResp.status, 200);

  // Test activeBackend.relayHttp fallback when __outboundFetch throws
  window.__outboundFetch = async () => {
    throw new Error("CORS blocked");
  };
  activeBackend.relayHttp = async () => ({
    status: 200,
    bytes: 7,
    bodyBytes: new TextEncoder().encode("relayed"),
  });
  const relayFallbackResp = await performOutboundFetch(
    "https://example.com/cors",
    "GET",
    {},
    "",
  );
  assert.equal(relayFallbackResp.status, 200);

  const fetchViaRelay = await (
    await window.fetch("/api/fetch", {
      method: "POST",
      body: JSON.stringify({
        url: "https://example.com/cors-file",
        dest: "/relayed.bin",
        method: "POST",
        body: "req",
      }),
    })
  ).json();
  assert.equal(fetchViaRelay.complete, true);

  // Exercise remaining UI controller branches: font delete button, empty font selection, connectWebSerial cancel/error
  await reloadFontsTab();
  const fontRow = elements.get("families").children[0];
  if (fontRow) {
    globalThis.__nextDialogAction = "confirm";
    const delBtn = fontRow.children[fontRow.children.length - 1];
    if (delBtn && typeof delBtn.onclick === "function") await delBtn.onclick();
  }
  elements.get("fontFilesInput").files = [];
  await uploadSelectedFonts();

  await downloadPlaydateFile("/nonexistent-file.bin", "missing.bin");

  // User cancels after retry in connectWebSerial, and generic error in connectWebSerial
  globalThis.__serialPortFactory = async () => {
    const err = new Error("User cancelled");
    err.name = "NotFoundError";
    throw err;
  };
  await connectWebSerial(true);

  globalThis.__serialPortFactory = async () => {
    throw new Error("USB permission denied");
  };
  await connectWebSerial(true);
});

test("scripts/build.mjs: getGitShortSha, resolveCrossPointReaderDir, transformPluginHostJs, build", () => {
  assert.equal(getGitShortSha("/nonexistent-dir-12345"), "dev");
  const readerDir = resolveCrossPointReaderDir();
  assert.ok(fs.existsSync(path.join(readerDir, "src", "network", "html", "assets", "web.css")));

  assert.throws(
    () => transformPluginHostJs("invalid js"),
    /Expected \/api\/plugins fetch snippet/,
  );

  process.env.CUSTOM_DOMAIN = "crosspoint.aviraldg.com";
  const res = build();
  delete process.env.CUSTOM_DOMAIN;
  assert.ok(res.builtHtml.length > 50000);
  assert.ok(fs.existsSync(path.resolve("dist/CNAME")));
  fs.rmSync(path.resolve("dist/CNAME"), { force: true });
});
