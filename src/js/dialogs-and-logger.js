/* global webMessageDialog, webDialogTitle, webDialogMessage, webDialogCancel, webDialogConfirm, webToast */
/* exported showWebDialog, showWebAlert, showWebConfirm, showWebToast, hubLog, clearDebugLogs, copyDebugLogs */

try {
  document.cookie = "cpPlugins=1; path=/; SameSite=Strict";
} catch {
  // Ignore cookie errors under restricted file:// origins
}

let webDialogQueue = Promise.resolve();

function showWebDialog(title, message, confirm) {
  const result = webDialogQueue.then(
    () =>
      new Promise((resolve) => {
        webDialogTitle.textContent = title;
        webDialogMessage.textContent = String(message);
        webDialogCancel.hidden = !confirm;
        webDialogConfirm.textContent = confirm ? "Confirm" : "OK";
        webMessageDialog.returnValue = "";
        webMessageDialog.addEventListener(
          "close",
          () => {
            resolve(webMessageDialog.returnValue === "confirm");
          },
          { once: true },
        );
        webMessageDialog.showModal();
      }),
  );
  webDialogQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function showWebAlert(message) {
  return showWebDialog("Notice", message, false).then(() => undefined);
}

function showWebConfirm(message) {
  return showWebDialog("Confirm action", message, true);
}

let webToastTimeout;
function showWebToast(message, isError) {
  clearTimeout(webToastTimeout);
  webToast.textContent = message;
  webToast.className = "toast" + (isError ? " error" : "");
  webToast.style.display = "block";
  webToastTimeout = setTimeout(() => {
    webToast.style.display = "none";
  }, 4500);
}

// Structured Diagnostics Logger
window.__hubLogs = [];
function hubLog(level, category, message, detail) {
  const ts = new Date().toISOString().slice(11, 23);
  const entry = { ts, level, category, message: String(message), detail };
  window.__hubLogs.push(entry);
  const prefix = `[${ts}] [${level.toUpperCase()}] [${category}] ${message}`;
  if (level === "error") console.error(prefix, detail !== undefined ? detail : "");
  else if (level === "warn") console.warn(prefix, detail !== undefined ? detail : "");
  else if (level === "info") console.info(prefix, detail !== undefined ? detail : "");
  else console.debug(prefix, detail !== undefined ? detail : "");

  const outEl = document.getElementById("debugLogOutput");
  const countEl = document.getElementById("debugLogCount");
  if (countEl) countEl.textContent = String(window.__hubLogs.length);
  if (outEl) {
    const span = document.createElement("div");
    span.className = "log-line-" + level;
    let lineText = prefix;
    if (detail !== undefined && detail !== null && detail !== "") {
      if (detail instanceof Error) {
        lineText += " — " + (detail.stack || detail.message);
      } else if (typeof detail === "object") {
        try {
          lineText += " " + JSON.stringify(detail);
        } catch {
          // Ignore circular JSON
        }
      } else {
        lineText += " " + String(detail);
      }
    }
    span.textContent = lineText;
    outEl.appendChild(span);
    outEl.scrollTop = outEl.scrollHeight;
  }
  if (level === "error") {
    const drawer = document.getElementById("debugDrawer");
    if (drawer) drawer.open = true;
  }
}

function clearDebugLogs() {
  window.__hubLogs.length = 0;
  const outEl = document.getElementById("debugLogOutput");
  const countEl = document.getElementById("debugLogCount");
  if (outEl) outEl.replaceChildren();
  if (countEl) countEl.textContent = "0";
}

async function copyDebugLogs() {
  const text = window.__hubLogs
    .map((e) => {
      let s = `[${e.ts}] [${e.level.toUpperCase()}] [${e.category}] ${e.message}`;
      if (e.detail !== undefined) {
        try {
          s +=
            " " +
            (e.detail instanceof Error
              ? e.detail.stack || e.detail.message
              : JSON.stringify(e.detail));
        } catch {
          // Ignore circular JSON
        }
      }
      return s;
    })
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    showWebToast("Copied debug logs to clipboard!", false);
  } catch {
    showWebToast("Could not copy to clipboard — select text in console drawer.", true);
  }
}

window.addEventListener("error", (ev) => {
  hubLog("error", "window.onerror", ev.message || "Uncaught script error", {
    filename: ev.filename,
    lineno: ev.lineno,
    colno: ev.colno,
  });
});

window.addEventListener("unhandledrejection", (ev) => {
  const reason = ev.reason;
  hubLog(
    "error",
    "unhandledrejection",
    reason && reason.message ? reason.message : String(reason),
    reason,
  );
});
