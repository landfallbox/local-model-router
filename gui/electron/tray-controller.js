import { Menu, nativeImage, Notification, Tray } from "electron";

const REFRESH_INTERVAL_MS = 15000;

export function createTrayController({
  createAppIcon,
  downloadUpdate,
  getHealth,
  getUpdateState,
  installUpdate,
  isQuitting,
  openLogFile,
  quitApplication,
  restartRouter,
  showSettingsWindow,
  startRouter,
  stopRouter,
}) {
  let tray = null;
  let refreshTimer = null;
  let busyAction = "";
  let status = { label: "Checking", detail: "", isRouterActive: false };

  function showNotification(title, body) {
    if (Notification.isSupported()) {
      new Notification({ title, body: String(body || "") }).show();
    }
  }

  function updateMenu() {
    if (!tray) {
      return;
    }

    const updateState = getUpdateState();
    const items = [
      { label: `Current status: ${status.label}`, enabled: false },
      { type: "separator" },
      { label: "Open Settings", click: showSettingsWindow },
      { label: "Open Logs", click: () => void openLogFile().catch((error) => showNotification("Local Model Router", error.message || String(error))) },
    ];

    if (busyAction) {
      items.push({ label: busyAction, enabled: false });
    } else if (status.isRouterActive) {
      items.push(
        { label: "Stop Router", click: () => void runRouterAction("Stopping Router...", stopRouter, "Local Model Router failed to stop") },
        { label: "Restart Router", click: () => void runRouterAction("Restarting Router...", restartRouter, "Local Model Router failed to restart", "Local Model Router restart issue") },
      );
    } else {
      items.push({ label: "Start Router", click: () => void runRouterAction("Starting Router...", startRouter, "Local Model Router failed to start", "Local Model Router startup issue") });
    }

    if (["available", "downloading", "downloaded"].includes(updateState.status)) {
      items.push({ type: "separator" });
      if (updateState.status === "available") {
        items.push({ label: `Download update ${updateState.availableVersion}`, click: () => void runUpdateDownload() });
      } else if (updateState.status === "downloading") {
        const percent = Number(updateState.progress?.percent || 0).toFixed(0);
        items.push({ label: `Downloading update ${percent}%`, enabled: false });
      } else {
        items.push({ label: `Install update ${updateState.availableVersion}`, click: () => void runUpdateInstall() });
      }
    }

    items.push(
      { type: "separator" },
      { label: "Exit", click: () => void quitApplication() },
    );

    const routerState = status.isRouterActive ? "Running" : "Stopped";
    tray.setToolTip(`local_model_router: ${routerState}${status.detail ? `\n${status.detail}` : ""}`);
    tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  function create() {
    if (tray) {
      return tray;
    }

    tray = new Tray(createAppIcon() || createFallbackIcon());
    tray.on("double-click", showSettingsWindow);
    updateMenu();

    refreshTimer = setInterval(() => {
      void refreshStatus(null, { notifyOnUnexpectedStop: true });
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
    return tray;
  }

  function setConfigurationIssue(detail) {
    status = { label: "Stopped", detail, isRouterActive: false };
    updateMenu();
  }

  async function refreshStatus(health = null, { notifyOnUnexpectedStop = false } = {}) {
    if (!tray) {
      return health;
    }

    const nextHealth = health || await getHealth();
    const nextStatus = statusFromHealth(nextHealth);
    if (notifyOnUnexpectedStop && status.isRouterActive && !nextStatus.isRouterActive && !isQuitting()) {
      showNotification("Local Model Router stopped", nextStatus.detail || "The router process is no longer running.");
    }

    status = nextStatus;
    updateMenu();
    return nextHealth;
  }

  async function runRouterAction(label, action, errorTitle, unhealthyTitle = "") {
    setBusy(label);
    try {
      const result = await action();
      if (unhealthyTitle && !result?.health?.ok) {
        showNotification(unhealthyTitle, healthDetail(result?.health));
      }
    } catch (error) {
      showNotification(errorTitle, error.message || String(error));
    } finally {
      setBusy("");
    }
  }

  async function runUpdateDownload() {
    setBusy("Downloading update...");
    try {
      await downloadUpdate();
    } catch {
    } finally {
      setBusy("");
    }
  }

  async function runUpdateInstall() {
    try {
      await installUpdate();
    } catch (error) {
      showNotification("Local Model Router update failed", error.message || String(error));
    }
  }

  function setBusy(label) {
    busyAction = label;
    updateMenu();
  }

  function dispose() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  return {
    create,
    dispose,
    refreshStatus,
    setBusy,
    setConfigurationIssue,
    showNotification,
    updateMenu,
  };
}

export function healthDetail(health) {
  if (!health) {
    return "No health result is available.";
  }

  return health.error || health.text || health.body?.model || health.url || "Router did not report healthy.";
}

function statusFromHealth(health) {
  if (!health) {
    return { label: "Checking", detail: "", isRouterActive: false };
  }
  if (health.ok) {
    return { label: "Running", detail: "", isRouterActive: true };
  }
  if (Number(health.processCount || 0) > 0) {
    return { label: "Process found", detail: health.error || "Health check failed.", isRouterActive: true };
  }
  return { label: "Stopped", detail: health.error || "", isRouterActive: false };
}

function createFallbackIcon() {
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