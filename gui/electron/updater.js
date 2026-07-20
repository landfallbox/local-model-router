import electron from "electron";
import electronUpdater from "electron-updater";

const { app, BrowserWindow, shell } = electron;
const RELEASES_URL = "https://github.com/landfallbox/local-model-router/releases/latest";
const mockUpdateMode = String(process.env.LOCAL_MODEL_ROUTER_MOCK_UPDATE || "").trim().toLowerCase();
const isMockUpdateEnabled = Boolean(!app?.isPackaged && mockUpdateMode);
const isRealUpdaterSupported = Boolean(app?.isPackaged && process.platform === "win32");
const isUpdaterSupported = isRealUpdaterSupported || isMockUpdateEnabled;
const mockUpdateVersion = String(process.env.LOCAL_MODEL_ROUTER_MOCK_UPDATE_VERSION || "0.3.0-dev-preview").trim();

let updateState = createInitialState();
let initialized = false;
let checkingPromise = null;
let downloadPromise = null;
let updater = null;
const stateListeners = new Set();

function getAutoUpdater() {
  if (!updater) {
    updater = electronUpdater.autoUpdater;
  }

  return updater;
}

function getCurrentVersion() {
  return typeof app?.getVersion === "function" ? app.getVersion() : "";
}

function createInitialState() {
  return {
    status: isUpdaterSupported ? "idle" : "unsupported",
    supported: isUpdaterSupported,
    mock: isMockUpdateEnabled,
    currentVersion: getCurrentVersion(),
    availableVersion: "",
    releaseName: "",
    releaseNotes: "",
    progress: null,
    error: "",
    lastCheckedAt: "",
  };
}

function normalizeUpdateInfo(info = {}) {
  return {
    availableVersion: String(info.version || ""),
    releaseName: String(info.releaseName || ""),
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  };
}

function normalizeReleaseNotes(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item?.note || item?.version || "").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  return String(value || "").trim();
}

function normalizeProgress(info = {}) {
  return {
    percent: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, info.percent)) : 0,
    bytesPerSecond: Number.isFinite(info.bytesPerSecond) ? info.bytesPerSecond : 0,
    transferred: Number.isFinite(info.transferred) ? info.transferred : 0,
    total: Number.isFinite(info.total) ? info.total : 0,
  };
}

function update(nextState) {
  updateState = {
    ...updateState,
    ...nextState,
    supported: isUpdaterSupported,
    mock: isMockUpdateEnabled,
    currentVersion: getCurrentVersion(),
  };
  broadcastUpdateState();
  return updateState;
}

function broadcastUpdateState() {
  if (typeof BrowserWindow?.getAllWindows === "function") {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("update:state", updateState);
      }
    }
  }

  for (const listener of stateListeners) {
    listener(updateState);
  }
}

