/* global activeBackend:writable, hubLog, showWebAlert, showWebConfirm, showWebToast, setConnectionStatus, WebSerialBackend, FileSystemAccessBackend, loadPlugins, normalizeVPath, WEB_HUB_VERSION */
/* exported isConnected, connectWebSerial, connectDirectoryPicker, switchTab, refreshActiveTab, reloadPluginsTab, formatBytes, reloadFilesTab, downloadPlaydateFile, uploadSelectedFiles, promptCreateFolder, escapeHtml, reloadSettingsTab, saveSettings, reloadFontsTab, uploadSelectedFonts */

let currentTab = "plugins";
let currentFilesPath = "/";
let allSettings = [];

function isConnected() {
  return !!activeBackend;
}

async function connectWebSerial(anyPort = false) {
  if (!("serial" in navigator)) {
    const msg =
      "Web Serial API is not available in this browser. Please open this page in Google Chrome, Microsoft Edge, Brave, or Opera.";
    hubLog("error", "serial", msg);
    await showWebAlert(msg);
    return;
  }
  try {
    setConnectionStatus(
      "busy",
      "Connecting over USB Serial…",
      "Select your Playdate in the browser popup",
    );
    let port;
    try {
      port = await navigator.serial.requestPort(
        anyPort ? {} : { filters: [{ usbVendorId: 0x1331 }] },
      );
    } catch (filterErr) {
      if (filterErr && filterErr.name === "NotFoundError" && !anyPort) {
        hubLog(
          "info",
          "serial",
          "No port selected with USB VID 0x1331 filter; retrying without filter…",
        );
        port = await navigator.serial.requestPort();
      } else {
        throw filterErr;
      }
    }
    if (activeBackend && typeof activeBackend.close === "function") {
      await activeBackend.close();
    }
    const backend = new WebSerialBackend(port);
    await backend.open();
    activeBackend = backend;
    setConnectionStatus("connected", backend.modeName, backend.targetDescription);
    showWebToast("Connected to Playdate via Live USB Serial!", false);
    await refreshActiveTab();
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      hubLog("info", "serial", "Serial port selection cancelled by user");
      setConnectionStatus(
        "disconnected",
        "Not connected to Playdate",
        "Serial port selection cancelled",
      );
      return;
    }
    hubLog("error", "serial", "Serial connection failed: " + (err.message || err), err);
    setConnectionStatus("disconnected", "Serial Connection Failed", err.message || String(err));
    showWebToast("Serial connection failed: " + (err.message || err), true);
  }
}

async function connectDirectoryPicker() {
  if (!("showDirectoryPicker" in window)) {
    const msg =
      "Directory Picker API is not available in this browser. Please use Google Chrome, Microsoft Edge, Brave, or Opera.";
    hubLog("error", "fs-picker", msg);
    await showWebAlert(msg);
    return;
  }
  try {
    setConnectionStatus(
      "busy",
      "Opening Playdate Data Folder…",
      "Select your PLAYDATE drive or Data folder",
    );
    const picked = await window.showDirectoryPicker({ mode: "readwrite" });
    const { handle, label } = await FileSystemAccessBackend.resolveCrossPointDataHandle(picked);
    if (activeBackend && typeof activeBackend.close === "function") {
      await activeBackend.close();
    }
    activeBackend = new FileSystemAccessBackend(handle, label);
    hubLog("info", "fs-picker", "Opened Playdate Data folder: " + label);
    setConnectionStatus("connected", "Playdate Data Folder", label);
    showWebToast("Opened Playdate Data folder: " + label, false);
    await refreshActiveTab();
  } catch (err) {
    if (err && err.name === "AbortError") {
      hubLog("info", "fs-picker", "Folder selection cancelled by user");
      setConnectionStatus(
        "disconnected",
        "Not connected to Playdate",
        "Folder selection cancelled",
      );
      return;
    }
    hubLog("error", "fs-picker", "Could not open folder: " + (err.message || err), err);
    setConnectionStatus("disconnected", "Folder Access Failed", err.message || String(err));
    showWebToast("Could not open folder: " + (err.message || err), true);
  }
}

