/* global hubLog, isVerboseSerialEnabled, normalizeVPath, base64ToUint8, uint8ToBase64, showWebToast */
/* exported WebSerialBackend */

class WebSerialBackend {
  constructor(port) {
    this.port = port;
    this.modeName = "Live USB Serial";
    this.targetDescription = "Playdate USB CDC Serial (115200 baud)";
    this.rxBuffer = "";
    this.rxLineQueue = [];
    this.lineWaiters = [];
    this.reader = null;
    this.writer = null;
    this.mutex = Promise.resolve();
  }

  async open() {
    hubLog("info", "serial", "Opening Web Serial port at 115200 baud…");
    await this.port.open({ baudRate: 115200 });
    try {
      if (typeof this.port.setSignals === "function") {
        await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
      }
    } catch (sigErr) {
      hubLog("debug", "serial", "setSignals not supported or ignored", sigErr);
    }
    this.writer = this.port.writable.getWriter();
    this._startReadLoop();
    const ok = await this.ping();
    if (!ok) {
      await this.close();
      throw new Error(
        "Connected to serial port, but CrossPoint did not respond to !CP PING. " +
          "Make sure CrossPoint Reader (with Serial Bridge support) is open on your Playdate!",
      );
    }
  }

  async close() {
    try {
      if (this.reader) await this.reader.cancel();
    } catch {
      // Ignore cancel errors
    }
    try {
      if (this.reader) this.reader.releaseLock();
    } catch {
      // Ignore lock release errors
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      // Ignore lock release errors
    }
    try {
      await this.port.close();
    } catch {
      // Ignore port close errors
    }
  }

  _deliverCpLine(line) {
    if (isVerboseSerialEnabled()) {
      hubLog("debug", "serial-rx", line);
    }
    if (this.lineWaiters.length > 0) {
      const w = this.lineWaiters.shift();
      w.resolve(line);
    } else {
      this.rxLineQueue.push(line);
    }
  }