export function onUpdateState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function initializeUpdater() {
  if (initialized) {
    return updateState;
  }

  initialized = true;
  if (!isRealUpdaterSupported) {
    return updateState;
  }

  const autoUpdater = getAutoUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => {
    update({ status: "checking", error: "", progress: null });
  });

  autoUpdater.on("update-available", (info) => {
    update({
      status: "available",
      ...normalizeUpdateInfo(info),
      progress: null,
      error: "",
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    update({
      status: "not-available",
      ...normalizeUpdateInfo(info),
      availableVersion: "",
      progress: null,
      error: "",
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on("download-progress", (info) => {
    update({ status: "downloading", progress: normalizeProgress(info), error: "" });
  });

  autoUpdater.on("update-downloaded", (event) => {
    update({
      status: "downloaded",
      ...normalizeUpdateInfo(event),
      progress: normalizeProgress({ percent: 100, transferred: event?.downloadedFile ? 1 : 0, total: event?.downloadedFile ? 1 : 0 }),
      error: "",
    });
  });

  autoUpdater.on("error", (error) => {
    update({
      status: "error",
      error: error?.message || String(error),
      progress: null,
    });
  });

  return updateState;
}

export function getUpdateState() {
  return updateState;
}

export async function checkForUpdates({ manual = false } = {}) {
  initializeUpdater();

  if (isMockUpdateEnabled) {
    return checkForMockUpdate();
  }

  if (!isUpdaterSupported) {
    return update({
      status: "unsupported",
      error: manual ? "Updates are available only in packaged Windows builds." : "",
      progress: null,
    });
  }

  if (checkingPromise) {
    return checkingPromise;
  }

  checkingPromise = getAutoUpdater().checkForUpdates()
    .then(() => updateState)
    .catch((error) => {
      update({
        status: "error",
        error: error?.message || String(error),
        progress: null,
      });
      if (manual) {
        throw error;
      }
      return updateState;
    })
    .finally(() => {
      checkingPromise = null;
    });

  return checkingPromise;
}

export async function downloadUpdate() {
  initializeUpdater();

  if (isMockUpdateEnabled) {
    return downloadMockUpdate();
  }

  if (!isUpdaterSupported) {
    return update({
      status: "unsupported",
      error: "Updates are available only in packaged Windows builds.",
      progress: null,
    });
  }

  if (updateState.status === "downloaded") {
    return updateState;
  }

  if (!updateState.availableVersion) {
    await checkForUpdates({ manual: true });
    if (!updateState.availableVersion) {
      return updateState;
    }
  }

  if (downloadPromise) {
    return downloadPromise;
  }

  update({ status: "downloading", error: "", progress: normalizeProgress() });
  downloadPromise = getAutoUpdater().downloadUpdate()
    .then(() => updateState)
    .catch((error) => {
      update({
        status: "error",
        error: error?.message || String(error),
        progress: null,
      });
      throw error;
    })
    .finally(() => {
      downloadPromise = null;
    });

  return downloadPromise;
}

export function installUpdate() {
  initializeUpdater();

  if (isMockUpdateEnabled) {
    if (updateState.status !== "downloaded") {
      return update({ status: "error", error: "Download the mock update before installing it.", progress: null });
    }

    return update({ status: "installed", error: "", progress: null });
  }

  if (!isUpdaterSupported) {
    return update({
      status: "unsupported",
      error: "Updates are available only in packaged Windows builds.",
      progress: null,
    });
  }

  if (updateState.status !== "downloaded") {
    return update({
      status: "error",
      error: "Download the update before installing it.",
      progress: null,
    });
  }

  getAutoUpdater().quitAndInstall(false, true);
  return updateState;
}

async function checkForMockUpdate() {
  update({ status: "checking", error: "", progress: null });
  await delay(350);

  if (mockUpdateMode === "error") {
    return update({
      status: "error",
      availableVersion: "",
      error: "Mock update check failed.",
      lastCheckedAt: new Date().toISOString(),
    });
  }

  if (["none", "not-available", "up-to-date"].includes(mockUpdateMode)) {
    return update({
      status: "not-available",
      availableVersion: "",
      releaseName: "",
      releaseNotes: "",
      error: "",
      lastCheckedAt: new Date().toISOString(),
    });
  }

  const status = mockUpdateMode === "downloaded" ? "downloaded" : "available";
  return update({
    status,
    availableVersion: mockUpdateVersion,
    releaseName: `Local Model Router ${mockUpdateVersion}`,
    releaseNotes: "Development-only update preview.",
    progress: status === "downloaded" ? normalizeProgress({ percent: 100, transferred: 104857600, total: 104857600 }) : null,
    error: "",
    lastCheckedAt: new Date().toISOString(),
  });
}

async function downloadMockUpdate() {
  if (downloadPromise) {
    return downloadPromise;
  }

  if (!updateState.availableVersion) {
    await checkForMockUpdate();
  }
  if (!["available", "error"].includes(updateState.status)) {
    return updateState;
  }

  const total = 104857600;
  downloadPromise = (async () => {
    for (const percent of [8, 24, 47, 73, 91, 100]) {
      if (mockUpdateMode === "download-error" && percent === 73) {
        return update({
          status: "error",
          progress: null,
          error: "Mock update download failed.",
        });
      }

      update({
        status: percent === 100 ? "downloaded" : "downloading",
        progress: normalizeProgress({
          percent,
          bytesPerSecond: 12582912,
          transferred: Math.round(total * percent / 100),
          total,
        }),
        error: "",
      });
      await delay(percent === 100 ? 0 : 280);
    }
    return updateState;
  })().finally(() => {
    downloadPromise = null;
  });

  return downloadPromise;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function openReleasePage() {
  if (typeof shell?.openExternal !== "function") {
    return { ok: false };
  }

  await shell.openExternal(RELEASES_URL);
  return { ok: true };
}
