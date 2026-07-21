import { getVendorModels } from "./config-draft.js";

export function getVendorModelOptions(vendor, availableModels = []) {
  return [
    ...new Set([
      ...availableModels.map((modelId) => String(modelId || "").trim()).filter(Boolean),
      ...getVendorModels(vendor).map((model) => String(model.id || "").trim()).filter(Boolean),
    ]),
  ];
}

export function getVendorModelsSourceKey(vendor) {
  return String(vendor?.baseUrl || "").trim();
}

export function validateVendorBaseUrl(value) {
  const baseUrl = String(value || "").trim();
  if (!baseUrl) {
    return "Base URL is required.";
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return "Base URL must start with http:// or https://.";
  }

  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "Base URL must use HTTP or HTTPS.";
    }
  } catch {
    return "Base URL must be a valid URL, for example http://127.0.0.1:8000/v1.";
  }

  return "";
}

export function getVendorModelsLoadMessage(vendor) {
  const baseUrlError = validateVendorBaseUrl(vendor?.baseUrl);
  if (baseUrlError) {
    return baseUrlError;
  }
  if (vendor?.authentication === "api-key" && !vendor?.apiKey) {
    return "Enter the Vendor API key before loading models.";
  }
  return "";
}

export function canLoadVendorModels(vendor) {
  if (getVendorModelsLoadMessage(vendor)) {
    return false;
  }
  return vendor?.authentication !== "api-key" || Boolean(vendor?.apiKey);
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

export function validateRouter(router) {
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

  return { errors, fields, hasErrors: errors.length > 0, firstError: errors[0] || "" };
}

export function endpointFromDraft(draft) {
  const host = draft.router.host.trim() || "127.0.0.1";
  const port = numberValue(draft.router.port, 4000);
  return `http://${host}:${port}/v1/chat/completions`;
}

export function validateVendor(vendor) {
  const errors = [];
  const warnings = [];
  const fields = {};
  const name = String(vendor?.name || "").trim();
  const baseUrl = String(vendor?.baseUrl || "").trim();
  const models = getVendorModels(vendor);
  const enabledModels = models.filter((model) => model.enabled !== false);
  const authentication = vendor?.authentication === "api-key" ? "api-key" : "none";

  if (!name) {
    fields.name = { tone: "error", message: "Name is required." };
    errors.push("Name required");
  }

  const baseUrlError = validateVendorBaseUrl(baseUrl);
  if (baseUrlError) {
    fields.baseUrl = { tone: "error", message: baseUrlError };
    errors.push("Base URL required");
  }

  if (!enabledModels.length) {
    fields.models = { tone: "error", message: "Add at least one enabled model." };
    errors.push("No enabled model");
  } else {
    const seenModelIds = new Set();
    for (const model of enabledModels) {
      if (!model.id) {
        fields.models = { tone: "error", message: "Every enabled model needs a name." };
        errors.push("Invalid model mapping");
        break;
      }
      if (seenModelIds.has(model.id)) {
        fields.models = { tone: "error", message: "Model ids must be unique per vendor." };
        errors.push("Duplicate model id");
        break;
      }
      seenModelIds.add(model.id);
    }
  }

  if (authentication === "api-key" && !vendor?.apiKey) {
    fields.apiKey = { tone: "error", message: "Enter the API key required by this vendor." };
    errors.push("Missing key");
  }

  return { errors, warnings, fields, hasErrors: errors.length > 0 };
}

export function getVendorModelsErrorField(error, vendor) {
  const rawMessage = String(error?.message || error || "Failed to refresh models.");
  const jsonCode = rawMessage.match(/"code"\s*:\s*"([^"]+)"/i)?.[1] || "";
  const code = String(error?.code || jsonCode || "").toUpperCase();
  const message = code ? code.replace(/_/g, " ") : rawMessage.replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "");
  if (code.includes("API_KEY") || code.includes("AUTH") || code.includes("UNAUTHORIZED") || /api key|unauthorized|forbidden/i.test(message)) {
    if (vendor?.authentication !== "api-key") {
      return { field: "authentication", message: "API KEY REQUIRED" };
    }
    return { field: "apiKey", message };
  }
  if (code.startsWith("HTTP_4") || /base url|not found|404|connect|network|fetch|timeout/i.test(message)) {
    return { field: "baseUrl", message };
  }
  return { field: "models", message };
}

export function cloneVendor(vendor) {
  return vendor ? JSON.parse(JSON.stringify(vendor)) : null;
}

export function parseLogRows(lines) {
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

export function formatLogTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}