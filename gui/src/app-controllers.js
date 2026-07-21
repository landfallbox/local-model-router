import { useEffect, useState } from "react";
import { getDesktopApi } from "./desktop-api.js";

const defaultUpdateState = {
  status: "unsupported",
  supported: false,
  currentVersion: "",
  availableVersion: "",
  releaseName: "",
  releaseNotes: "",
  progress: null,
  error: "",
  lastCheckedAt: "",
};

export function useLogsController({ busy, run }) {
  const [logs, setLogs] = useState({ path: "", lines: [], nextBefore: null, hasMore: false });

  async function refreshLogs() {
    const result = await getDesktopApi().readLogs({ limit: 80 });
    setLogs(result);
  }

  async function loadOlderLogs() {
    if (!logs.hasMore || busy === "olderLogs") {
      return;
    }

    await run("olderLogs", async () => {
      const result = await getDesktopApi().readLogs({ limit: 80, before: logs.nextBefore });
      setLogs((current) => ({
        path: result.path || current.path,
        lines: [...result.lines, ...current.lines],
        nextBefore: result.nextBefore,
        hasMore: result.hasMore,
      }));
    });
  }

  return { logs, refreshLogs, loadOlderLogs };
}

export function useUpdateController({ run, setToast }) {
  const [updateState, setUpdateState] = useState(defaultUpdateState);

  useEffect(() => {
    const api = getDesktopApi();
    void api.getUpdateState?.().then((state) => {
      if (state) {
        setUpdateState(state);
      }
    }).catch(() => null);

    const unsubscribe = api.onUpdateState?.((state) => {
      if (state) {
        setUpdateState(state);
      }
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, []);

  async function downloadAppUpdate() {
    await run("updateDownload", async () => {
      const state = await getDesktopApi().downloadUpdate();
      setUpdateState(state);
      setToast(updateToastForState(state, "Update download started."));
    });
  }

  async function installAppUpdate() {
    await run("updateInstall", async () => {
      const state = await getDesktopApi().installUpdate();
      setUpdateState(state);
      setToast(updateToastForState(state, "Installing update."));
    });
  }

  return { updateState, downloadAppUpdate, installAppUpdate };
}

function updateToastForState(updateState, fallback) {
  if (!updateState) {
    return fallback;
  }
  if (!updateState.supported) {
    return updateState.error || "Updates are available only in packaged Windows builds.";
  }
  if (updateState.status === "available") {
    return `Version ${updateState.availableVersion} is available.`;
  }
  if (updateState.status === "downloaded") {
    return "Update downloaded. Restart to update.";
  }
  if (updateState.status === "installed") {
    return "Mock update install completed.";
  }
  if (updateState.status === "not-available") {
    return "You are up to date.";
  }
  if (updateState.status === "error") {
    return updateState.error || "Update failed.";
  }
  return fallback;
}