async function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".nav-links a[data-tab]").forEach((a) => {
    a.classList.toggle("active-tab", a.dataset.tab === tab);
  });
  document.querySelectorAll(".hub-section").forEach((sec) => {
    sec.classList.toggle("active", sec.id === "tab-" + tab);
  });
  await refreshActiveTab();
}

async function refreshActiveTab() {
  if (!isConnected()) {
    hubLog(
      "info",
      "ui",
      "Refresh requested before Playdate connection; prompting user to connect.",
    );
    const empty = document.getElementById("empty-state");
    const emptyMsg = document.getElementById("empty-state-msg");
    if (empty && emptyMsg) {
      emptyMsg.textContent =
        "Connect your Playdate above (via Live USB Serial or Playdate Data Folder) to load installed web plugins.";
      empty.hidden = false;
    }
    return;
  }
  if (currentTab === "plugins") await reloadPluginsTab();
  else if (currentTab === "files") await reloadFilesTab(currentFilesPath);
  else if (currentTab === "settings") await reloadSettingsTab();
  else if (currentTab === "fonts") await reloadFontsTab();
}

async function reloadPluginsTab() {
  const host = document.getElementById("plugin-container");
  const empty = document.getElementById("empty-state");
  const emptyMsg = document.getElementById("empty-state-msg");
  host.replaceChildren();
  if (!isConnected()) {
    emptyMsg.textContent = "Connect your Playdate above to load installed web plugins.";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  window.__lastPluginLoadError = "";
  const ok = await loadPlugins("settings");
  if (!ok) {
    const detail = window.__lastPluginLoadError ? ` (${window.__lastPluginLoadError})` : "";
    emptyMsg.textContent = `Could not load plugins from Playdate${detail}. Check the Diagnostics Console below or click Refresh to try again.`;
    empty.hidden = false;
  } else if (host.children.length === 0) {
    emptyMsg.innerHTML =
      "No web plugins are installed in <code>/.crosspoint/plugins</code> yet. " +
      "Install plugins from <b>Plugins &rarr; Plugin Hub</b> on your Playdate, then click Refresh.";
    empty.hidden = false;
  }
}

// ---- File Manager Tab ----
function formatBytes(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

async function reloadFilesTab(path = "/") {
  currentFilesPath = normalizeVPath(path);
  const bc = document.getElementById("filesBreadcrumb");
  const container = document.getElementById("filesTableContainer");
  bc.textContent = currentFilesPath;
  try {
    const res = await fetch("/api/files?path=" + encodeURIComponent(currentFilesPath));
    const items = await res.json();
    const table = document.createElement("table");
    table.className = "file-table";
    table.innerHTML =
      "<thead><tr><th>Name</th><th>Size</th><th style='text-align:right'>Actions</th></tr></thead>";
    const tbody = document.createElement("tbody");

    if (currentFilesPath !== "/") {
      const parentPath = currentFilesPath.slice(0, currentFilesPath.lastIndexOf("/")) || "/";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="3"><a class="folder-link" href="#">&#11013; .. (Parent Folder)</a></td>`;
      tr.querySelector("a").onclick = (e) => {
        e.preventDefault();
        reloadFilesTab(parentPath);
      };
      tbody.appendChild(tr);
    }

    const sorted = (items || [])
      .slice()
      .sort(
        (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
      );
    for (const item of sorted) {
      const fullPath = normalizeVPath(`${currentFilesPath}/${item.name}`);
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      const a = document.createElement("a");
      a.className = item.isDirectory ? "folder-link" : "file-link";
      a.textContent = (item.isDirectory ? "📁 " : "📄 ") + item.name;
      a.onclick = (e) => {
        e.preventDefault();
        if (item.isDirectory) reloadFilesTab(fullPath);
        else downloadPlaydateFile(fullPath, item.name);
      };
      tdName.appendChild(a);

      const tdSize = document.createElement("td");
      tdSize.textContent = item.isDirectory ? "Folder" : formatBytes(item.size || 0);

      const tdAct = document.createElement("td");
      tdAct.style.textAlign = "right";
      if (!item.isDirectory) {
        const dlBtn = document.createElement("button");
        dlBtn.className = "btn-small";
        dlBtn.textContent = "Download";
        dlBtn.style.marginRight = "6px";
        dlBtn.onclick = () => downloadPlaydateFile(fullPath, item.name);
        tdAct.appendChild(dlBtn);
      }
      const delBtn = document.createElement("button");
      delBtn.className = "btn-small btn-delete";
      delBtn.textContent = "Delete";
      delBtn.onclick = async () => {
        if (!(await showWebConfirm(`Delete "${item.name}"?`))) return;
        await fetch("/delete", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "path=" + encodeURIComponent(fullPath),
        });
        showWebToast(`Deleted ${item.name}`, false);
        reloadFilesTab(currentFilesPath);
      };
      tdAct.appendChild(delBtn);

      tr.append(tdName, tdSize, tdAct);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.replaceChildren(table);
  } catch (e) {
    hubLog("error", "files", "Error loading files: " + (e.message || e), e);
    container.innerHTML = `<p class="empty-state">Error loading files: ${e.message || e}</p>`;
  }
}

async function downloadPlaydateFile(fullPath, filename) {
  try {
    const res = await fetch("/download?path=" + encodeURIComponent(fullPath));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    hubLog("error", "files", "Download failed: " + (e.message || e), e);
    showWebToast("Download failed: " + (e.message || e), true);
  }
}

async function uploadSelectedFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  for (const file of Array.from(fileList)) {
    showWebToast(`Uploading ${file.name}…`, false);
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch(
      "/upload?path=" + encodeURIComponent(currentFilesPath) + "&overwrite=1",
      {
        method: "POST",
        body: form,
      },
    );
    if (!res.ok) {
      showWebToast(`Upload failed for ${file.name}`, true);
      return;
    }
  }
  showWebToast("Upload complete!", false);
  document.getElementById("fileUploadInput").value = "";
  await reloadFilesTab(currentFilesPath);
}

async function promptCreateFolder() {
  const name = prompt("New folder name:");
  if (!name || !name.trim()) return;
  await fetch("/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ path: currentFilesPath, name: name.trim() }).toString(),
  });
  await reloadFilesTab(currentFilesPath);
}

// ---- Settings Tab ----
function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function reloadSettingsTab() {
  const container = document.getElementById("settings-container");
  try {
    const res = await fetch("/api/settings");
    allSettings = await res.json();
    const groups = {};
    for (const s of allSettings) {
      const cat = s.category || "Other";
      (groups[cat] = groups[cat] || []).push(s);
    }
    let html = "";
    for (const [cat, list] of Object.entries(groups)) {
      html += `<div class="card"><h2>${escapeHtml(cat)}</h2>`;
      for (const s of list) {
        const id = "setting-" + s.key;
        let ctrl = "";
        if (s.type === "toggle") {
          ctrl = `<label class="toggle-switch"><input type="checkbox" id="${id}" ${s.value ? "checked" : ""}><span class="toggle-slider"></span></label>`;
        } else if (s.type === "enum") {
          ctrl =
            `<select id="${id}">` +
            (s.options || [])
              .map(
                (opt, idx) =>
                  `<option value="${idx}" ${idx === s.value ? "selected" : ""}>${escapeHtml(opt)}</option>`,
              )
              .join("") +
            `</select>`;
        } else if (s.type === "value") {
          ctrl = `<input type="number" id="${id}" value="${s.value}" min="${s.min}" max="${s.max}" step="${s.step}">`;
        } else if (s.type === "string") {
          const isPw = "hasPassword" in s;
          ctrl = `<input type="${isPw ? "password" : "text"}" id="${id}" value="${escapeHtml(s.value || "")}" placeholder="${s.hasPassword ? "(unchanged)" : ""}" oninput="this.dataset.changed='true'">`;
        }
        html += `<div class="setting-row"><span class="setting-name">${escapeHtml(s.name)}</span><span class="setting-control">${ctrl}</span></div>`;
      }
      html += `</div>`;
    }
    container.innerHTML = html;
    document.getElementById("save-container").style.display = "block";
  } catch (e) {
    hubLog("error", "settings", "Failed to load settings: " + (e.message || e), e);
    container.innerHTML = `<div class="card"><p class="empty-state">Failed to load settings: ${e.message || e}</p></div>`;
  }
}

async function saveSettings() {
  const payload = {};
  for (const s of allSettings) {
    const el = document.getElementById("setting-" + s.key);
    if (!el) continue;
    if (s.type === "toggle") payload[s.key] = el.checked ? 1 : 0;
    else if (s.type === "enum" || s.type === "value") payload[s.key] = parseInt(el.value, 10);
    else if (s.type === "string") {
      if ("hasPassword" in s && !el.dataset.changed) continue;
      payload[s.key] = el.value;
    }
  }
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    showWebToast("Settings saved to Playdate!", false);
    await reloadSettingsTab();
  } else {
    showWebToast("Failed to save settings", true);
  }
}