  _startReadLoop() {
    const decoder = new TextDecoder();
    this.reader = this.port.readable.getReader();
    (async () => {
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) {
            this.rxBuffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = this.rxBuffer.indexOf("\n")) !== -1) {
              const line = this.rxBuffer.slice(0, nl).replace(/\r$/, "");
              this.rxBuffer = this.rxBuffer.slice(nl + 1);
              if (line.includes("@CP ")) {
                this._deliverCpLine(line);
              } else if (line.trim() && isVerboseSerialEnabled()) {
                hubLog("debug", "serial-console", line);
              }
            }
          }
        }
      } catch (e) {
        hubLog("warn", "serial", "WebSerial read loop ended: " + (e.message || e));
        while (this.lineWaiters.length > 0) {
          this.lineWaiters.shift().reject(e);
        }
      }
    })();
  }

  _nextCpLine(timeoutMs = 8000, cmdLabel = "") {
    if (this.rxLineQueue.length > 0) {
      return Promise.resolve(this.rxLineQueue.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.lineWaiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) this.lineWaiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out waiting for Playdate USB Serial response (${cmdLabel || "command"})`,
          ),
        );
      }, timeoutMs);
      const wrappedResolve = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      const wrappedReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.lineWaiters.push({ resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  _cmd(cpArgs, timeoutMs = 8000) {
    const run = async () => {
      this.lineWaiters.length = 0;
      this.rxLineQueue.length = 0;
      const cmdLabel = cpArgs.split(" ")[0];
      if (
        isVerboseSerialEnabled() ||
        (cmdLabel !== "WDATA" && cmdLabel !== "WCHUNK" && cmdLabel !== "WFLUSH")
      ) {
        hubLog(
          "debug",
          "serial-tx",
          "!CP " +
            (cmdLabel === "WDATA" || cmdLabel === "WCHUNK"
              ? `${cmdLabel} <${cpArgs.length - cmdLabel.length - 1} b64 chars>`
              : cpArgs),
        );
      }
      const payload = new TextEncoder().encode("msg !CP " + cpArgs + "\r\n");
      await this.writer.write(payload);
      const items = [];
      const dataChunks = [];
      while (true) {
        const line = await this._nextCpLine(timeoutMs, cpArgs);
        const idx = line.indexOf("@CP ");
        if (idx === -1) continue;
        const resp = line.slice(idx + 4);
        if (resp.startsWith("ITEM ")) {
          items.push(resp.slice(5));
        } else if (resp.startsWith("DATA ")) {
          dataChunks.push(resp.slice(5));
        } else if (resp.startsWith("OK")) {
          return { ok: true, rest: resp.slice(2).trim(), items, dataChunks };
        } else if (resp.startsWith("ERR")) {
          const errRest = resp.slice(3).trim();
          hubLog("debug", "serial-err", `!CP ${cpArgs} -> ERR ${errRest}`);
          return { ok: false, rest: errRest, items, dataChunks };
        }
      }
    };
    const next = this.mutex.then(run, run);
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async _cmdWithRetry(cpArgs, timeoutMs = 8000, maxAttempts = 3) {
    const cmdLabel = cpArgs.split(" ")[0];
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this._cmd(cpArgs, timeoutMs);
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts) {
          hubLog(
            "warn",
            "serial-retry",
            `Retrying !CP ${cmdLabel} (attempt ${attempt + 1}/${maxAttempts}) after error: ${e.message || e}`,
          );
          await new Promise((r) => setTimeout(r, 200 * attempt));
        }
      }
    }
    throw lastErr;
  }

  async ping() {
    try {
      const { ok, rest } = await this._cmd("PING", 3000);
      if (!ok) return false;
      const doc = JSON.parse(rest);
      if (doc.version) {
        this.deviceVersion = doc.version;
        this.targetDescription = `Playdate (${doc.version}) via Live USB Serial`;
      }
      hubLog("info", "serial", "PING succeeded", doc);
      return !!doc.ok;
    } catch (e) {
      hubLog("error", "serial", "PING failed: " + (e.message || e));
      return false;
    }
  }

  async stat(vpath) {
    vpath = normalizeVPath(vpath);
    const { ok, rest } = await this._cmdWithRetry("STAT " + vpath, 8000, 3);
    if (!ok) return { exists: false, isDir: false, size: 0 };
    try {
      const doc = JSON.parse(rest);
      return { exists: !!doc.exists, isDir: !!doc.isDir, size: Number(doc.size || 0) };
    } catch {
      return { exists: false, isDir: false, size: 0 };
    }
  }

  async exists(vpath) {
    return (await this.stat(vpath)).exists;
  }

  async isDir(vpath) {
    const st = await this.stat(vpath);
    return st.exists && st.isDir;
  }

  async listDir(vpath) {
    vpath = normalizeVPath(vpath);
    const { ok, items } = await this._cmdWithRetry("LIST " + vpath, 8000, 3);
    if (!ok) return [];
    const out = [];
    for (const raw of items) {
      try {
        const d = JSON.parse(raw);
        out.push({ name: String(d.name || ""), isDir: !!d.isDir, size: Number(d.size || 0) });
      } catch {
        // Ignore malformed item
      }
    }
    return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  async readFile(vpath) {
    vpath = normalizeVPath(vpath);
    const st = await this.stat(vpath);
    if (!st.exists || st.isDir) throw new Error("Not found: " + vpath);
    const totalSize = st.size;
    const chunks = [];
    let offset = 0;
    const step = 4096;
    while (offset < totalSize || (totalSize === 0 && offset === 0)) {
      const { ok, rest, dataChunks } = await this._cmdWithRetry(
        `READ ${offset} ${step} ${vpath}`,
        12000,
        3,
      );
      if (!ok) throw new Error("Serial READ failed: " + rest);
      const b64 = dataChunks.join("");
      const part = b64 ? base64ToUint8(b64) : new Uint8Array(0);
      chunks.push(part);
      if (part.length < step || totalSize === 0) break;
      offset += part.length;
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const res = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      res.set(c, pos);
      pos += c.length;
    }
    return res;
  }

  async writeFile(vpath, dataBytes) {
    const runWrite = async () => {
      vpath = normalizeVPath(vpath);
      const bytes = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
      const fileName = vpath.split("/").pop() || vpath;
      const isLarge = bytes.length >= 8192;
      const t0 = performance.now();
      let lastProgressBytes = 0;
      let lastProgressTime = t0;
      const reportProgress = (writtenBytes, force = false) => {
        if (!isLarge) return;
        const now = performance.now();
        if (
          !force &&
          writtenBytes - lastProgressBytes < 32768 &&
          now - lastProgressTime < 4000
        ) {
          return;
        }
        lastProgressBytes = writtenBytes;
        lastProgressTime = now;
        const elapsedSec = Math.max(0.05, (now - t0) / 1000);
        const kbps = (writtenBytes / 1024 / elapsedSec).toFixed(1);
        const pct =
          bytes.length > 0
            ? Math.min(100, Math.round((writtenBytes * 100) / bytes.length))
            : 100;
        hubLog(
          "info",
          "serial-write",
          `Writing ${fileName}: ${(writtenBytes / 1024).toFixed(1)} KB / ${(bytes.length / 1024).toFixed(1)} KB (${pct}%, ${kbps} KB/s)`,
        );
        if (typeof showWebToast === "function") {
          showWebToast(`Writing ${fileName}: ${pct}% (${kbps} KB/s)`, false);
        }
      };

      if (isLarge) {
        hubLog(
          "info",
          "serial-write",
          `Starting write of ${vpath} (${(bytes.length / 1024).toFixed(1)} KB)…`,
        );
      }

      const openRes = await this._cmdWithRetry("WOPEN " + vpath, 8000, 3);
      if (!openRes.ok) throw new Error("Serial WOPEN failed: " + openRes.rest);

      if (this._supportsWchunk !== false && bytes.length > 0) {
        // Fast single-command WCHUNK path: 168 raw bytes = 224 base64 chars per command
        const chunkStep = 168;
        let useLegacyFallback = false;
        for (let i = 0; i < bytes.length; i += chunkStep) {
          const slice = bytes.subarray(i, i + chunkStep);
          const b64 = uint8ToBase64(slice);
          let chunkDone = false;
          for (let attempt = 1; attempt <= 3 && !chunkDone; attempt++) {
            try {
              const res = await this._cmd("WCHUNK " + b64, 8000);
              if (!res.ok) {
                if (i === 0 && res.rest && res.rest.includes("unknown command")) {
                  this._supportsWchunk = false;
                  useLegacyFallback = true;
                  break;
                }
                throw new Error("Serial WCHUNK failed: " + res.rest);
              }
              this._supportsWchunk = true;
              chunkDone = true;
            } catch (err) {
              if (attempt >= 3) throw err;
              hubLog(
                "warn",
                "serial-retry",
                `WCHUNK timeout/error at offset ${i} (attempt ${attempt}/3), checking device write offset…`,
              );
              await new Promise((r) => setTimeout(r, 250 * attempt));
              try {
                const fl = await this._cmd("WFLUSH", 5000);
                if (fl.ok) {
                  const flDoc = JSON.parse(fl.rest || "{}");
                  if (Number(flDoc.written) === i + slice.length) {
                    chunkDone = true;
                    break;
                  }
                }
              } catch {
                // Retry chunk
              }
            }
          }
          if (useLegacyFallback) break;
          reportProgress(Math.min(bytes.length, i + slice.length));
        }
        if (!useLegacyFallback) {
          const cl = await this._cmdWithRetry("WCLOSE", 10000, 3);
          if (!cl.ok) throw new Error("Serial WCLOSE failed: " + cl.rest);
          if (isLarge) {
            const totalSec = Math.max(0.05, (performance.now() - t0) / 1000);
            const kbps = (bytes.length / 1024 / totalSec).toFixed(1);
            hubLog(
              "info",
              "serial-write",
              `Completed ${vpath} (${(bytes.length / 1024).toFixed(1)} KB in ${totalSec.toFixed(1)}s, ${kbps} KB/s)`,
            );
          }
          return;
        }
        const reopenRes = await this._cmdWithRetry("WOPEN " + vpath, 8000, 3);
        if (!reopenRes.ok) throw new Error("Serial WOPEN failed: " + reopenRes.rest);
      }

      // Legacy fallback (WDATA 120B + WFLUSH) for older Playdate binaries
      const step = 120;
      const flushThreshold = bytes.length <= 2048 ? step : 240;
      let sinceFlush = 0;
      const enc = new TextEncoder();
      for (let i = 0; i < bytes.length; i += step) {
        const slice = bytes.subarray(i, i + step);
        const b64 = uint8ToBase64(slice);
        const sendChunk = async () => {
          if (isVerboseSerialEnabled()) {
            hubLog("debug", "serial-tx", `!CP WDATA (${slice.length}B)`);
          }
          await this.writer.write(enc.encode("msg !CP WDATA " + b64 + "\r\n"));
        };
        const next = this.mutex.then(sendChunk, sendChunk);
        this.mutex = next.then(
          () => undefined,
          () => undefined,
        );
        await next;
        sinceFlush += slice.length;
        if (sinceFlush >= flushThreshold) {
          const fl = await this._cmdWithRetry("WFLUSH", 8000, 3);
          if (!fl.ok) throw new Error("Serial WFLUSH failed: " + fl.rest);
          sinceFlush = 0;
          reportProgress(Math.min(bytes.length, i + slice.length));
        }
      }
      const cl = await this._cmdWithRetry("WCLOSE", 10000, 3);
      if (!cl.ok) throw new Error("Serial WCLOSE failed: " + cl.rest);
      if (isLarge) {
        const totalSec = Math.max(0.05, (performance.now() - t0) / 1000);
        const kbps = (bytes.length / 1024 / totalSec).toFixed(1);
        hubLog(
          "info",
          "serial-write",
          `Completed ${vpath} (${(bytes.length / 1024).toFixed(1)} KB in ${totalSec.toFixed(1)}s, ${kbps} KB/s)`,
        );
      }
    };
    this.writeMutex = (this.writeMutex || Promise.resolve()).then(runWrite, runWrite);
    return this.writeMutex;
  }

  async mkdir(vpath) {
    vpath = normalizeVPath(vpath);
    await this._cmdWithRetry("MKDIR " + vpath, 8000, 3);
  }

  async remove(vpath) {
    vpath = normalizeVPath(vpath);
    const { ok } = await this._cmdWithRetry("RM " + vpath, 8000, 3);
    return ok;
  }

  async rename(oldPath, newPath) {
    oldPath = normalizeVPath(oldPath);
    newPath = normalizeVPath(newPath);
    const { ok } = await this._cmdWithRetry(`RENAME ${oldPath}\t${newPath}`, 8000, 3);
    return ok;
  }

  async relayHttp(reqObj) {
    const runRelay = async () => {
      const reqPath = "/.crosspoint/.serial-relay-req.json";
      hubLog(
        "info",
        "serial-relay",
        `Relaying ${reqObj.method || "GET"} ${reqObj.url} via Playdate Wi-Fi…`,
      );
      await this.writeFile(reqPath, new TextEncoder().encode(JSON.stringify(reqObj)));
      const { ok, rest, dataChunks } = await this._cmd("RELAY " + reqPath, 35000);
      if (!ok) throw new Error(rest || "Serial HTTP relay failed");
      const meta = JSON.parse(rest || "{}");
      const b64 = dataChunks.join("");
      const bodyBytes = b64 ? base64ToUint8(b64) : new Uint8Array(0);
      hubLog(
        "info",
        "serial-relay",
        `Relay completed: HTTP ${meta.status} (${bodyBytes.length || meta.bytes || 0} bytes)`,
      );
      return {
        status: Number(meta.status || 200),
        bytes: Number(meta.bytes || bodyBytes.length),
        bodyBytes,
      };
    };
    this.relayMutex = (this.relayMutex || Promise.resolve()).then(runRelay, runRelay);
    return this.relayMutex;
  }
}
