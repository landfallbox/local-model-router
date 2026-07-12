import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Eye,
  EyeOff,
  FileCog,
  FileText,
  KeyRound,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  XCircle,
  X,
} from "lucide-react";

function getDesktopApi() {
  if (!window.localModelRouter) {
    throw new Error("Desktop API is unavailable. Close this window and reopen the app with npm run gui or dist\\LocalModelRouter\\gui.ps1.");
  }

  return window.localModelRouter;
}

const defaultDraft = {
  router: {
    host: "127.0.0.1",
    port: "4000",
    apiKey: "",
    requestTimeoutMs: "30000",
    maxBodyMb: "50",
    fallbackStatusCodesText: "408, 409, 425, 429, 500, 502, 503, 504",
    logFile: "logs/router.log",
  },
  model: {
    id: "model-id",
    name: "Model Name",
    ownedBy: "local-router",
    maxInputTokens: "200000",
    maxOutputTokens: "64000",
  },
  vendors: [],
};

const navItems = [
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "logs", label: "Logs", icon: Terminal },
];

function toDraft(config) {
  const router = config.router || {};
  const model = config.model || {};

  return {
    router: {
      host: router.host || "127.0.0.1",
      port: String(router.port ?? 4000),
      apiKey: router.apiKey || "",
      requestTimeoutMs: String(router.requestTimeoutMs ?? 30000),
      maxBodyMb: String(Math.max(1, Math.round(Number(router.maxBodyBytes || 52428800) / 1048576))),
      fallbackStatusCodesText: Array.isArray(router.fallbackStatusCodes)
        ? router.fallbackStatusCodes.join(", ")
        : defaultDraft.router.fallbackStatusCodesText,
      logFile: router.logFile || "logs/router.log",
    },
    model: {
      id: model.id || "model-id",
      name: model.name || "Model Name",
      ownedBy: model.ownedBy || "local-router",
      maxInputTokens: String(model.maxInputTokens ?? 200000),
      maxOutputTokens: String(model.maxOutputTokens ?? 64000),
    },
    vendors: Array.isArray(config.vendors)
      ? config.vendors.map((vendor) => ({
          ...vendor,
          authentication: vendor.authentication === "api-key" || vendor.apiKey ? "api-key" : "none",
        }))
      : [],
  };
}

function parseStatusCodes(value) {
  const codes = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const code = Number(item);
      if (!Number.isInteger(code) || code < 100 || code > 599) {
        throw new Error(`Invalid fallback status code: ${item}`);
      }
      return code;
    });

  if (!codes.length) {
    throw new Error("At least one fallback status code is required.");
  }

  const uniqueCodes = [...new Set(codes)];
  if (uniqueCodes.length !== codes.length) {
    throw new Error("Fallback status codes must be unique.");
  }

  return uniqueCodes;
}

function toConfig(draft) {
  return {
    router: {
      host: draft.router.host.trim() || "127.0.0.1",
      port: numberValue(draft.router.port, 4000),
      apiKey: draft.router.apiKey,
      requestTimeoutMs: numberValue(draft.router.requestTimeoutMs, 30000),
      maxBodyBytes: numberValue(draft.router.maxBodyMb, 50) * 1048576,
      fallbackStatusCodes: parseStatusCodes(draft.router.fallbackStatusCodesText),
      logFile: draft.router.logFile.trim() || "logs/router.log",
    },
    model: {
      id: draft.model.id.trim() || "model-id",
      name: draft.model.name.trim() || "Model Name",
      ownedBy: draft.model.ownedBy.trim() || "local-router",
      maxInputTokens: numberValue(draft.model.maxInputTokens, 200000),
      maxOutputTokens: numberValue(draft.model.maxOutputTokens, 64000),
    },
    vendors: draft.vendors.map((vendor) => {
      const normalized = {
        ...vendor,
        name: String(vendor.name || "").trim(),
        baseUrl: String(vendor.baseUrl || "").trim(),
        model: String(vendor.model || "").trim(),
        authentication: vendor.authentication === "api-key" ? "api-key" : "none",
        enabled: vendor.enabled !== false,
      };
      delete normalized.timeoutMs;
      delete normalized.apiKeyEnv;
      delete normalized.headers;
      if (normalized.authentication === "none") {
        delete normalized.apiKey;
      }
      return normalized;
    }),
  };
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validateInteger(value, label, { min, max }) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!text || !Number.isInteger(number)) {
    return `${label} must be a whole number.`;
  }
  if (number < min || number > max) {
    return `${label} must be between ${min} and ${max}.`;
  }
  return "";
}

