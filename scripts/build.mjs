#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT_DIR, "src");
const DIST_DIR = path.join(ROOT_DIR, "dist");

function getGitShortSha(cwd) {
  try {
    return (
      execSync("git rev-parse --short=7 HEAD", {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      }).trim() || "dev"
    );
  } catch {
    return "dev";
  }
}

function resolveCrossPointReaderDir() {
  const candidates = [
    process.env.CROSSPOINT_READER_DIR,
    path.resolve(ROOT_DIR, "..", "crosspoint-reader"),
    path.join(ROOT_DIR, ".cache", "crosspoint-reader"),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "src", "network", "html", "assets", "web.css"))) {
      return dir;
    }
  }

  const cacheDir = path.join(ROOT_DIR, ".cache", "crosspoint-reader");
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  const repoUrl =
    process.env.CROSSPOINT_READER_REPO || "https://github.com/aviraldg/crosspoint-reader.git";
  const branch = process.env.CROSSPOINT_READER_BRANCH || "feat/playdate-port";
  console.log(`Cloning ${repoUrl} (${branch}) into ${cacheDir}...`);
  execSync(`git clone --depth=1 --branch ${branch} ${repoUrl} "${cacheDir}"`, {
    stdio: "inherit",
  });
  return cacheDir;
}

function transformPluginHostJs(rawJs) {
  const oldFetchList = `  let list;
  try { list = await (await fetch('/api/plugins')).json(); } catch (e) { return false; }
  if (!Array.isArray(list)) return false;  // e.g. {"error":"out of memory"}`;

  const newFetchList = `  let list;
  try {
    const r = await fetch('/api/plugins');
    list = await r.json();
    if (!r.ok || !Array.isArray(list)) {
      const msg = (list && list.error) ? list.error : ('HTTP ' + r.status + ': expected array from /api/plugins');
      window.__lastPluginLoadError = msg;
      if (typeof hubLog === 'function') hubLog('error', 'plugin-host', 'Failed to load /api/plugins: ' + msg, list);
      else console.error('[plugin-host] Failed to load /api/plugins:', msg, list);
      return false;
    }
  } catch (e) {
    window.__lastPluginLoadError = (e && e.message) ? e.message : String(e);
    if (typeof hubLog === 'function') hubLog('error', 'plugin-host', 'Exception fetching /api/plugins: ' + window.__lastPluginLoadError, e);
    else console.error('[plugin-host] Exception fetching /api/plugins:', e);
    return false;
  }`;

  if (!rawJs.includes(oldFetchList)) {
    throw new Error("Expected /api/plugins fetch snippet not found in upstream plugin-host.js");
  }

  const oldLoaderSnippet = `    s.src = '/plugin?name=' + encodeURIComponent(p.name) + '&file=plugin.js';
    document.body.appendChild(s);`;

  const newLoaderSnippet = `    const pluginScriptUrl = '/plugin?name=' + encodeURIComponent(p.name) + '&file=plugin.js';
    try {
      const resp = await fetch(pluginScriptUrl);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const codeText = await resp.text();
      const blob = new Blob([codeText + '\\n//# sourceURL=' + pluginScriptUrl], { type: 'application/javascript' });
      s.src = URL.createObjectURL(blob);
    } catch (err) {
      if (typeof hubLog === 'function') hubLog('error', 'plugin-host', 'Failed to fetch ' + pluginScriptUrl + ': ' + (err.message || err), err);
      else console.error('[plugin-host] Failed to fetch', pluginScriptUrl, err);
      showFailure();
      continue;
    }
    document.body.appendChild(s);`;

  if (!rawJs.includes(oldLoaderSnippet)) {
    throw new Error("Expected s.src loader snippet not found in upstream plugin-host.js");
  }

  return rawJs
    .replace(oldFetchList, newFetchList)
    .replace(oldLoaderSnippet, newLoaderSnippet)
    .replaceAll("</script>", "<\\/script>");
}

function build() {
  const readerDir = resolveCrossPointReaderDir();
  const upstreamHtmlDir = path.join(readerDir, "src", "network", "html");

  const controllerSha = getGitShortSha(ROOT_DIR);
  const readerSha = getGitShortSha(readerDir);
  const webHubVersion =
    controllerSha === "dev" ? `2.0.0-playdate-${readerSha}` : `2.0.0-playdate-${controllerSha}`;

  const webCss = fs.readFileSync(path.join(upstreamHtmlDir, "assets", "web.css"), "utf-8");
  const iconSvg = fs.readFileSync(
    path.join(upstreamHtmlDir, "assets", "crosspoint-icon.svg"),
    "utf-8",
  );
  const iconDataUri =
    "data:image/svg+xml;base64," + Buffer.from(iconSvg, "utf-8").toString("base64");
  const jszipJs = fs
    .readFileSync(path.join(upstreamHtmlDir, "js", "jszip.min.js"), "utf-8")
    .replaceAll("</script>", "<\\/script>");
  const pluginHostJs = transformPluginHostJs(
    fs.readFileSync(path.join(upstreamHtmlDir, "js", "plugin-host.js"), "utf-8"),
  );

  const controllerCss = fs.readFileSync(
    path.join(SRC_DIR, "styles", "controller.css"),
    "utf-8",
  );
  const templateHtml = fs.readFileSync(path.join(SRC_DIR, "index.template.html"), "utf-8");

  const preJsFiles = [
    "dialogs-and-logger.js",
    "utils-and-crypto.js",
    "web-serial-backend.js",
    "fs-access-backend.js",
    "virtual-api-router.js",
  ];
  const postJsFiles = ["ui-controllers.js"];

  const readJsBundle = (files) =>
    files
      .map((fn) =>
        fs
          .readFileSync(path.join(SRC_DIR, "js", fn), "utf-8")
          .replace(/^\/\* (?:global|exported) .* \*\/\n/gm, "")
          .replaceAll("__WEB_HUB_VERSION__", webHubVersion),
      )
      .join("\n")
      .replaceAll("</script>", "<\\/script>");

  const preJs = readJsBundle(preJsFiles);
  const postJs = readJsBundle(postJsFiles);

  const builtHtml = templateHtml
    .replaceAll("__ICON_DATA_URI__", iconDataUri)
    .replace("__WEB_CSS__", () => webCss)
    .replace("__CONTROLLER_CSS__", () => controllerCss)
    .replace("__JSZIP_JS__", () => jszipJs)
    .replace("__CONTROLLER_PRE_JS__", () => preJs)
    .replace("__PLUGIN_HOST_JS__", () => pluginHostJs)
    .replace("__CONTROLLER_POST_JS__", () => postJs);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(path.join(DIST_DIR, "index.html"), builtHtml, "utf-8");
  fs.writeFileSync(path.join(DIST_DIR, "playdate_web_hub.html"), builtHtml, "utf-8");
  fs.writeFileSync(path.join(DIST_DIR, "404.html"), builtHtml, "utf-8");
  fs.writeFileSync(path.join(DIST_DIR, ".nojekyll"), "", "utf-8");

  if (process.env.CUSTOM_DOMAIN) {
    fs.writeFileSync(
      path.join(DIST_DIR, "CNAME"),
      process.env.CUSTOM_DOMAIN.trim() + "\n",
      "utf-8",
    );
  }

  console.log(
    `Built dist/index.html & dist/playdate_web_hub.html (${builtHtml.length} bytes, version=${webHubVersion}, upstream=${readerDir})`,
  );
  return { builtHtml, webHubVersion, readerDir };
}

export { getGitShortSha, resolveCrossPointReaderDir, transformPluginHostJs, build };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
}
