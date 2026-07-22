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
import {
  defaultDraft,
  getVendorModels,
  normalizeVendorModelsForDraft,
  toConfig,
  toDraft,
} from "./config-draft.js";
import {
  canLoadVendorModels,
  cloneVendor,
  endpointFromDraft,
  formatLogTime,
  getVendorModelOptions,
  getVendorModelsErrorField,
  getVendorModelsLoadMessage,
  getVendorModelsSourceKey,
  parseLogRows,
  validateRouter,
  validateVendor,
} from "./app-model.js";
import { useLogsController, useUpdateController } from "./app-controllers.js";
import { getDesktopApi } from "./desktop-api.js";

const defaultAppName = "Local Model Router";

const navItems = [
  { id: "application", label: "Application", icon: Settings2 },
  { id: "router", label: "Router", icon: Server },
  { id: "logs", label: "Logs", icon: Terminal },
];

const closeBehaviorOptions = [
  { value: "tray", label: "Keep in tray" },
  { value: "exit", label: "Exit and stop" },
  { value: "ask", label: "Ask every time" },
];

export default function App() {
  const [page, setPage] = useState("application");
  const [draft, setDraft] = useState(defaultDraft);
  const [persistedDraft, setPersistedDraft] = useState(defaultDraft);
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [showRouterKey, setShowRouterKey] = useState(false);
  const [modal, setModal] = useState(null);
  const [showVendorKey, setShowVendorKey] = useState(false);
  const [vendorEditorIndex, setVendorEditorIndex] = useState(null);
  const [vendorEditorDraft, setVendorEditorDraft] = useState(null);
  const [vendorEditorOriginal, setVendorEditorOriginal] = useState(null);
  const [vendorEditorIsNew, setVendorEditorIsNew] = useState(false);
  const [availableVendorModels, setAvailableVendorModels] = useState([]);
  const [vendorModelsError, setVendorModelsError] = useState(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [appName, setAppName] = useState(defaultAppName);
  const [isDevelopmentRuntime, setIsDevelopmentRuntime] = useState(false);
  const [configRevision, setConfigRevision] = useState("");
  const vendorModelsRequestRef = useRef(0);
  const vendorModelsSourceKeyRef = useRef("");

  const endpoint = useMemo(() => endpointFromDraft(draft), [draft]);
  const status = useMemo(() => getStatus(health), [health]);
  const routerValidation = useMemo(() => validateRouter(draft.router), [draft.router]);
  const routerActive = health?.ok || Number(health?.processCount || 0) > 0;
  const { logs, refreshLogs, loadOlderLogs } = useLogsController({ busy, run });
  const { updateState, downloadAppUpdate, installAppUpdate } = useUpdateController({ run, setToast });

  useEffect(() => {
    void loadState();
  }, []);

  useEffect(() => {
    const unsubscribe = getDesktopApi().onOpenSettings?.(() => {
      closeVendorEditor();
      setPage("application");
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

  async function loadState({ toastMessage = "" } = {}) {
    let configLoaded = false;
    setBusy("load");
    try {
      const state = await getDesktopApi().loadConfig();
      setAppName(state.appName || defaultAppName);
      setIsDevelopmentRuntime(Boolean(state.isDevelopmentRuntime));
      const loadedDraft = toDraft(state.config);
      setConfigRevision(state.revision || "");
      setDraft(loadedDraft);
      setPersistedDraft(loadedDraft);
      setRestartRequired(false);
      configLoaded = true;
      if (toastMessage) {
        setToast(toastMessage);
      }
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

  async function reloadConfig() {
    setModal(null);
    if (page === "vendor-edit") {
      setVendorEditorIndex(null);
      setVendorEditorDraft(null);
      setVendorEditorOriginal(null);
      setVendorEditorIsNew(false);
      clearVendorModelOptions();
      setPage("router");
    }
    await loadState({ toastMessage: "Config reloaded." });
  }

  async function startRouter() {
    await run("start", async () => {
      const result = await getDesktopApi().startRouter();
      setHealth(result.health);
      setRestartRequired(false);
      setToast(result.health?.ok ? "Router started." : result.error || result.health?.error || "Router failed to start.");
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
      setToast(result.health?.ok ? "Router restarted." : result.error || result.health?.error || "Router failed to restart.");
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

  async function writeConfig(nextDraft) {
    const result = await getDesktopApi().saveConfig({
      config: toConfig(nextDraft),
      revision: configRevision,
    });
    const savedDraft = toDraft(result.config);
    setConfigRevision(result.revision || "");
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
      if (message) {
        setToast(message);
      }
    } catch (error) {
      setDraft((current) => ({ ...current, vendors: persistedDraft.vendors }));
      throw error;
    }
  }

  async function copyEndpoint() {
    await getDesktopApi().writeClipboard(endpoint);
    setToast("Endpoint copied.");
  }

  async function copyRouterApiKey() {
    if (!draft.router.apiKey) {
      setToast("Router API key is empty.");
      return;
    }

    await getDesktopApi().writeClipboard(draft.router.apiKey);
    setToast("Router API key copied.");
  }

  async function copyVendorApiKey() {
    if (!vendorEditorDraft?.apiKey) {
      setToast("Vendor API key is empty.");
      return;
    }

    await getDesktopApi().writeClipboard(vendorEditorDraft.apiKey);
    setToast("Vendor API key copied.");
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

  function clearVendorModelOptions() {
    vendorModelsRequestRef.current += 1;
    vendorModelsSourceKeyRef.current = "";
    setAvailableVendorModels([]);
    setVendorModelsError(null);
    setBusy((current) => (current === "vendorModels" ? "" : current));
  }

  function updateRouter(field, value) {
    setDraft((current) => ({
      ...current,
      router: { ...current.router, [field]: value },
    }));
  }

  async function setAppSetting(field, value) {
    if (busy === "saveApp" || value === persistedDraft.app[field]) {
      return;
    }

    await run("saveApp", async () => {
      const result = await getDesktopApi().saveConfig({
        config: toConfig({
          ...persistedDraft,
          app: { ...persistedDraft.app, [field]: value },
        }),
        revision: configRevision,
      });
      const savedDraft = toDraft(result.config);
      setConfigRevision(result.revision || "");
      setPersistedDraft(savedDraft);
      setDraft((current) => ({ ...current, app: savedDraft.app }));
    });
  }

  function updateVendor(index, field, value) {
    const nextVendor = { ...draft.vendors[index], [field]: value };
    if (field === "enabled" && value && validateVendor(nextVendor).hasErrors) {
      setToast("Fix the red Vendor errors before enabling it.");
      return;
    }

    const vendors = draft.vendors.map((vendor, vendorIndex) => (vendorIndex === index ? nextVendor : vendor));
    setDraft((current) => ({ ...current, vendors }));
    void run("vendors", () => persistVendorList(vendors));
  }

  function addVendor() {
    const vendor = {
      name: "new-vendor",
      baseUrl: "https://example.com/v1",
      models: [{ id: draft.model.id || "model-id", enabled: true }],
      authentication: "none",
      enabled: false,
    };

    setVendorEditorIndex(draft.vendors.length);
    setVendorEditorDraft(cloneVendor(vendor));
    setVendorEditorOriginal(cloneVendor(vendor));
    setVendorEditorIsNew(true);
    setShowVendorKey(false);
    clearVendorModelOptions();
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
    void run("vendors", () => persistVendorList(vendors));
  }

  function openVendorEditor(index) {
    const vendor = cloneVendor(draft.vendors[index]);
    setVendorEditorIndex(index);
    setVendorEditorDraft(vendor);
    setVendorEditorOriginal(cloneVendor(vendor));
    setVendorEditorIsNew(false);
    setShowVendorKey(false);
    clearVendorModelOptions();
    setPage("vendor-edit");
  }

  function closeVendorEditor() {
    setVendorEditorIndex(null);
    setVendorEditorDraft(null);
    setVendorEditorOriginal(null);
    setVendorEditorIsNew(false);
    setShowVendorKey(false);
    clearVendorModelOptions();
    setPage("router");
  }

  function updateVendorEditor(field, value) {
    setVendorEditorDraft((current) => ({ ...current, [field]: value }));
  }

  function updateVendorEditorModel(modelIndex, field, value) {
    setVendorEditorDraft((current) => {
      const models = getVendorModels(current).map((model, index) => (index === modelIndex ? { ...model, [field]: value } : model));
      return { ...current, models };
    });
  }

  function addVendorEditorModel() {
    setVendorEditorDraft((current) => ({
      ...current,
      models: [...getVendorModels(current), { id: "", enabled: true }],
    }));
  }

  async function loadVendorModels(vendor, { silent = false, force = false, sourceKey = getVendorModelsSourceKey(vendor) } = {}) {
    if (!vendor) {
      return;
    }
    if (!canLoadVendorModels(vendor)) {
      const message = getVendorModelsLoadMessage(vendor);
      setVendorModelsError(null);
      if (!silent) {
        setToast(message);
      }
      return;
    }
    if (!force && sourceKey === vendorModelsSourceKeyRef.current) {
      return;
    }
    if (typeof getDesktopApi().listVendorModels !== "function") {
      if (!silent) {
        setToast("Restart the desktop app to enable model list loading.");
      }
      return;
    }

    const requestId = vendorModelsRequestRef.current + 1;
    vendorModelsRequestRef.current = requestId;
    vendorModelsSourceKeyRef.current = sourceKey;
    setAvailableVendorModels([]);
    setVendorModelsError(null);
    if (!silent) {
      setBusy("vendorModels");
    }

    try {
      const result = await getDesktopApi().listVendorModels(vendor);
      if (requestId !== vendorModelsRequestRef.current || sourceKey !== vendorModelsSourceKeyRef.current) {
        return;
      }
      setAvailableVendorModels(result.models || []);
      setVendorModelsError(null);
      if (!silent) {
        setToast(`Loaded ${(result.models || []).length} models.`);
      }
    } catch (error) {
      if (requestId !== vendorModelsRequestRef.current || sourceKey !== vendorModelsSourceKeyRef.current) {
        return;
      }
      const fieldError = getVendorModelsErrorField(error, vendor);
      setVendorModelsError(fieldError);
      if (!silent) {
        setToast(fieldError.message);
      }
    } finally {
      if (!silent && requestId === vendorModelsRequestRef.current) {
        setBusy((current) => (current === "vendorModels" ? "" : current));
      }
    }
  }

  async function refreshVendorModels() {
    await loadVendorModels(vendorEditorDraft, { force: true });
  }

  async function loadVendorModelsOnSelect() {
    await loadVendorModels(vendorEditorDraft, { silent: true });
  }

  function removeVendorEditorModel(modelIndex) {
    setVendorEditorDraft((current) => {
      const models = getVendorModels(current).filter((_model, index) => index !== modelIndex);
      return { ...current, models };
    });
  }

  function requestRemoveVendorEditorModel(modelIndex) {
    const modelId = getVendorModels(vendorEditorDraft)[modelIndex]?.id || "this model";
    setModal({ type: "deleteVendorModel", index: modelIndex, name: modelId });
  }

  function confirmRemoveVendorEditorModel() {
    removeVendorEditorModel(modal.index);
    setModal(null);
  }

  async function saveVendorEditor() {
    await run("save", async () => {
      const savedVendor = cloneVendor(vendorEditorDraft);
      const validation = validateVendor(savedVendor);
      if (validation.hasErrors) {
        setToast("Fix the red Vendor errors before saving.");
        return;
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
      setToast("Vendor saved to config.json.");
    });
  }

  function revertVendorEditor() {
    setVendorEditorDraft(cloneVendor(vendorEditorOriginal));
    setToast("Vendor changes reverted.");
  }

  function requestRevertVendorEditor() {
    setModal({ type: "revertVendor" });
  }

  function confirmRevertVendorEditor() {
    revertVendorEditor();
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
          <div className="brand-identity">
            <div className="brand-mark">
              <ShieldCheck size={20} />
            </div>
            <div>
              <div className="brand-title">{appName}</div>
              <div className="brand-subtitle">{appName === defaultAppName ? "Desktop Control" : "Development Control"}</div>
            </div>
          </div>

          <SidebarUpdateButton
            updateState={updateState}
            downloadUpdate={downloadAppUpdate}
            installUpdate={installAppUpdate}
            busy={busy}
          />
        </div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            const activePage = page === "vendor-edit" ? "router" : page;
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

        <div className="sidebar-footer">
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
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">{eyebrowForPage(page)}</div>
            <h1>{titleForPage(page, vendorEditorDraft)}</h1>
          </div>
          {isDevelopmentRuntime && (
            <button type="button" className="icon-command" onClick={reloadConfig} disabled={busy === "load"} title="Reload config">
              <RefreshCw className={busy === "load" ? "spin" : ""} size={18} />
            </button>
          )}
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
          {page === "application" && (
            <div className="settings-stack">
              <AppSettingsPage
                app={draft.app}
                setAppSetting={setAppSetting}
                busy={busy}
              />
            </div>
          )}
          {page === "router" && (
            <div className="settings-stack">
              <RouterPage
                draft={draft}
                updateRouter={updateRouter}
                showRouterKey={showRouterKey}
                setShowRouterKey={setShowRouterKey}
                copyRouterApiKey={copyRouterApiKey}
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
              updateVendorModel={updateVendorEditorModel}
              addVendorModel={addVendorEditorModel}
              removeVendorModel={requestRemoveVendorEditorModel}
              availableModels={availableVendorModels}
              vendorModelsError={vendorModelsError}
              refreshVendorModels={refreshVendorModels}
              loadVendorModelsOnSelect={loadVendorModelsOnSelect}
              showVendorKey={showVendorKey}
              setShowVendorKey={setShowVendorKey}
              copyVendorApiKey={copyVendorApiKey}
              saveVendor={saveVendorEditor}
              revertVendor={requestRevertVendorEditor}
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

      {modal?.type === "delete" && (
        <Modal title="Delete vendor" onClose={() => setModal(null)}>
          <p className="modal-message">This removes the vendor immediately.</p>
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

      {modal?.type === "deleteVendorModel" && (
        <Modal title="Delete model" onClose={() => setModal(null)}>
          <p className="modal-message">This removes the model from the current vendor draft.</p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button type="button" className="button danger" onClick={confirmRemoveVendorEditorModel}>
              Delete
            </button>
          </div>
        </Modal>
      )}

      {modal?.type === "revertVendor" && (
        <Modal title="Revert vendor changes" onClose={() => setModal(null)}>
          <p className="modal-message">Revert all unsaved changes for this vendor?</p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button type="button" className="button danger" onClick={confirmRevertVendorEditor}>
              Revert
            </button>
          </div>
        </Modal>
      )}

      {modal?.type === "close" && (
        <Modal title={`Close ${appName}`} onClose={cancelWindowClose} tone="attention">
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
  return page === "vendor-edit" ? "router" : page;
}

function titleForPage(page, vendorEditorDraft) {
  if (page === "vendor-edit") {
    return vendorEditorDraft?.name || "Vendor Settings";
  }

  return {
    application: "Application",
    router: "Router",
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

function RouterPage({ draft, updateRouter, showRouterKey, setShowRouterKey, copyRouterApiKey, saveRouter, busy, validation }) {
  return (
    <div className="panel-grid single">
      <div className="panel wide">
        <div className="panel-toolbar">
          <PanelHeader icon={Settings2} title="Router" />
          <ActionButton
            icon={Save}
            label="Save"
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
          <Field label="Router API key" wide>
            <div className="secret-row two-actions">
              <input
                value={draft.router.apiKey}
                type={showRouterKey ? "text" : "password"}
                onChange={(event) => updateRouter("apiKey", event.target.value)}
              />
              <button
                type="button"
                className="icon-command"
                onClick={copyRouterApiKey}
                title="Copy API key"
              >
                <Clipboard size={18} />
              </button>
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

function AppSettingsPage({ app, setAppSetting, busy }) {
  return (
    <div className="panel-grid single">
      <div className="panel wide">
        <PanelHeader icon={Settings2} title="Window" />
        <div className="form-grid">
          <div className="field wide">
            <span>Close button</span>
            <div className="segmented-control three">
              {closeBehaviorOptions.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={app.closeBehavior === option.value ? "active" : ""}
                  onClick={() => setAppSetting("closeBehavior", option.value)}
                  disabled={busy === "saveApp"}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="app-setting-row" title="Start Local Model Router after signing in to Windows">
            <span>Start at login</span>
            <input
              className="checkbox"
              type="checkbox"
              checked={app.startAtLogin === true}
              onChange={(event) => setAppSetting("startAtLogin", event.target.checked)}
              disabled={busy === "saveApp"}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

function SidebarUpdateButton({ updateState, downloadUpdate, installUpdate, busy }) {
  const isDownloading = busy === "updateDownload" || updateState.status === "downloading";
  const isInstalling = busy === "updateInstall";
  const percent = Math.round(updateState.progress?.percent || 0);

  const downloadFailed = updateState.status === "error" && Boolean(updateState.availableVersion);

  if (!["available", "downloading", "downloaded"].includes(updateState.status) && !downloadFailed) {
    return null;
  }

  if (updateState.status === "downloaded") {
    return (
      <button
        type="button"
        className="sidebar-update-button ready"
        onClick={installUpdate}
        disabled={isInstalling}
        title={`Install version ${updateState.availableVersion}`}
      >
        {isInstalling ? <Loader2 className="spin" size={17} /> : <RotateCcw size={17} />}
        <span>Restart to update</span>
      </button>
    );
  }

  if (isDownloading) {
    return (
      <div className="sidebar-update-progress" aria-label={`Downloading update ${percent}%`}>
        <div className="sidebar-update-progress-label">
          <span>Downloading</span>
          <span>{percent}%</span>
        </div>
        <div className="sidebar-update-progress-track">
          <div style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  if (downloadFailed) {
    return (
      <button
        type="button"
        className="sidebar-update-button failed"
        onClick={downloadUpdate}
        title={updateState.error || "Update download failed"}
      >
        <span>Update failed · Retry</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="sidebar-update-button"
      onClick={downloadUpdate}
      disabled={isInstalling}
      title={`Download version ${updateState.availableVersion}`}
    >
      <span>Update available</span>
    </button>
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
          const enabledModels = getVendorModels(vendor).filter((model) => model.enabled !== false);
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
                  {enabledModels.slice(0, 3).map((model) => (
                    <span key={model.id}>{model.id}</span>
                  ))}
                  {enabledModels.length > 3 && <span>{enabledModels.length} models</span>}
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
  updateVendorModel,
  addVendorModel,
  removeVendorModel,
  availableModels,
  vendorModelsError,
  refreshVendorModels,
  loadVendorModelsOnSelect,
  showVendorKey,
  setShowVendorKey,
  copyVendorApiKey,
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
            <span>Back to Router</span>
          </button>
        </div>
      </div>
    );
  }

  const validation = validateVendor(vendor);
  const vendorValidation = {
    ...validation,
    fields: {
      ...validation.fields,
      ...(vendorModelsError && vendorModelsError.field !== "models"
        ? { [vendorModelsError.field]: { tone: "error", message: vendorModelsError.message } }
        : {}),
    },
  };
  const models = getVendorModels(vendor);
  const modelOptions = getVendorModelOptions(vendor, availableModels);
  const modelLoadMessage = getVendorModelsLoadMessage(vendor);

  return (
    <div className="panel-grid single">
      <div className="panel wide vendor-editor-panel">
        <div className="editor-heading">
          <button type="button" className="text-command" onClick={onBack}>
            <ArrowLeft size={16} />
            <span>Back to Router</span>
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
          <Field label="Name" message={vendorValidation.fields.name?.message} tone={vendorValidation.fields.name?.tone}>
            <input value={vendor.name || ""} onChange={(event) => updateVendor("name", event.target.value)} />
          </Field>
          <div className={["field", vendorValidation.fields.authentication?.tone && "has-" + vendorValidation.fields.authentication.tone].filter(Boolean).join(" ")}>
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
            {vendorValidation.fields.authentication?.message && (
              <small className={"field-message " + vendorValidation.fields.authentication.tone}>{vendorValidation.fields.authentication.message}</small>
            )}
          </div>
          <Field label="Base URL" wide message={vendorValidation.fields.baseUrl?.message} tone={vendorValidation.fields.baseUrl?.tone}>
            <input value={vendor.baseUrl || ""} onChange={(event) => updateVendor("baseUrl", event.target.value)} />
          </Field>
          {vendor.authentication === "api-key" && (
            <Field label="Vendor API key" wide message={vendorValidation.fields.apiKey?.message} tone={vendorValidation.fields.apiKey?.tone}>
              <div className="secret-row two-actions">
                <input
                  value={vendor.apiKey || ""}
                  type={showVendorKey ? "text" : "password"}
                  onChange={(event) => updateVendor("apiKey", event.target.value)}
                />
                <button type="button" className="icon-command" onClick={copyVendorApiKey} title="Copy API key">
                  <Clipboard size={18} />
                </button>
                <button
                  type="button"
                  className="icon-command"
                  onClick={() => setShowVendorKey(!showVendorKey)}
                  title={showVendorKey ? "Hide key" : "Show key"}
                >
                  {showVendorKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </Field>
          )}
          <div className={["field", "wide", vendorValidation.fields.models?.tone && "has-" + vendorValidation.fields.models.tone].filter(Boolean).join(" ")}>
            <div className="field-toolbar">
              <span>Models</span>
              <div className="field-toolbar-actions">
                <button type="button" className="mini-command" onClick={addVendorModel}>
                  <Plus size={14} />
                  <span>Add model</span>
                </button>
                <button type="button" className="mini-command" onClick={refreshVendorModels} disabled={busy === "vendorModels"}>
                  {busy === "vendorModels" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  <span>Refresh available models</span>
                </button>
              </div>
            </div>
            <div className="model-list">
              {models.map((model, index) => (
                <div className="model-row" key={`${model.id || "model"}-${index}`}>
                  <label className="toggle-row compact" title={model.enabled === false ? "Enable model" : "Disable model"}>
                    <input
                      className="checkbox"
                      type="checkbox"
                      checked={model.enabled !== false}
                      onChange={(event) => updateVendorModel(index, "enabled", event.target.checked)}
                    />
                    <span>{model.enabled === false ? "Off" : "On"}</span>
                  </label>
                  <div className="model-select">
                    <select
                      value={model.id || ""}
                      onFocus={loadVendorModelsOnSelect}
                      onMouseDown={loadVendorModelsOnSelect}
                      onChange={(event) => updateVendorModel(index, "id", event.target.value)}
                    >
                      {!model.id && <option value="">Select model</option>}
                      {modelOptions.map((modelId) => (
                        <option value={modelId} key={modelId}>
                          {modelId}
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" size={16} />
                  </div>
                  <button type="button" className="icon-command danger" onClick={() => removeVendorModel(index)} title="Remove model">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            {modelLoadMessage && <small className="field-message warning">{modelLoadMessage}</small>}
            {vendorModelsError?.field === "models" && <small className="field-message error">{vendorModelsError.message}</small>}
            {vendorValidation.fields.models?.message && <small className="field-message error">{vendorValidation.fields.models.message}</small>}
          </div>
          <details className="advanced-section wide">
            <summary>
              <span>Advanced</span>
              <ChevronDown size={16} />
            </summary>
            <div className="advanced-fields">
              <Field label="Chat path" wide>
                <input
                  value={vendor.chatCompletionsPath || ""}
                  placeholder="/chat/completions"
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
