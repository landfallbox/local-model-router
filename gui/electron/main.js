import { app, BrowserWindow, clipboard, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, normalizeConfig } from "../../src/config.js";
import { getChatCompletionsUrl, getRouterBaseUrl } from "../../src/router-urls.js";
import { readConfigStore, writeConfigStore } from "./config-store.js";
import { parseIpcRequest, parseIpcResponse } from "./ipc-contracts.js";
import { ensureLogFile, readLogPage, resolveLogPath } from "./log-store.js";
import { createTrayController, healthDetail } from "./tray-controller.js";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  initializeUpdater,
  installUpdate,
  onUpdateState,
  openReleasePage,
} from "./updater.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIDDEN_START_ARGS = new Set(["--hidden", "--background", "--minimized", "--tray"]);
const isDevelopmentRuntime = process.env.LOCAL_MODEL_ROUTER_DEV_MODE === "1";
const APP_DISPLAY_NAME = isDevelopmentRuntime ? "Local Model Router Dev" : "Local Model Router";
const APP_USER_MODEL_ID = isDevelopmentRuntime ? "local.local-model-router.dev" : "local.local-model-router";

let mainWindow = null;
let isQuitting = false;
let closePromptActive = false;
let routerLifecycleQueue = Promise.resolve();
let managedRouterChild = null;
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

async function loadConfig() {
  const paths = getPaths();
  ensureConfigFile(paths);
  const { config, revision } = await readConfigStore(paths.configPath);

  return {
    config,
    revision,
    paths,
    endpoint: getEndpoint(config),
    appName: APP_DISPLAY_NAME,
    appVersion: app.getVersion(),
    isDevelopmentRuntime,
  };
}

