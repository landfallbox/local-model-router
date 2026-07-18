import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, normalizeConfig, validateConfig } from "../../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAY_REFRESH_INTERVAL_MS = 15000;
const HIDDEN_START_ARGS = new Set(["--hidden", "--background", "--minimized", "--tray"]);
const isDevelopmentRuntime = process.env.LOCAL_MODEL_ROUTER_DEV_MODE === "1";
const APP_DISPLAY_NAME = isDevelopmentRuntime ? "Local Model Router Dev" : "Local Model Router";
const APP_USER_MODEL_ID = isDevelopmentRuntime ? "local.local-model-router.dev" : "local.local-model-router";

let mainWindow = null;
let tray = null;
let trayRefreshTimer = null;
let trayBusyAction = "";
let isQuitting = false;
let closePromptActive = false;
let trayStatus = { label: "Checking", detail: "", isRouterActive: false };
const windowsToShowOnReady = new WeakSet();

function resolveAppDir() {
  const candidates = [process.env.LOCAL_MODEL_ROUTER_APP_DIR];

  if (app.isPackaged) {
    candidates.push(
      resolve(process.resourcesPath, "app.asar.unpacked"),
      resolve(process.resourcesPath, "app"),
    );
  }

  candidates.push(
    resolve(__dirname, "..", "..", "app"),
    resolve(__dirname, "..", ".."),
    resolve(process.resourcesPath || "", "app"),
  );

  for (const candidate of candidates.filter(Boolean)) {
    if (existsSync(join(candidate, "src", "server.js"))) {
      return candidate;
    }
  }

  throw new Error("Could not find the router app directory.");
}

function getPaths() {
  const appDir = resolveAppDir();
  const dataDir = process.env.LOCAL_MODEL_ROUTER_DATA_DIR || (app.isPackaged ? app.getPath("userData") : appDir);
  const configPath = process.env.ROUTER_CONFIG || join(dataDir, "config.json");
  const serverPath = join(appDir, "src", "server.js");
  const pidPath = join(dataDir, "router.pid");
  const packageRoot = app.isPackaged ? process.resourcesPath : dirname(appDir);
  const nodePath = resolveNodePath(packageRoot);

  return {
    appDir,
    dataDir,
    configPath,
    serverPath,
    pidPath,
    packageRoot,
    nodePath,
  };
}

