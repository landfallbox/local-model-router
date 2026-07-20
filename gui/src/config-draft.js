export const defaultDraft = {
  app: { closeBehavior: "tray", startAtLogin: false },
  router: {
    host: "127.0.0.1",
    port: "4000",
    apiKey: "",
    requestTimeoutMs: "30000",
    maxBodyMb: "50",
    maxBodyBytes: 50 * 1024 * 1024,
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

const closeBehaviorValues = new Set(["tray", "exit", "ask"]);

export function normalizeCloseBehavior(value) {
  return closeBehaviorValues.has(value) ? value : defaultDraft.app.closeBehavior;
}

export function normalizeVendorModelsForDraft(vendor, defaultModelId = defaultDraft.model.id) {
  const fallbackId = String(defaultModelId || defaultDraft.model.id).trim() || defaultDraft.model.id;
  if (!Array.isArray(vendor?.models)) {
    const id = String(vendor?.model || fallbackId).trim() || fallbackId;
    return [{ id, enabled: true }];
  }

  return vendor.models.map((model) => normalizeVendorModelForDraft(model, fallbackId));
}

function normalizeVendorModelForDraft(model, fallbackId) {
  if (typeof model === "string") {
    return { id: model.trim(), enabled: true };
  }
  if (!model || typeof model !== "object") {
    return { id: fallbackId, enabled: true };
  }

  const hasExplicitId = Object.prototype.hasOwnProperty.call(model, "id");
  return {
    ...model,
    id: String(hasExplicitId ? model.id || "" : model.model || fallbackId).trim(),
    enabled: model.enabled !== false,
  };
}

export function getVendorModels(vendor, defaultModelId = defaultDraft.model.id) {
  return normalizeVendorModelsForDraft(vendor, defaultModelId);
}

export function toDraft(config) {
  const app = config.app || {};
  const router = config.router || {};
  const model = config.model || {};
  const modelId = model.id || defaultDraft.model.id;

  return {
    app: {
      closeBehavior: normalizeCloseBehavior(app.closeBehavior),
      startAtLogin: app.startAtLogin === true,
    },
    router: {
      host: router.host || defaultDraft.router.host,
      port: String(router.port ?? 4000),
      apiKey: router.apiKey || "",
      requestTimeoutMs: String(router.requestTimeoutMs ?? 30000),
      // Preserve exact bytes so saving an unrelated field cannot round the value.
      maxBodyMb: formatMegabytes(router.maxBodyBytes),
      maxBodyBytes: Number(router.maxBodyBytes || defaultDraft.router.maxBodyBytes),
      fallbackStatusCodesText: Array.isArray(router.fallbackStatusCodes)
        ? router.fallbackStatusCodes.join(", ")
        : defaultDraft.router.fallbackStatusCodesText,
      logFile: router.logFile || defaultDraft.router.logFile,
    },
    model: {
      id: model.id || defaultDraft.model.id,
      name: model.name || defaultDraft.model.name,
      ownedBy: model.ownedBy || defaultDraft.model.ownedBy,
      maxInputTokens: String(model.maxInputTokens ?? 200000),
      maxOutputTokens: String(model.maxOutputTokens ?? 64000),
    },
    vendors: Array.isArray(config.vendors)
      ? config.vendors.map((vendor) => ({
          ...vendor,
          models: normalizeVendorModelsForDraft(vendor, modelId),
          authentication: vendor.authentication === "api-key" || vendor.apiKey ? "api-key" : "none",
        }))
      : [],
  };
}

export function toConfig(draft) {
  return {
    app: {
      closeBehavior: normalizeCloseBehavior(draft.app?.closeBehavior),
      startAtLogin: draft.app?.startAtLogin === true,
    },
    router: {
      host: draft.router.host.trim() || defaultDraft.router.host,
      port: numberValue(draft.router.port, 4000),
      apiKey: draft.router.apiKey,
      requestTimeoutMs: numberValue(draft.router.requestTimeoutMs, 30000),
      maxBodyBytes: megabytesToBytes(draft.router.maxBodyMb, draft.router.maxBodyBytes),
      fallbackStatusCodes: parseStatusCodes(draft.router.fallbackStatusCodesText),
      logFile: draft.router.logFile.trim() || defaultDraft.router.logFile,
    },
    model: {
      id: draft.model.id.trim() || defaultDraft.model.id,
      name: draft.model.name.trim() || defaultDraft.model.name,
      ownedBy: draft.model.ownedBy.trim() || defaultDraft.model.ownedBy,
      maxInputTokens: numberValue(draft.model.maxInputTokens, 200000),
      maxOutputTokens: numberValue(draft.model.maxOutputTokens, 64000),
    },
    vendors: draft.vendors.map((vendor) => {
      const normalized = {
        ...vendor,
        name: String(vendor.name || "").trim(),
        baseUrl: String(vendor.baseUrl || "").trim(),
        models: normalizeVendorModelsForDraft(vendor, draft.model.id).map((model) => ({
          id: String(model.id || "").trim(),
          enabled: model.enabled !== false,
        })),
        authentication: vendor.authentication === "api-key" ? "api-key" : "none",
        enabled: vendor.enabled !== false,
      };
      for (const key of ["timeoutMs", "apiKeyEnv", "headers", "model"]) {
        delete normalized[key];
      }
      if (normalized.authentication === "none") {
        delete normalized.apiKey;
      }
      return normalized;
    }),
  };
}

function parseStatusCodes(value) {
  const codes = value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const code = Number(item);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new Error(`Invalid fallback status code: ${item}`);
    }
    return code;
  });

  if (!codes.length) {
    throw new Error("At least one fallback status code is required.");
  }
  if (new Set(codes).size !== codes.length) {
    throw new Error("Fallback status codes must be unique.");
  }
  return codes;
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatMegabytes(bytes) {
  const megabytes = Number(bytes || defaultDraft.router.maxBodyBytes) / 1048576;
  return String(Number(megabytes.toFixed(6)));
}

function megabytesToBytes(value, fallbackBytes) {
  const megabytes = Number(value);
  return Number.isFinite(megabytes) ? Math.round(megabytes * 1048576) : fallbackBytes;
}