function getEndpoint(config) {
  return getChatCompletionsUrl(config);
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
  const apiKey = vendor?.authentication === "api-key" ? String(vendor?.apiKey || "").trim() : "";

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

async function saveConfig(_event, payload) {
  const { paths } = await loadConfig();
  const config = payload?.config || payload;
  const revision = payload?.revision || "";
  const saved = await writeConfigStore(paths.configPath, config, revision);
  applyPackagedLoginStartup(saved.config.app.startAtLogin);
  return { ...saved, paths, endpoint: getEndpoint(saved.config) };
}

async function countRouterProcesses(paths = getPaths()) {
  return (await getManagedRouterMetadata(paths)) ? 1 : 0;
}

async function getManagedRouterMetadata(paths = getPaths()) {
  try {
    const metadata = JSON.parse(await fs.readFile(paths.pidPath, "utf8"));
    if (!Number.isInteger(metadata.pid) || metadata.pid <= 0 || !metadata.instanceId) {
      await removeRouterPid(paths);
      return null;
    }

    if (await isProcessRunning(metadata.pid)) {
      return metadata;
    }

    await removeRouterPid(paths);
    return null;
  } catch {
    await removeRouterPid(paths);
    return null;
  }
}

async function writeRouterPid(paths, metadata) {
  mkdirSync(dirname(paths.pidPath), { recursive: true });
  await fs.writeFile(paths.pidPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
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

function enqueueRouterLifecycle(operation) {
  const result = routerLifecycleQueue.then(operation, operation);
  routerLifecycleQueue = result.catch(() => null);
  return result;
}

function startRouter() {
  return enqueueRouterLifecycle(startRouterInternal);
}

async function startRouterInternal() {
  const { config, paths } = await loadConfig();

  if (!hasUsableVendor(config)) {
    const message = "No enabled vendor is configured. Add or enable a vendor before starting Router.";
    trayController.setConfigurationIssue(message);
    throw new Error(message);
  }

  const existingHealth = await getHealth(config, { includeProcessCount: true });
  if (existingHealth.ok || Number(existingHealth.processCount || 0) > 0) {
    await trayController.refreshStatus(existingHealth);
    return { started: false, via: "existing", health: existingHealth };
  }

  const processLog = await prepareProcessLog(paths);
  const processLogFd = openSync(processLog.path, "a");
  const instanceId = randomUUID();
  const managementToken = randomBytes(32).toString("base64url");
  let child;
  try {
    child = spawn(paths.nodePath, [paths.serverPath], {
      cwd: paths.appDir,
      env: {
        ...process.env,
        ROUTER_CONFIG: paths.configPath,
        LOCAL_MODEL_ROUTER_DATA_DIR: paths.dataDir,
        LOCAL_MODEL_ROUTER_INSTANCE_ID: instanceId,
        LOCAL_MODEL_ROUTER_MANAGEMENT_TOKEN: managementToken,
      },
      stdio: ["ignore", processLogFd, processLogFd, "ipc"],
      windowsHide: true,
    });
    trackManagedRouterChild(child, paths, instanceId);
  } finally {
    closeSync(processLogFd);
  }

  try {
    await waitForChildSpawn(child);
  } catch (error) {
    const health = await getHealth(config);
    const message = `Router process could not start: ${error.message || String(error)}`;
    const failedHealth = { ...health, ok: false, error: message, processLogPath: processLog.path };
    await recordRouterStartFailure(config, message, processLog.path);
    await trayController.refreshStatus(failedHealth);
    return { started: false, via: "process", health: failedHealth, error: message };
  }

  await writeRouterPid(paths, {
    pid: child.pid,
    instanceId,
    managementToken,
    configPath: paths.configPath,
    startedAt: new Date().toISOString(),
  });
  const health = await waitForHealth(config, { managementToken });
  if (!health.ok || health.body?.instanceId !== instanceId) {
    await stopManagedRouterChild(child);
    await removeRouterPid(paths);
    const output = await readProcessLogSince(processLog.path, processLog.offset);
    const detail = summarizeProcessOutput(output) || health.error || "Router process exited before becoming healthy.";
    const message = `Router failed to start: ${detail}`;
    const failedHealth = { ...health, error: message, processLogPath: processLog.path };
    await recordRouterStartFailure(config, message, processLog.path);
    await trayController.refreshStatus(failedHealth);
    return {
      started: false,
      via: "process",
      pid: child.pid,
      health: failedHealth,
      error: message,
    };
  }
  await trayController.refreshStatus(health);
  return { started: true, via: "process", pid: child.pid, health };
}

function trackManagedRouterChild(child, paths, instanceId) {
  managedRouterChild = child;

  const clearManagedChild = () => {
    if (managedRouterChild === child) {
      managedRouterChild = null;
    }
    void removeRouterPidForInstance(paths, instanceId);
  };

  child.once("exit", clearManagedChild);
  child.once("error", () => {
    if (!child.pid) {
      clearManagedChild();
    }
  });
}

async function removeRouterPidForInstance(paths, instanceId) {
  try {
    const metadata = JSON.parse(await fs.readFile(paths.pidPath, "utf8"));
    if (metadata.instanceId === instanceId) {
      await removeRouterPid(paths);
    }
  } catch {}
}

async function prepareProcessLog(paths) {
  const path = join(paths.dataDir, "logs", "router-process.log");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, `\n[${new Date().toISOString()}] Starting Router\n`, "utf8");
  const { size } = await fs.stat(path);
  return { path, offset: size };
}

async function readProcessLogSince(path, offset, maxBytes = 8192) {
  try {
    const handle = await fs.open(path, "r");
    try {
      const { size } = await handle.stat();
      const available = Math.max(0, size - offset);
      const length = Math.min(available, maxBytes);
      if (!length) {
        return "";
      }

      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8").trim();
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function waitForChildSpawn(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", rejectPromise);
  });
}

function summarizeProcessOutput(output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^Error(?:\s|\[|:)/.test(line)) || lines.at(-1) || "";
}

async function recordRouterStartFailure(config, message, processLogPath) {
  try {
    const logPath = await getLogPath(config);
    await fs.mkdir(dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      event: "router_start_failed",
      errorMessage: message,
      processLogPath,
    })}\n`, "utf8");
  } catch {
    // The startup result still carries the error when diagnostic logging fails.
  }
}

function stopRouter() {
  return enqueueRouterLifecycle(stopRouterInternal);
}

async function stopRouterInternal() {
  const paths = getPaths();
  const child = getRunningManagedRouterChild();
  if (child) {
    await stopManagedRouterChild(child);
    await removeRouterPid(paths);

    const health = await getHealth();
    await trayController.refreshStatus(health);
    return { stopped: true, health };
  }

  const metadata = await getManagedRouterMetadata(paths);

  if (!metadata) {
    const health = await getHealth(null, { includeProcessCount: false });
    if (health.ok) {
      throw new Error("The running Router is not managed by this app instance and cannot be stopped safely.");
    }
    return { stopped: true, health };
  }

  const { config } = await loadConfig();
  const managedHealth = await getHealth(config, { includeProcessCount: false, managementToken: metadata.managementToken });
  if (managedHealth.body?.instanceId !== metadata.instanceId) {
    throw new Error("Refusing to stop a process whose Router instance identity could not be verified.");
  }
  await terminateProcess(metadata.pid);

  await removeRouterPid(paths);

  const health = await getHealth();
  await trayController.refreshStatus(health);
  return { stopped: true, health };
}

function getRunningManagedRouterChild() {
  if (!managedRouterChild || managedRouterChild.exitCode !== null || managedRouterChild.signalCode !== null) {
    return null;
  }
  return managedRouterChild;
}

async function stopManagedRouterChild(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (child.connected) {
    try {
      child.send({ type: "shutdown" }, () => {});
    } catch {}
  }

  if (await waitForChildExit(child, timeoutMs)) {
    return;
  }

  child.kill("SIGKILL");
  if (!await waitForChildExit(child, timeoutMs)) {
    throw new Error("Router process did not exit after forced termination.");
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolvePromise) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
    return;
  }

  await waitForProcessExit(pid);
  if (await isProcessRunning(pid)) {
    process.kill(pid, "SIGKILL");
  }
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

function restartRouter() {
  return enqueueRouterLifecycle(async () => {
    await stopRouterInternal();
    return startRouterInternal();
  });
}

async function waitForHealth(config, options = {}) {
  for (let index = 0; index < 8; index += 1) {
    const health = await getHealth(config, { ...options, includeProcessCount: false });
    if (health.ok) {
      return health;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }

  return getHealth(config, options);
}

async function getHealth(configArg = null, options = {}) {
  const includeProcessCount = options.includeProcessCount !== false;
  const loaded = configArg ? { config: configArg, paths: getPaths() } : await loadConfig();
  const url = `${getRouterBaseUrl(loaded.config)}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  const headers = options.managementToken
    ? { "x-router-management-token": options.managementToken }
    : loaded.config.router.apiKey
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

    const processCount = !response.ok && includeProcessCount ? await countRouterProcesses(loaded.paths) : 0;
    return {
      ok: response.ok,
      status: response.status,
      url,
      body,
      text,
      processCount,
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
  return resolveLogPath(config, paths.dataDir);
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

async function openConfigFile() {
  const { paths } = await loadConfig();
  return shell.openPath(paths.configPath);
}

async function openLogFile() {
  const logPath = await getLogPath();
  await ensureLogFile(logPath);
  return shell.openPath(logPath);
}

async function getAppState() {
  const loaded = await loadConfig();
  return {
    ...loaded,
    health: await getHealth(loaded.config),
    appVersion: app.getVersion(),
  };
}

function hasHiddenStartArg(args = process.argv) {
  return args.some((arg) => HIDDEN_START_ARGS.has(String(arg).toLowerCase())) || process.env.LOCAL_MODEL_ROUTER_START_HIDDEN === "1";
}

async function installDownloadedUpdate() {
  const updateState = getUpdateState();
  if (updateState.mock || updateState.status !== "downloaded") {
    return installUpdate();
  }

  isQuitting = true;
  trayController.setBusy("Installing update...");

  try {
    await stopRouter();
  } catch (error) {
    trayController.showNotification("Local Model Router", `Failed to stop Router before update: ${error.message || String(error)}`);
    isQuitting = false;
    trayController.setBusy("");
    throw error;
  }

  try {
    return installUpdate();
  } catch (error) {
    isQuitting = false;
    trayController.setBusy("");
    throw error;
  }
}

function handleUpdateStateChanged() {
  trayController.updateMenu();
}

async function startRouterForBackgroundStartup() {
  try {
    const { config } = await loadConfig();
    if (!hasUsableVendor(config)) {
      trayController.setConfigurationIssue("No enabled vendors configured.");
      return;
    }

    const result = await startRouter();
    if (!result.health?.ok) {
      trayController.showNotification("Local Model Router startup issue", healthDetail(result.health));
    }
  } catch (error) {
    await trayController.refreshStatus().catch(() => null);
    trayController.showNotification("Local Model Router failed to start", error.message || String(error));
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
    trayController.showNotification("Local Model Router", `Failed to read close behavior: ${error.message || String(error)}`);
    requestWindowCloseConfirmation(window);
  }
}

async function quitApplication() {
  if (isQuitting) {
    return;
  }

  isQuitting = true;
  trayController.setBusy("Stopping Router...");

  try {
    await stopRouter();
  } catch (error) {
    trayController.showNotification("Local Model Router", `Failed to stop Router: ${error.message || String(error)}`);
  } finally {
    trayController.dispose();
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
  mainWindow.setMenu(null);

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

  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

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

function applyPackagedLoginStartup(enabled) {
  if (!app.isPackaged || process.platform !== "win32") {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled === true,
    path: process.execPath,
    args: ["--hidden"],
  });
}

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error(`Rejected IPC request from an untrusted sender: ${channel}`);
    }
    const parsedArgs = parseIpcRequest(channel, args);
    const response = await handler(event, ...parsedArgs);
    return parseIpcResponse(channel, response);
  });
}

const trayController = createTrayController({
  createAppIcon,
  downloadUpdate,
  getHealth,
  getUpdateState,
  installUpdate: installDownloadedUpdate,
  isQuitting: () => isQuitting,
  openLogFile,
  quitApplication,
  restartRouter,
  showSettingsWindow,
  startRouter,
  stopRouter,
});

configureRuntimeIdentity();
app.setAppUserModelId(APP_USER_MODEL_ID);

registerIpcHandler("app:getState", getAppState);
registerIpcHandler("app:rendererReady", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && !window.isDestroyed() && windowsToShowOnReady.has(window) && !window.isVisible()) {
    window.show();
    windowsToShowOnReady.delete(window);
  }
  return { ok: true };
});
registerIpcHandler("app:hideToTray", () => {
  closePromptActive = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  return { ok: true };
});
registerIpcHandler("app:cancelClose", () => {
  closePromptActive = false;
  return { ok: true };
});
registerIpcHandler("app:quitAndStop", async () => {
  closePromptActive = false;
  await quitApplication();
  return { ok: true };
});
registerIpcHandler("config:load", loadConfig);
registerIpcHandler("config:save", saveConfig);
registerIpcHandler("vendor:listModels", fetchVendorModels);
registerIpcHandler("router:start", startRouter);
registerIpcHandler("router:stop", stopRouter);
registerIpcHandler("router:restart", restartRouter);
registerIpcHandler("router:health", (_event, options) => getHealth(null, options));
registerIpcHandler("logs:read", readLogs);
registerIpcHandler("file:openConfig", openConfigFile);
registerIpcHandler("file:openLog", openLogFile);
registerIpcHandler("update:getState", getUpdateState);
registerIpcHandler("update:check", (_event, options) => checkForUpdates(options));
registerIpcHandler("update:download", downloadUpdate);
registerIpcHandler("update:install", installDownloadedUpdate);
registerIpcHandler("update:openReleasePage", openReleasePage);
registerIpcHandler("clipboard:writeText", (_event, text) => {
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
    try {
      const { config } = await loadConfig();
      applyPackagedLoginStartup(config.app.startAtLogin);
    } catch (error) {
      trayController.showNotification("Local Model Router", `Failed to load startup settings: ${error.message || String(error)}`);
    }
    initializeUpdater();
    onUpdateState(handleUpdateStateChanged);
    trayController.create();
    await trayController.refreshStatus().catch(() => null);
    void checkForUpdates().catch(() => null);

    if (hasHiddenStartArg()) {
      void startRouterForBackgroundStartup();
    } else {
      createWindow();
    }
  });

  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    isQuitting = true;
    trayController.dispose();
  });

  app.on("activate", () => {
    showSettingsWindow();
  });
}