function validateRouter(router) {
  const errors = [];
  const fields = {};

  function addError(field, message) {
    fields[field] = { tone: "error", message };
    errors.push(message);
  }

  const portError = validateInteger(router.port, "Port", { min: 1, max: 65535 });
  if (portError) {
    addError("port", portError);
  }

  const timeoutError = validateInteger(router.requestTimeoutMs, "Request timeout", { min: 100, max: 600000 });
  if (timeoutError) {
    addError("requestTimeoutMs", timeoutError);
  }

  return { errors, fields, hasErrors: errors.length > 0, firstError: errors[0] || "" };
}

function endpointFromDraft(draft) {
  const host = draft.router.host.trim() || "127.0.0.1";
  const port = numberValue(draft.router.port, 4000);
  return `http://${host}:${port}/v1/chat/completions`;
}

function getKeyStatus(vendor) {
  if (vendor.authentication !== "api-key") {
    return { label: "No authentication", tone: "neutral" };
  }
  if (vendor.apiKey) {
    return { label: "Key configured", tone: "success" };
  }
  return { label: "Missing key", tone: "warning" };
}

function validateVendor(vendor) {
  const errors = [];
  const warnings = [];
  const fields = {};
  const name = String(vendor?.name || "").trim();
  const baseUrl = String(vendor?.baseUrl || "").trim();
  const model = String(vendor?.model || "").trim();
  const authentication = vendor?.authentication === "api-key" ? "api-key" : "none";

  if (!name) {
    fields.name = { tone: "error", message: "Name is required." };
    errors.push("Name required");
  }

  if (!baseUrl) {
    fields.baseUrl = { tone: "error", message: "Base URL is required." };
    errors.push("Base URL required");
  } else {
    try {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Unsupported protocol");
      }
    } catch {
      fields.baseUrl = { tone: "error", message: "Enter a valid HTTP or HTTPS URL." };
      errors.push("Invalid Base URL");
    }
  }

  if (!model) {
    fields.model = { tone: "warning", message: "The global model will be used." };
    warnings.push("Missing model");
  }

  if (authentication === "api-key" && !vendor?.apiKey) {
    fields.apiKey = { tone: "error", message: "Enter the API key required by this vendor." };
    errors.push("Missing key");
  }

  return { errors, warnings, fields, hasErrors: errors.length > 0 };
}

function cloneVendor(vendor) {
  return vendor ? JSON.parse(JSON.stringify(vendor)) : null;
}

function parseLogRows(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const entry = JSON.parse(line);
        const level = String(entry.level || "info").toLowerCase();
        return {
          id: `${index}-${entry.time || ""}-${entry.event || ""}`,
          raw: line,
          time: entry.time || "",
          level,
          tone: level === "error" ? "danger" : level === "warn" ? "warning" : "success",
          event: entry.event || "log_event",
          vendor: entry.vendor || "",
          statusCode: entry.statusCode,
          elapsedMs: entry.elapsedMs,
          totalElapsedMs: entry.totalElapsedMs,
          model: entry.model || "",
          requestId: entry.requestId || "",
          message: entry.errorMessage || "",
        };
      } catch {
        return {
          id: `raw-${index}`,
          raw: line,
          time: "",
          level: "text",
          tone: "neutral",
          event: "log_line",
          message: line,
        };
      }
    })
    .reverse();
}

function formatLogTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