// ---- Fonts Tab ----
async function reloadFontsTab() {
  const el = document.getElementById("families");
  try {
    const res = await fetch("/api/fonts");
    const data = await res.json();
    el.replaceChildren();
    if (!data.families || data.families.length === 0) {
      el.innerHTML = `<p class="empty-state">No custom fonts installed on Playdate.</p>`;
      return;
    }
    for (const f of data.families) {
      const row = document.createElement("div");
      row.className = "setting-row";
      const filesDesc = (f.files || [])
        .map((fi) => `${fi.name} (${formatBytes(fi.size || 0)})`)
        .join(", ");
      row.innerHTML = `<span class="setting-name"><b>${escapeHtml(f.name)}</b><br><small style="color:var(--label-color)">${escapeHtml(filesDesc)}</small></span>`;
      const btn = document.createElement("button");
      btn.className = "btn-small btn-delete";
      btn.textContent = "Delete";
      btn.onclick = async () => {
        if (!(await showWebConfirm(`Delete font family "${f.name}"?`))) return;
        await fetch("/api/fonts/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ family: f.name }),
        });
        showWebToast(`Deleted font ${f.name}`, false);
        reloadFontsTab();
      };
      row.appendChild(btn);
      el.appendChild(row);
    }
  } catch (e) {
    hubLog("error", "fonts", "Failed to load fonts: " + (e.message || e), e);
    el.innerHTML = `<p class="empty-state">Failed to load fonts.</p>`;
  }
}