function resolveNodePath(packageRoot) {
  if (process.env.LOCAL_MODEL_ROUTER_NODE) {
    return process.env.LOCAL_MODEL_ROUTER_NODE;
  }

  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [
    join(packageRoot, "bin", executableName),
    app.isPackaged ? join(process.resourcesPath, "bin", executableName) : "",
  ];

  for (const candidate of candidates.filter(Boolean)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return executableName;
}

function resolveIconPath() {
  const candidates = [
    process.env.LOCAL_MODEL_ROUTER_ICON,
    app.isPackaged ? join(process.resourcesPath, "assets", "icon.ico") : "",
    resolve(__dirname, "..", "..", "build", "icon.ico"),
  ];

  return candidates.filter(Boolean).find((candidate) => existsSync(candidate)) || "";
}

function createAppIcon() {
  const iconPath = resolveIconPath();
  if (!iconPath) {
    return null;
  }

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? null : icon;
}

function ensureConfigFile(paths = getPaths()) {
  if (existsSync(paths.configPath)) {
    return;
  }

  mkdirSync(dirname(paths.configPath), { recursive: true });
  const defaultPort = clampNumber(process.env.LOCAL_MODEL_ROUTER_DEFAULT_PORT, DEFAULT_CONFIG.router.port, 1, 65535);
  const config = normalizeConfig({
    ...DEFAULT_CONFIG,
    router: {
      ...DEFAULT_CONFIG.router,
      port: defaultPort,
      apiKey: generateRouterApiKey(),
    },
  });
  writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function configureRuntimeIdentity() {
  const userDataDir = process.env.LOCAL_MODEL_ROUTER_USER_DATA_DIR;
  if (userDataDir) {
    mkdirSync(userDataDir, { recursive: true });
    app.setPath("userData", userDataDir);
  }

  if (isDevelopmentRuntime) {
    app.setName(APP_DISPLAY_NAME);
  }
}

function generateRouterApiKey() {
  return `lmr_${randomBytes(24).toString("base64url")}`;
}

async function readJson(path) {
  const text = await fs.readFile(path, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

async function loadConfig() {
  const paths = getPaths();
  ensureConfigFile(paths);
  const config = normalizeConfig(await readJson(paths.configPath));

  return { config, paths, endpoint: getEndpoint(config), appName: APP_DISPLAY_NAME, isDevelopmentRuntime };
}

function getEndpoint(config) {
  const host = config.router?.host || "127.0.0.1";
  const port = Number(config.router?.port || 4000);
  return `http://${host}:${port}/v1/chat/completions`;
}

function getRouterBaseUrl(config) {
  const host = config.router?.host || "127.0.0.1";
  const port = Number(config.router?.port || 4000);
  return `http://${host}:${port}`;
}

function getVendorModelsUrl(vendor) {
  const baseUrl = String(vendor?.baseUrl || "").trim();
  if (!baseUrl) {
    throw new Error("Enter the vendor Base URL before refreshing models.");
  }

  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Vendor Base URL must use HTTP or HTTPS.");
  }

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchVendorModels(_event, vendor) {
  const url = getVendorModelsUrl(vendor);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const apiKey = String(vendor?.apiKey || "").trim();

  try {
    const response = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    if (!response.ok) {
      const upstreamError = body?.error && typeof body.error === "object" ? body.error : body;
      const message = upstreamError?.message || text || `HTTP ${response.status}`;
      const error = new Error(message);
      error.code = upstreamError?.code || `HTTP_${response.status}`;
      error.statusCode = response.status;
      throw error;
    }

    const data = Array.isArray(body?.data) ? body.data : [];
    const models = [...new Set(data.map((model) => String(model?.id || "").trim()).filter(Boolean))];
    if (!models.length) {
      throw new Error("The vendor did not return any models.");
    }

    return { models, url };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Refreshing models timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function hasUsableVendor(config) {
  return Array.isArray(config.vendors) && config.vendors.some(isUsableVendor);
}

function isUsableVendor(vendor) {
  if (!vendor || vendor.enabled === false) {
    return false;
  }

  if (!String(vendor.name || "").trim() || !String(vendor.baseUrl || "").trim()) {
    return false;
  }

  try {
    const url = new URL(String(vendor.baseUrl).trim());
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
  } catch {
    return false;
  }

  const authentication = vendor.authentication === "api-key" || (!vendor.authentication && vendor.apiKey)
    ? "api-key"
    : "none";
  return authentication !== "api-key" || Boolean(vendor.apiKey);
}

async function saveConfig(_event, config) {
  const { paths } = await loadConfig();
  const normalized = normalizeConfig(config);
  validateConfig(normalized, { requireVendors: false, configPath: paths.configPath });
  await fs.writeFile(paths.configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return { config: normalized, paths, endpoint: getEndpoint(normalized) };
}

async function countRouterProcesses(paths = getPaths()) {
  return (await getManagedRouterPid(paths)) ? 1 : 0;
}

async function getManagedRouterPid(paths = getPaths()) {
  try {
    const pid = Number((await fs.readFile(paths.pidPath, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      await removeRouterPid(paths);
      return 0;
    }

    if (await isProcessRunning(pid)) {
      return pid;
    }

    await removeRouterPid(paths);
    return 0;
  } catch {
    return 0;
  }
}

async function writeRouterPid(paths, pid) {
  mkdirSync(dirname(paths.pidPath), { recursive: true });
  await fs.writeFile(paths.pidPath, `${pid}\n`, "utf8");
}

async function removeRouterPid(paths = getPaths()) {
  await fs.rm(paths.pidPath, { force: true }).catch(() => null);
}

async function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function startRouter() {
  const { config, paths } = await loadConfig();

  if (!hasUsableVendor(config)) {
    const message = "No enabled vendor is configured. Add or enable a vendor before starting Router.";
    setTrayConfigurationIssue(message);
    throw new Error(message);
  }

  const existingHealth = await getHealth(config, { includeProcessCount: true });
  if (existingHealth.ok || Number(existingHealth.processCount || 0) > 0) {
    await refreshTrayStatus(existingHealth);
    return { started: false, via: "existing", health: existingHealth };
  }

  const child = spawn(paths.nodePath, [paths.serverPath], {
    cwd: paths.appDir,
    detached: true,
    env: {
      ...process.env,
      ROUTER_CONFIG: paths.configPath,
      LOCAL_MODEL_ROUTER_DATA_DIR: paths.dataDir,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  child.unref();
  await writeRouterPid(paths, child.pid);
  const health = await waitForHealth(config);
  if (!health.ok) {
    await removeRouterPid(paths);
  }
  await refreshTrayStatus(health);
  return { started: true, via: "process", pid: child.pid, health };
}

async function stopRouter() {
  const paths = getPaths();
  const pid = await getManagedRouterPid(paths);

  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }

    await waitForProcessExit(pid);
    if (await isProcessRunning(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }

  await removeRouterPid(paths);

  const health = await getHealth();
  await refreshTrayStatus(health);
  return { stopped: true, health };
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isProcessRunning(pid)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function restartRouter() {
  await stopRouter();
  return startRouter();
}

async function waitForHealth(config) {
  for (let index = 0; index < 8; index += 1) {
    const health = await getHealth(config, { includeProcessCount: false });
    if (health.ok) {
      return health;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }

  return getHealth(config);
}

async function getHealth(configArg = null, options = {}) {
  const includeProcessCount = options.includeProcessCount !== false;
  const loaded = configArg ? { config: configArg, paths: getPaths() } : await loadConfig();
  const url = `${getRouterBaseUrl(loaded.config)}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  const headers = loaded.config.router.apiKey
    ? { authorization: `Bearer ${loaded.config.router.apiKey}` }
    : {};

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      url,
      body,
      text,
      processCount: 0,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error: error.name === "AbortError" ? "Health check timed out." : error.message,
      processCount: includeProcessCount ? await countRouterProcesses(loaded.paths) : 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getLogPath(configArg = null) {
  const { config, paths } = configArg ? { config: configArg, paths: getPaths() } : await loadConfig();
  const logFile = config.router?.logFile || DEFAULT_CONFIG.router.logFile;
  return isAbsolute(logFile) ? logFile : join(paths.dataDir, logFile);
}

async function readLogs(_event, options = {}) {
  const { config } = await loadConfig();
  const logPath = await getLogPath(config);
  const limit = clampNumber(options.limit, 80, 20, 500);
  const before = Number.isInteger(options.before) ? options.before : null;

  if (!existsSync(logPath)) {
    return { path: logPath, lines: [], nextBefore: null, hasMore: false };
  }

  return readLogPage(logPath, { limit, before });
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

async function readLogPage(logPath, { limit, before }) {
  const handle = await fs.open(logPath, "r");
  try {
    const stat = await handle.stat();
    let position = before === null ? stat.size : Math.min(before, stat.size);
    const lines = [];
    let carry = "";
    const bufferSize = 64 * 1024;

    while (position > 0 && lines.length <= limit) {
      const readSize = Math.min(bufferSize, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      await handle.read(buffer, 0, readSize, position);
      const parts = (buffer.toString("utf8") + carry).split(/\r?\n/);
      carry = parts.shift() || "";
      for (let index = parts.length - 1; index >= 0 && lines.length <= limit; index -= 1) {
        if (parts[index]) {
          lines.unshift(parts[index]);
        }
      }
    }

    if (position === 0 && carry && lines.length < limit) {
      lines.unshift(carry);
    }

    return {
      path: logPath,
      lines: lines.slice(-limit),
      nextBefore: position > 0 || lines.length > limit ? Math.max(0, position) : null,
      hasMore: position > 0 || lines.length > limit,
    };
  } finally {
    await handle.close();
  }
}

async function openConfigFile() {
  const { paths } = await loadConfig();
  return shell.openPath(paths.configPath);
}

async function openLogFile() {
  const logPath = await getLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath)) {
    await fs.writeFile(logPath, "", "utf8");
  }
  return shell.openPath(logPath);
}

async function getAppState() {
  const loaded = await loadConfig();
  return {
    ...loaded,
    health: await getHealth(loaded.config),
  };
}

function hasHiddenStartArg(args = process.argv) {
  return args.some((arg) => HIDDEN_START_ARGS.has(String(arg).toLowerCase())) || process.env.LOCAL_MODEL_ROUTER_START_HIDDEN === "1";
}

function statusFromHealth(health) {
  if (!health) {
    return { label: "Checking", detail: "", isRouterActive: false };
  }

  if (health.ok) {
    return { label: "Running", detail: health.body?.model || "", isRouterActive: true };
  }

  if (Number(health.processCount || 0) > 0) {
    return { label: "Process found", detail: health.error || "Health check failed.", isRouterActive: true };
  }

  return { label: "Stopped", detail: health.error || "", isRouterActive: false };
}

function healthDetail(health) {
  if (!health) {
    return "No health result is available.";
  }

  return health.error || health.text || health.body?.model || health.url || "Router did not report healthy.";
}

function createTrayIcon() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const distance = Math.hypot(x - 7.5, y - 7.5);
      if (distance > 7.5) {
        continue;
      }

      const isRouteLine = (x >= 4 && x <= 11 && y >= 4 && y <= 5) || (x >= 10 && x <= 11 && y >= 4 && y <= 11);
      buffer[offset] = isRouteLine ? 244 : 34;
      buffer[offset + 1] = isRouteLine ? 247 : 197;
      buffer[offset + 2] = isRouteLine ? 251 : 94;
      buffer[offset + 3] = 255;
    }
  }

  return nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor: 1 });
}

function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body: String(body || "") }).show();
  }
}

function getTrayTooltip() {
  const routerState = trayStatus.isRouterActive ? "Running" : "Stopped";
  return `local_model_router: ${routerState}${trayStatus.detail ? `\n${trayStatus.detail}` : ""}`;
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const items = [
    { label: `Current status: ${trayStatus.label}`, enabled: false },
    { type: "separator" },
    { label: "Open Settings", click: showSettingsWindow },
    { label: "Open Logs", click: () => void openLogFile().catch((error) => showNotification("Local Model Router", error.message || String(error))) },
  ];

  if (trayBusyAction) {
    items.push({ label: trayBusyAction, enabled: false });
  } else if (trayStatus.isRouterActive) {
    items.push(
      { label: "Stop Router", click: () => void stopRouterFromTray() },
      { label: "Restart Router", click: () => void restartRouterFromTray() },
    );
  } else if (!trayStatus.isRouterActive) {
    items.push({ label: "Start Router", click: () => void startRouterFromTray() });
  }

  items.push(
    { type: "separator" },
    { label: "Exit", click: () => void quitApplication() },
  );

  tray.setToolTip(getTrayTooltip());
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createAppIcon() || createTrayIcon());
  tray.setToolTip(getTrayTooltip());
  tray.on("double-click", showSettingsWindow);
  updateTrayMenu();

  trayRefreshTimer = setInterval(() => {
    void refreshTrayStatus(null, { notifyOnUnexpectedStop: true });
  }, TRAY_REFRESH_INTERVAL_MS);
  trayRefreshTimer.unref?.();

  return tray;
}

function setTrayConfigurationIssue(detail) {
  trayStatus = { label: "Stopped", detail, isRouterActive: false };
  updateTrayMenu();
}

async function refreshTrayStatus(health = null, { notifyOnUnexpectedStop = false } = {}) {
  if (!tray) {
    return health;
  }

  const nextHealth = health || await getHealth();
  const nextStatus = statusFromHealth(nextHealth);
  if (notifyOnUnexpectedStop && trayStatus.isRouterActive && !nextStatus.isRouterActive && !isQuitting) {
    showNotification("Local Model Router stopped", nextStatus.detail || "The router process is no longer running.");
  }

  trayStatus = nextStatus;
  updateTrayMenu();
  return nextHealth;
}

async function startRouterFromTray() {
  trayBusyAction = "Starting Router...";
  updateTrayMenu();

  try {
    const result = await startRouter();
    if (!result.health?.ok) {
      showNotification("Local Model Router startup issue", healthDetail(result.health));
    }
  } catch (error) {
    showNotification("Local Model Router failed to start", error.message || String(error));
  } finally {
    trayBusyAction = "";
    updateTrayMenu();
  }
}

async function stopRouterFromTray() {
  trayBusyAction = "Stopping Router...";
  updateTrayMenu();

  try {
    await stopRouter();
  } catch (error) {
    showNotification("Local Model Router failed to stop", error.message || String(error));
  } finally {
    trayBusyAction = "";
    updateTrayMenu();
  }
}

async function restartRouterFromTray() {
  trayBusyAction = "Restarting Router...";
  updateTrayMenu();

  try {
    const result = await restartRouter();
    if (!result.health?.ok) {
      showNotification("Local Model Router restart issue", healthDetail(result.health));
    }
  } catch (error) {
    showNotification("Local Model Router failed to restart", error.message || String(error));
  } finally {
    trayBusyAction = "";
    updateTrayMenu();
  }
}

async function startRouterForBackgroundStartup() {
  try {
    const { config } = await loadConfig();
    if (!hasUsableVendor(config)) {
      setTrayConfigurationIssue("No enabled vendors configured.");
      return;
    }

    const result = await startRouter();
    if (!result.health?.ok) {
      showNotification("Local Model Router startup issue", healthDetail(result.health));
    }
  } catch (error) {
    await refreshTrayStatus().catch(() => null);
    showNotification("Local Model Router failed to start", error.message || String(error));
  }
}

function sendOpenSettingsEvent() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("app:openSettings");
  }
}

function showSettingsWindow() {
  if (!app.isReady()) {
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ showWhenReady: true });
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  sendOpenSettingsEvent();
}

function requestWindowCloseConfirmation(window) {
  if (closePromptActive || !window || window.isDestroyed()) {
    return;
  }

  closePromptActive = true;

  if (window.webContents.isDestroyed()) {
    closePromptActive = false;
    window.hide();
    return;
  }

  window.webContents.send("app:confirmClose");
}

async function handleWindowClose(window) {
  try {
    const { config } = await loadConfig();
    const closeBehavior = config.app?.closeBehavior || DEFAULT_CONFIG.app.closeBehavior;

    if (closeBehavior === "exit") {
      await quitApplication();
      return;
    }

    if (closeBehavior === "ask") {
      requestWindowCloseConfirmation(window);
      return;
    }

    closePromptActive = false;
    if (window && !window.isDestroyed()) {
      window.hide();
    }
  } catch (error) {
    showNotification("Local Model Router", `Failed to read close behavior: ${error.message || String(error)}`);
    requestWindowCloseConfirmation(window);
  }
}

async function quitApplication() {
  if (isQuitting) {
    return;
  }

  isQuitting = true;
  trayBusyAction = "Stopping Router...";
  updateTrayMenu();

  try {
    await stopRouter();
  } catch (error) {
    showNotification("Local Model Router", `Failed to stop Router: ${error.message || String(error)}`);
  } finally {
    if (trayRefreshTimer) {
      clearInterval(trayRefreshTimer);
      trayRefreshTimer = null;
    }
    app.quit();
  }
}

function createWindow({ showWhenReady = true } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (showWhenReady) {
      showSettingsWindow();
    }
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    show: false,
    width: 1240,
    height: 820,
    minWidth: 1040,
    minHeight: 700,
    icon: createAppIcon() || undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0B1020" : "#F4F6F8",
    title: APP_DISPLAY_NAME,
    titleBarStyle: "default",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (showWhenReady) {
    windowsToShowOnReady.add(mainWindow);
  }

  const showFallback = showWhenReady ? setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 4000) : null;
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    void handleWindowClose(mainWindow);
  });
  mainWindow.once("closed", () => {
    if (showFallback) {
      clearTimeout(showFallback);
    }
    windowsToShowOnReady.delete(mainWindow);
    mainWindow = null;
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    mainWindow.loadURL(validateRendererUrl(rendererUrl));
  } else {
    mainWindow.loadFile(join(__dirname, "..", "dist", "index.html"));
  }

  return mainWindow;
}

function validateRendererUrl(value) {
  if (app.isPackaged) {
    throw new Error("ELECTRON_RENDERER_URL is only allowed in development.");
  }

  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("ELECTRON_RENDERER_URL must point to a localhost development server.");
  }

  return url.toString();
}

function enablePackagedLoginStartup() {
  if (!app.isPackaged || process.platform !== "win32") {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: ["--hidden"],
  });
}

configureRuntimeIdentity();
app.setAppUserModelId(APP_USER_MODEL_ID);

ipcMain.handle("app:getState", getAppState);
ipcMain.handle("app:rendererReady", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && !window.isDestroyed() && windowsToShowOnReady.has(window) && !window.isVisible()) {
    window.show();
    windowsToShowOnReady.delete(window);
  }
  return { ok: true };
});
ipcMain.handle("app:hideToTray", () => {
  closePromptActive = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  return { ok: true };
});
ipcMain.handle("app:cancelClose", () => {
  closePromptActive = false;
  return { ok: true };
});
ipcMain.handle("app:quitAndStop", async () => {
  closePromptActive = false;
  await quitApplication();
  return { ok: true };
});
ipcMain.handle("config:load", loadConfig);
ipcMain.handle("config:save", saveConfig);
ipcMain.handle("vendor:listModels", fetchVendorModels);
ipcMain.handle("router:start", startRouter);
ipcMain.handle("router:stop", stopRouter);
ipcMain.handle("router:restart", restartRouter);
ipcMain.handle("router:health", (_event, options) => getHealth(null, options));
ipcMain.handle("logs:read", readLogs);
ipcMain.handle("file:openConfig", openConfigFile);
ipcMain.handle("file:openLog", openLogFile);
ipcMain.handle("clipboard:writeText", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return { ok: true };
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (hasHiddenStartArg(commandLine)) {
      void startRouterForBackgroundStartup();
      return;
    }

    showSettingsWindow();
  });

  app.whenReady().then(async () => {
    enablePackagedLoginStartup();
    createTray();
    await refreshTrayStatus().catch(() => null);

    if (hasHiddenStartArg()) {
      void startRouterForBackgroundStartup();
    } else {
      createWindow();
    }
  });

  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    isQuitting = true;
    if (trayRefreshTimer) {
      clearInterval(trayRefreshTimer);
      trayRefreshTimer = null;
    }
  });

  app.on("activate", () => {
    showSettingsWindow();
  });
}