export default function App() {
  const [page, setPage] = useState("settings");
  const [draft, setDraft] = useState(defaultDraft);
  const [persistedDraft, setPersistedDraft] = useState(defaultDraft);
  const [health, setHealth] = useState(null);
  const [logs, setLogs] = useState({ path: "", lines: [], nextBefore: null, hasMore: false });
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [showRouterKey, setShowRouterKey] = useState(false);
  const [modal, setModal] = useState(null);
  const [vendorEditorIndex, setVendorEditorIndex] = useState(null);
  const [vendorEditorDraft, setVendorEditorDraft] = useState(null);
  const [vendorEditorOriginal, setVendorEditorOriginal] = useState(null);
  const [vendorEditorIsNew, setVendorEditorIsNew] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  const endpoint = useMemo(() => endpointFromDraft(draft), [draft]);
  const status = useMemo(() => getStatus(health), [health]);
  const routerValidation = useMemo(() => validateRouter(draft.router), [draft.router]);
  const routerActive = health?.ok || Number(health?.processCount || 0) > 0;

  useEffect(() => {
    void loadState();
  }, []);

  useEffect(() => {
    const unsubscribe = getDesktopApi().onOpenSettings?.(() => {
      closeVendorEditor();
      setPage("settings");
      void refreshHealth({ silent: true });
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, []);

  useEffect(() => {
    const unsubscribe = getDesktopApi().onConfirmClose?.(() => {
      setModal({ type: "close" });
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, []);

  useEffect(() => {
    if (page === "logs") {
      void run("logs", refreshLogs);
    }
  }, [page]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function loadState() {
    let configLoaded = false;
    setBusy("load");
    try {
      const state = await getDesktopApi().loadConfig();
      const loadedDraft = toDraft(state.config);
      setDraft(loadedDraft);
      setPersistedDraft(loadedDraft);
      configLoaded = true;
    } catch (error) {
      setToast(error.message || String(error));
    } finally {
      setBusy("");
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          void getDesktopApi().rendererReady();
        });
      });
    }

    if (configLoaded) {
      void refreshHealth({ silent: true, fast: true });
    }
  }

  async function startRouter() {
    await run("start", async () => {
      const result = await getDesktopApi().startRouter();
      setHealth(result.health);
      setRestartRequired(false);
      setToast("Router started.");
      if (page === "logs") {
        await refreshLogs();
      }
    });
  }

  async function stopRouter() {
    await run("stop", async () => {
      const result = await getDesktopApi().stopRouter();
      setHealth(result.health);
      setRestartRequired(false);
      setToast("Router stopped.");
      if (page === "logs") {
        await refreshLogs();
      }
    });
  }

  async function toggleRouter() {
    if (routerActive) {
      await stopRouter();
    } else {
      await startRouter();
    }
  }

  async function restartRouter() {
    await run("restart", async () => {
      const result = await getDesktopApi().restartRouter();
      setHealth(result.health);
      setRestartRequired(false);
      setToast("Router restarted.");
      if (page === "logs") {
        await refreshLogs();
      }
    });
  }

  async function refreshHealth({ silent = false, fast = false } = {}) {
    try {
      const nextHealth = await getDesktopApi().checkHealth({ includeProcessCount: !fast });
      setHealth(nextHealth);
      if (!silent) {
        setToast(nextHealth.ok ? "Health check passed." : "Health check failed.");
      }
      return nextHealth;
    } catch (error) {
      if (!silent) {
        setToast(error.message || String(error));
      }
      return null;
    }
  }

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
        lines: [...current.lines, ...result.lines],
        nextBefore: result.nextBefore,
        hasMore: result.hasMore,
      }));
    });
  }

  async function writeConfig(nextDraft) {
    const result = await getDesktopApi().saveConfig(toConfig(nextDraft));
    const savedDraft = toDraft(result.config);
    setPersistedDraft(savedDraft);
    if (routerActive) {
      setRestartRequired(true);
    }
    return savedDraft;
  }

  async function saveRouter() {
    if (routerValidation.hasErrors) {
      setToast(routerValidation.firstError);
      return;
    }

    await run("saveRouter", async () => {
      const savedDraft = await writeConfig({
        ...persistedDraft,
        router: { ...draft.router },
      });
      setDraft((current) => ({
        ...current,
        router: savedDraft.router,
      }));
      setToast(routerActive ? "Router settings saved. Restart Router to apply changes." : "Router settings saved.");
    });
  }

  async function persistVendorList(vendors, message) {
    try {
      const savedDraft = await writeConfig({ ...persistedDraft, vendors });
      setDraft((current) => ({ ...current, vendors: savedDraft.vendors }));
      setToast(message);
    } catch (error) {
      setDraft((current) => ({ ...current, vendors: persistedDraft.vendors }));
      throw error;
    }
  }

  async function copyEndpoint() {
    await getDesktopApi().writeClipboard(endpoint);
    setToast("Endpoint copied.");
  }

  async function run(name, action) {
    setBusy(name);
    try {
      await action();
    } catch (error) {
      setToast(error.message || String(error));
    } finally {
      setBusy("");
    }
  }

  function updateRouter(field, value) {
    setDraft((current) => ({
      ...current,
      router: { ...current.router, [field]: value },
    }));
  }

  function updateVendor(index, field, value) {
    const nextVendor = { ...draft.vendors[index], [field]: value };
    if (field === "enabled" && value && validateVendor(nextVendor).hasErrors) {
      setToast("Fix the red Vendor errors before enabling it.");
      return;
    }

    const vendors = draft.vendors.map((vendor, vendorIndex) => (vendorIndex === index ? nextVendor : vendor));
    setDraft((current) => ({ ...current, vendors }));
    void run("vendors", () => persistVendorList(vendors, "Vendor status saved."));
  }

  function addVendor() {
    const vendor = {
      name: "new-vendor",
      baseUrl: "https://example.com/v1",
      model: draft.model.id || "model-id",
      authentication: "none",
      enabled: false,
    };

    setVendorEditorIndex(draft.vendors.length);
    setVendorEditorDraft(cloneVendor(vendor));
    setVendorEditorOriginal(cloneVendor(vendor));
    setVendorEditorIsNew(true);
    setPage("vendor-edit");
  }

  function removeVendor(index) {
    const vendorName = draft.vendors[index]?.name || "this vendor";
    setModal({ type: "delete", index, name: vendorName });
  }

  function confirmRemoveVendor() {
    const index = modal.index;
    const vendors = draft.vendors.filter((_vendor, vendorIndex) => vendorIndex !== index);
    setDraft((current) => ({ ...current, vendors }));
    setModal(null);
    void run("vendors", () => persistVendorList(vendors, "Vendor deleted."));
  }

  function moveVendor(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draft.vendors.length) {
      return;
    }

    const vendors = [...draft.vendors];
    const [vendor] = vendors.splice(index, 1);
    vendors.splice(nextIndex, 0, vendor);
    setDraft((current) => ({ ...current, vendors }));
    void run("vendors", () => persistVendorList(vendors, "Vendor priority saved."));
  }

  function openVendorEditor(index) {
    const vendor = cloneVendor(draft.vendors[index]);
    if (validateVendor(vendor).hasErrors) {
      vendor.enabled = false;
    }
    setVendorEditorIndex(index);
    setVendorEditorDraft(vendor);
    setVendorEditorOriginal(cloneVendor(vendor));
    setVendorEditorIsNew(false);
    setPage("vendor-edit");
  }

  function closeVendorEditor() {
    setVendorEditorIndex(null);
    setVendorEditorDraft(null);
    setVendorEditorOriginal(null);
    setVendorEditorIsNew(false);
    setPage("settings");
  }

  function updateVendorEditor(field, value) {
    setVendorEditorDraft((current) => {
      const next = { ...current, [field]: value };
      if (validateVendor(next).hasErrors) {
        next.enabled = false;
      }
      return next;
    });
  }

  async function saveVendorEditor() {
    await run("save", async () => {
      const savedVendor = cloneVendor(vendorEditorDraft);
      const validation = validateVendor(savedVendor);
      if (validation.hasErrors) {
        savedVendor.enabled = false;
      }
      const savedIndex = vendorEditorIsNew ? persistedDraft.vendors.length : vendorEditorIndex;
      const nextDraft = {
        ...persistedDraft,
        vendors: vendorEditorIsNew
          ? [...persistedDraft.vendors, savedVendor]
          : persistedDraft.vendors.map((vendor, index) => (index === vendorEditorIndex ? savedVendor : vendor)),
      };
      const savedDraft = await writeConfig(nextDraft);
      const persistedVendor = cloneVendor(savedDraft.vendors[savedIndex]);

      setDraft((current) => ({ ...current, vendors: savedDraft.vendors }));
      setVendorEditorIndex(savedIndex);
      setVendorEditorDraft(persistedVendor);
      setVendorEditorOriginal(cloneVendor(persistedVendor));
      setVendorEditorIsNew(false);
      setToast(validation.hasErrors ? "Vendor saved as Disabled because it has errors." : "Vendor saved to config.json.");
    });
  }

  function revertVendorEditor() {
    setVendorEditorDraft(cloneVendor(vendorEditorOriginal));
    setToast("Vendor changes reverted.");
  }

  function openKeyModal() {
    setModal({
      type: "key",
      value: vendorEditorDraft?.apiKey || "",
      show: false,
    });
  }

  function saveKeyModal(clear = false) {
    updateVendorEditor("apiKey", clear ? "" : modal.value);
    setModal(null);
  }

  async function hideWindowToTray() {
    setModal(null);
    await getDesktopApi().hideToTray();
  }

  async function cancelWindowClose() {
    setModal(null);
    await getDesktopApi().cancelClose();
  }

  async function quitAndStopRouter() {
    setModal(null);
    await getDesktopApi().quitAndStop();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <ShieldCheck size={20} />
          </div>
          <div>
            <div className="brand-title">Local Model Router</div>
            <div className="brand-subtitle">Desktop Control</div>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            const activePage = page === "vendor-edit" ? "settings" : page;
            return (
              <button
                key={item.id}
                className={`nav-item ${activePage === item.id ? "active" : ""}`}
                type="button"
                onClick={() => {
                  closeVendorEditor();
                  setPage(item.id);
                }}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-control">
          <div className="sidebar-status">
            <div className={`status-dot ${status.tone}`} />
            <span>{status.label}</span>
          </div>
          {restartRequired && <div className="sidebar-hint">Restart Router to apply saved changes.</div>}
          <div className="dock-actions">
            <DockButton
              icon={routerActive ? Square : Play}
              label={routerActive ? "Stop router" : "Start router"}
              busy={busy === "start" || busy === "stop"}
              onClick={toggleRouter}
              variant="primary"
            />
            {restartRequired && routerActive && (
              <DockButton
                icon={RotateCcw}
                label="Restart router"
                busy={busy === "restart"}
                onClick={restartRouter}
              />
            )}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">{eyebrowForPage(page)}</div>
            <h1>{titleForPage(page, vendorEditorDraft)}</h1>
          </div>
        </header>

        <section className="endpoint-strip">
          <div>
            <span>Copilot endpoint</span>
            <strong>{endpoint}</strong>
          </div>
          <button type="button" className="icon-command" onClick={copyEndpoint} title="Copy endpoint">
            <Clipboard size={18} />
          </button>
        </section>

        <section className="content">
          {page === "settings" && (
            <div className="settings-stack">
              <RouterPage
                draft={draft}
                updateRouter={updateRouter}
                showRouterKey={showRouterKey}
                setShowRouterKey={setShowRouterKey}
                saveRouter={saveRouter}
                busy={busy}
                validation={routerValidation}
              />
              <VendorsPage
                vendors={draft.vendors}
                updateVendor={updateVendor}
                addVendor={addVendor}
                removeVendor={removeVendor}
                moveVendor={moveVendor}
                openVendorEditor={openVendorEditor}
                busy={busy === "vendors"}
              />
            </div>
          )}
          {page === "vendor-edit" && (
            <VendorEditorPage
              vendor={vendorEditorDraft}
              updateVendor={updateVendorEditor}
              openKeyModal={openKeyModal}
              saveVendor={saveVendorEditor}
              revertVendor={revertVendorEditor}
              busy={busy}
              onBack={closeVendorEditor}
            />
          )}
          {page === "logs" && (
            <LogsPage
              logs={logs}
              refreshLogs={() => run("logs", refreshLogs)}
              loadOlderLogs={loadOlderLogs}
              openLog={() => run("openLog", () => getDesktopApi().openLog())}
              openConfig={() => run("openConfig", () => getDesktopApi().openConfig())}
              busy={busy}
            />
          )}
        </section>
      </main>

      {modal?.type === "key" && (
        <Modal title="Vendor API key" onClose={() => setModal(null)}>
          <div className="modal-field">
            <label>{vendorEditorDraft?.name || "Vendor"}</label>
            <div className="secret-row">
              <input
                value={modal.value}
                type={modal.show ? "text" : "password"}
                onChange={(event) => setModal((current) => ({ ...current, value: event.target.value }))}
                autoFocus
              />
              <button
                type="button"
                className="icon-command"
                onClick={() => setModal((current) => ({ ...current, show: !current.show }))}
                title={modal.show ? "Hide key" : "Show key"}
              >
                {modal.show ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="button subtle" onClick={() => saveKeyModal(true)}>
              Clear
            </button>
            <button type="button" className="button" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button type="button" className="button primary" onClick={() => saveKeyModal(false)}>
              Save
            </button>
          </div>
        </Modal>
      )}

      {modal?.type === "delete" && (
        <Modal title="Delete vendor" onClose={() => setModal(null)}>
          <p className="modal-message">Delete {modal.name}? This removes it from config.json immediately.</p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button type="button" className="button danger" onClick={confirmRemoveVendor}>
              Delete
            </button>
          </div>
        </Modal>
      )}

      {modal?.type === "close" && (
        <Modal title="Close Local Model Router" onClose={cancelWindowClose} tone="attention">
          <div className="close-confirm">
            <div className="close-confirm-icon">
              <XCircle size={22} />
            </div>
            <div>
              <p className="modal-message">Keep Router available from the Windows tray, or exit and stop it now.</p>
              <div className="close-choice-list">
                <span>Tray keeps Settings one double-click away.</span>
                <span>Exit stops the local Router process before closing.</span>
              </div>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="button" onClick={cancelWindowClose}>
              Cancel
            </button>
            <button type="button" className="button subtle" onClick={quitAndStopRouter}>
              Exit and stop Router
            </button>
            <button type="button" className="button primary" onClick={hideWindowToTray} autoFocus>
              Keep running in tray
            </button>
          </div>
        </Modal>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function getStatus(health) {
  if (!health) {
    return { label: "Checking", tone: "neutral", detail: "" };
  }

  if (health.ok) {
    return {
      label: "Running",
      tone: "success",
      detail: health.body?.model || "",
    };
  }

  if (health.processCount > 0) {
    return {
      label: "Process found",
      tone: "warning",
      detail: health.error || "",
    };
  }

  return {
    label: "Stopped",
    tone: "neutral",
    detail: health.error || "",
  };
}

function eyebrowForPage(page) {
  return page === "vendor-edit" ? "settings" : page;
}

function titleForPage(page, vendorEditorDraft) {
  if (page === "vendor-edit") {
    return vendorEditorDraft?.name || "Vendor Settings";
  }

  return {
    settings: "Settings",
    logs: "Runtime Logs",
  }[page];
}

function ActionButton({ icon: Icon, label, onClick, busy, variant = "default", title, disabled = false }) {
  return (
    <button type="button" className={`button ${variant}`} onClick={onClick} disabled={busy || disabled} title={title}>
      {busy ? <Loader2 className="spin" size={16} /> : <Icon size={16} />}
      <span>{label}</span>
    </button>
  );
}

function DockButton({ icon: Icon, label, onClick, busy, variant = "default" }) {
  return (
    <button
      type="button"
      className={`dock-button ${variant}`}
      onClick={onClick}
      disabled={busy}
      title={label}
      aria-label={label}
    >
      {busy ? <Loader2 className="spin" size={18} /> : <Icon size={18} />}
    </button>
  );
}

function RouterPage({ draft, updateRouter, showRouterKey, setShowRouterKey, saveRouter, busy, validation }) {
  return (
    <div className="panel-grid single">
      <div className="panel wide">
        <div className="panel-toolbar">
          <PanelHeader icon={Settings2} title="Router" />
          <ActionButton
            icon={Save}
            label="Save Router"
            onClick={saveRouter}
            busy={busy === "saveRouter"}
            disabled={validation.hasErrors}
            variant="primary"
            title="Save Router settings to config.json."
          />
        </div>
        <div className="form-grid">
          <Field label="Port" message={validation.fields.port?.message} tone={validation.fields.port?.tone}>
            <input value={draft.router.port} inputMode="numeric" onChange={(event) => updateRouter("port", event.target.value)} />
          </Field>
          <Field label="Request timeout ms" message={validation.fields.requestTimeoutMs?.message} tone={validation.fields.requestTimeoutMs?.tone}>
            <input
              value={draft.router.requestTimeoutMs}
              inputMode="numeric"
              onChange={(event) => updateRouter("requestTimeoutMs", event.target.value)}
            />
          </Field>
          <Field label="Router API key" wide>
            <div className="secret-row">
              <input
                value={draft.router.apiKey}
                type={showRouterKey ? "text" : "password"}
                onChange={(event) => updateRouter("apiKey", event.target.value)}
              />
              <button
                type="button"
                className="icon-command"
                onClick={() => setShowRouterKey(!showRouterKey)}
                title={showRouterKey ? "Hide key" : "Show key"}
              >
                {showRouterKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </Field>
        </div>
      </div>
    </div>
  );
}

function VendorsPage({
  vendors,
  updateVendor,
  addVendor,
  removeVendor,
  moveVendor,
  openVendorEditor,
  busy,
}) {
  return (
    <div className="panel full">
      <div className="panel-heading row">
        <PanelHeader icon={Server} title="Vendors" />
        <div className="mini-toolbar">
          <ActionButton icon={Plus} label="Add" onClick={addVendor} busy={busy} />
        </div>
      </div>

      <div className="vendor-list">
        {vendors.length === 0 && (
          <div className="empty-state">
            <Server size={26} />
            <h3>No vendors configured</h3>
          </div>
        )}

        {vendors.map((vendor, index) => {
          const validation = validateVendor(vendor);
          const isEnabled = vendor.enabled !== false && !validation.hasErrors;
          return (
            <section
              className={`vendor-card ${isEnabled ? "" : "disabled"} ${validation.hasErrors ? "invalid" : ""}`}
              key={`${vendor.name}-${index}`}
              role="button"
              tabIndex={0}
              onClick={() => openVendorEditor(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openVendorEditor(index);
                }
              }}
            >
              <div className="vendor-card-main">
                <div className="vendor-title">
                  <span className="priority-badge">{index + 1}</span>
                  <div>
                    <h3>{vendor.name || "New vendor"}</h3>
                    <span>{vendor.baseUrl || "Base URL not set"}</span>
                  </div>
                </div>

                <div className="vendor-summary">
                  {vendor.model && <span>{vendor.model}</span>}
                  {validation.errors.map((message) => (
                    <span className="summary-key danger" key={message}>{message}</span>
                  ))}
                  {validation.warnings.map((message) => (
                    <span className="summary-key warning" key={message}>{message}</span>
                  ))}
                </div>
              </div>

              <div className="vendor-actions" onClick={(event) => event.stopPropagation()}>
                <label
                  className="toggle-row"
                  title={validation.hasErrors ? "Fix errors before enabling vendor" : isEnabled ? "Disable vendor" : "Enable vendor"}
                >
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(event) => updateVendor(index, "enabled", event.target.checked)}
                    aria-label={isEnabled ? "Disable vendor" : "Enable vendor"}
                    disabled={busy || validation.hasErrors}
                  />
                  <span>{isEnabled ? "Enabled" : "Disabled"}</span>
                </label>
                <button type="button" className="icon-command" onClick={() => moveVendor(index, -1)} title="Move up" disabled={busy}>
                  <ArrowUp size={16} />
                </button>
                <button type="button" className="icon-command" onClick={() => moveVendor(index, 1)} title="Move down" disabled={busy}>
                  <ArrowDown size={16} />
                </button>
                <button type="button" className="icon-command danger" onClick={() => removeVendor(index)} title="Remove" disabled={busy}>
                  <Trash2 size={16} />
                </button>
                <span className="card-chevron">
                  <ChevronRight size={18} />
                </span>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function VendorEditorPage({
  vendor,
  updateVendor,
  openKeyModal,
  saveVendor,
  revertVendor,
  busy,
  onBack,
}) {
  if (!vendor) {
    return (
      <div className="panel-grid single">
        <div className="panel wide">
          <button type="button" className="text-command" onClick={onBack}>
            <ArrowLeft size={16} />
            <span>Back to settings</span>
          </button>
        </div>
      </div>
    );
  }

  const keyStatus = getKeyStatus(vendor);
  const validation = validateVendor(vendor);

  return (
    <div className="panel-grid single">
      <div className="panel wide vendor-editor-panel">
        <div className="editor-heading">
          <button type="button" className="text-command" onClick={onBack}>
            <ArrowLeft size={16} />
            <span>Back to settings</span>
          </button>

          <div className="editor-actions">
            <ActionButton icon={RotateCcw} label="Revert" onClick={revertVendor} title="Revert all unsaved changes." />
            <ActionButton
              icon={Save}
              label="Save"
              onClick={saveVendor}
              busy={busy === "save"}
              variant="primary"
              title="Save vendor changes to config.json."
            />
          </div>
        </div>

        <PanelHeader icon={Server} title="Vendor Settings" />

        <div className="vendor-form-grid">
          <Field label="Name" message={validation.fields.name?.message} tone={validation.fields.name?.tone}>
            <input value={vendor.name || ""} onChange={(event) => updateVendor("name", event.target.value)} />
          </Field>
          <Field label="Model" message={validation.fields.model?.message} tone={validation.fields.model?.tone}>
            <input value={vendor.model || ""} onChange={(event) => updateVendor("model", event.target.value)} />
          </Field>
          <div className="field">
            <span>Authentication</span>
            <div className="segmented-control">
              <button
                type="button"
                className={vendor.authentication !== "api-key" ? "active" : ""}
                onClick={() => updateVendor("authentication", "none")}
              >
                None
              </button>
              <button
                type="button"
                className={vendor.authentication === "api-key" ? "active" : ""}
                onClick={() => updateVendor("authentication", "api-key")}
              >
                API key
              </button>
            </div>
          </div>
          <Field label="Base URL" wide message={validation.fields.baseUrl?.message} tone={validation.fields.baseUrl?.tone}>
            <input value={vendor.baseUrl || ""} onChange={(event) => updateVendor("baseUrl", event.target.value)} />
          </Field>
          {vendor.authentication === "api-key" && (
            <Field label="Vendor API key" wide message={validation.fields.apiKey?.message} tone={validation.fields.apiKey?.tone}>
              <button type="button" className={`key-pill ${keyStatus.tone}`} onClick={openKeyModal}>
                <KeyRound size={14} />
                <span>{keyStatus.label}</span>
              </button>
            </Field>
          )}
          <details className="advanced-section wide">
            <summary>
              <span>Advanced</span>
              <ChevronDown size={16} />
            </summary>
            <div className="advanced-fields">
              <Field label="Chat path" wide>
                <input
                  value={vendor.chatCompletionsPath || ""}
                  onChange={(event) => updateVendor("chatCompletionsPath", event.target.value)}
                />
              </Field>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function LogsPage({ logs, refreshLogs, loadOlderLogs, openLog, openConfig, busy }) {
  const listRef = useRef(null);
  const rows = parseLogRows(logs.lines);

  function handleScroll(event) {
    const element = event.currentTarget;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < 80 && logs.hasMore && busy !== "olderLogs") {
      void loadOlderLogs();
    }
  }

  return (
    <div className="panel full logs-panel">
      <div className="panel-heading row">
        <PanelHeader icon={Terminal} title="Logs" />
        <div className="mini-toolbar">
          <ActionButton icon={RefreshCw} label="Refresh" busy={busy === "logs"} onClick={refreshLogs} />
          <ActionButton icon={FileText} label="Open log" busy={busy === "openLog"} onClick={openLog} />
          <ActionButton icon={FileCog} label="Open config" busy={busy === "openConfig"} onClick={openConfig} />
        </div>
      </div>
      <div className="log-path">{logs.path}</div>
      {rows.length === 0 ? (
        <div className="log-empty">No log entries yet.</div>
      ) : (
        <div className="log-list" ref={listRef} onScroll={handleScroll}>
          {rows.map((row) => (
            <article className={`log-entry ${row.tone}`} key={row.id}>
              <div className="log-entry-header">
                <span className={`summary-key ${row.tone}`}>{row.level}</span>
                <strong>{row.event}</strong>
                {row.time && <time>{formatLogTime(row.time)}</time>}
              </div>
              <div className="log-entry-meta">
                {row.vendor && <span>Vendor: {row.vendor}</span>}
                {row.model && <span>Model: {row.model}</span>}
                {row.statusCode && <span>Status: {row.statusCode}</span>}
                {row.elapsedMs !== undefined && <span>Elapsed: {row.elapsedMs}ms</span>}
                {row.totalElapsedMs !== undefined && <span>Total: {row.totalElapsedMs}ms</span>}
                {row.requestId && <span>Request: {row.requestId}</span>}
              </div>
              {row.message && <p>{row.message}</p>}
              <details className="log-raw">
                <summary>Raw</summary>
                <pre>{row.raw}</pre>
              </details>
            </article>
          ))}
          {logs.hasMore && <div className="log-load-sentinel">{busy === "olderLogs" ? "Loading older entries..." : "Scroll for older entries"}</div>}
        </div>
      )}
    </div>
  );
}

function PanelHeader({ icon: Icon, title }) {
  return (
    <div className="panel-heading">
      <div className="panel-icon">
        <Icon size={18} />
      </div>
      <h2>{title}</h2>
    </div>
  );
}

function Field({ label, children, wide, message, tone }) {
  return (
    <div className={["field", wide && "wide", tone && "has-" + tone].filter(Boolean).join(" ")}>
      <span>{label}</span>
      {children}
      {message && <small className={"field-message " + tone}>{message}</small>}
    </div>
  );
}

function Modal({ title, children, onClose, tone = "default" }) {
  return (
    <div className="modal-backdrop">
      <div className={`modal ${tone}`}>
        <div className="modal-title">
          <h2>{title}</h2>
          <button type="button" className="icon-command" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
