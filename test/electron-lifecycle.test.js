import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const projectRoot = resolve(".");
const testRoot = mkdtempSync(join(tmpdir(), "local-model-router-electron-"));
const routerDataDir = join(testRoot, "router-data");
const userDataDir = join(testRoot, "electron-user-data");
const configPath = join(testRoot, "config.json");
const pidPath = join(routerDataDir, "router.pid");
let electronApp;
let routerPid;

function createConfig(port) {
  return {
    app: {
      closeBehavior: "tray",
      startAtLogin: false,
    },
    router: {
      host: "127.0.0.1",
      port,
      apiKey: "electron-lifecycle-token",
      requestTimeoutMs: 30000,
      maxBodyBytes: 52428800,
      fallbackStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
      logFile: "logs/router.log",
    },
    model: {
      id: "model-id",
      name: "Model Name",
      ownedBy: "local-router",
      maxInputTokens: 200000,
      maxOutputTokens: 64000,
    },
    vendors: [{
      name: "test-vendor",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "model-id", enabled: true }],
      authentication: "none",
      apiKey: "",
      enabled: true,
    }],
  };
}

async function findFreePort() {
  const server = http.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(message);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readRouterPid() {
  try {
    return JSON.parse(readFileSync(pidPath, "utf8")).pid;
  } catch {
    return null;
  }
}

async function runTest() {
  const port = await findFreePort();
  writeFileSync(configPath, JSON.stringify(createConfig(port), null, 2));

  electronApp = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      LOCAL_MODEL_ROUTER_APP_DIR: projectRoot,
      LOCAL_MODEL_ROUTER_DATA_DIR: routerDataDir,
      LOCAL_MODEL_ROUTER_DEV_MODE: "1",
      LOCAL_MODEL_ROUTER_NODE: process.execPath,
      LOCAL_MODEL_ROUTER_USER_DATA_DIR: userDataDir,
      ROUTER_CONFIG: configPath,
    },
  });

  const window = await electronApp.firstWindow();
  await window.waitForFunction(() => Boolean(window.localModelRouter));

  const startResult = await window.evaluate(() => window.localModelRouter.startRouter());
  assert.equal(startResult.started, true);
  assert.equal(startResult.health?.ok, true);

  await waitFor(async () => {
    routerPid = await readRouterPid();
    return isProcessRunning(routerPid);
  }, "Electron did not start a managed Router process.");

  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitFor(
    () => electronApp.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()),
    "Closing the window did not hide it to the tray.",
  );
  assert.equal(isProcessRunning(routerPid), true, "Router stopped when the window was only hidden to the tray.");

  const appClosed = electronApp.waitForEvent("close");
  await window.evaluate(() => window.localModelRouter.quitAndStop()).catch(() => null);
  await appClosed;
  electronApp = null;

  await waitFor(
    () => !isProcessRunning(routerPid),
    "Router remained alive after Electron explicitly exited.",
  );
}

try {
  await runTest();
  console.log("electron lifecycle tests passed");
} finally {
  if (electronApp) {
    await electronApp.close().catch(() => null);
  }
  if (isProcessRunning(routerPid)) {
    process.kill(routerPid, "SIGKILL");
  }
  rmSync(testRoot, { recursive: true, force: true });
}