async function uploadSelectedFonts() {
  const input = document.getElementById("fontFilesInput");
  const files = Array.from(input.files || []).filter((f) =>
    /\.(cpfont|ttf|otf)$/i.test(f.name),
  );
  if (files.length === 0) {
    showWebToast("Please select .cpfont, .ttf, or .otf font files.", true);
    return;
  }
  const stem = files[0].name.replace(/\.(cpfont|ttf|otf)$/i, "");
  const cut = Math.max(stem.lastIndexOf("-"), stem.lastIndexOf("_"));
  const family = (cut > 0 ? stem.slice(0, cut) : stem).replace(/[^A-Za-z0-9_-]/g, "_");
  for (const file of files) {
    showWebToast(`Uploading ${file.name} to family "${family}"…`, false);
    const fd = new FormData();
    fd.append("family", family);
    fd.append("file", file, file.name);
    await fetch("/api/fonts/upload", { method: "POST", body: fd });
  }
  input.value = "";
  showWebToast(`Uploaded ${files.length} font file(s) to "${family}"!`, false);
  await reloadFontsTab();
}

hubLog(
  "info",
  "startup",
  `Web Hub ${WEB_HUB_VERSION} initialized (origin=${window.location.origin}, protocol=${window.location.protocol}, serial=${"serial" in navigator}, dirPicker=${"showDirectoryPicker" in window})`,
);
