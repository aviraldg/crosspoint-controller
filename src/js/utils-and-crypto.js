/* exported nativeFetch, PLAYDATE_MAC_KEY, DEFAULT_DEVICE_SECRET, FIRMWARE_FAMILY, WEB_HUB_VERSION, PLUGIN_API_VERSION, PLUGIN_CAPABILITIES, PLUGIN_ROOTS, normalizeVPath, uint8ToBase64, base64ToUint8, obfuscateStr, deobfuscateStr, setConnectionStatus, isVerboseSerialEnabled */

const nativeFetch = window.fetch.bind(window);
const PLAYDATE_MAC_KEY = new Uint8Array([0x02, 0x00, 0x50, 0x44, 0x00, 0x01]);
const DEFAULT_DEVICE_SECRET = new Uint8Array(32);
for (let i = 0; i < 32; i++) {
  DEFAULT_DEVICE_SECRET[i] = (0x50 + i * 17) & 0xff;
}

const FIRMWARE_FAMILY = "crosspoint";
const WEB_HUB_VERSION = "__WEB_HUB_VERSION__";
const PLUGIN_API_VERSION = 1;
const PLUGIN_CAPABILITIES =
  "catalog.lists,catalog.notices,catalog.bundle_install,catalog.version_tracking," +
  "catalog.compatibility,catalog.item_details,catalog.encoded_item_fields," +
  "catalog.list_index_mapping,catalog.list_requirements,catalog.server_paths";
const PLUGIN_ROOTS = ["/.crosspoint/plugins", "/plugins", "/.plugins"];

function normalizeVPath(p) {
  if (!p) return "/";
  const parts = [];
  for (const seg of String(p).replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return "/" + parts.join("/");
}

function uint8ToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUint8(b64) {
  const bin = atob(b64 || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function obfuscateStr(plain) {
  if (!plain) return "";
  const raw = new TextEncoder().encode(String(plain));
  const xored = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    xored[i] = raw[i] ^ PLAYDATE_MAC_KEY[i % PLAYDATE_MAC_KEY.length];
  }
  return uint8ToBase64(xored);
}

function deobfuscateStr(encoded) {
  if (!encoded) return "";
  try {
    const xored = base64ToUint8(encoded);
    const raw = new Uint8Array(xored.length);
    for (let i = 0; i < xored.length; i++) {
      raw[i] = xored[i] ^ PLAYDATE_MAC_KEY[i % PLAYDATE_MAC_KEY.length];
    }
    return new TextDecoder().decode(raw);
  } catch {
    return "";
  }
}

function setConnectionStatus(state, title, subtitle) {
  const dot = document.getElementById("pdDot");
  dot.className =
    "pd-dot" + (state === "connected" ? " connected" : state === "busy" ? " busy" : "");
  document.getElementById("pdModeLabel").textContent = title;
  document.getElementById("pdTargetLabel").textContent = subtitle;
}

function isVerboseSerialEnabled() {
  const el = document.getElementById("chkVerboseSerial");
  return !!(el && el.checked);
}
