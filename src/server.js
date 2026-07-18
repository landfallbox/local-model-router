import http from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isPlainObject, normalizeConfig, validateConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const runtimeRoot = process.env.LOCAL_MODEL_ROUTER_DATA_DIR || projectRoot;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadConfig() {
  const configPath = process.env.ROUTER_CONFIG || resolve(projectRoot, "config.json");
  const fileConfig = existsSync(configPath) ? readJsonFile(configPath) : {};
  const config = normalizeConfig(fileConfig);

  config.router.host = process.env.HOST || process.env.ROUTER_HOST || config.router.host;
  config.router.port = Number(process.env.PORT || process.env.ROUTER_PORT || config.router.port);
  config.router.apiKey = process.env.ROUTER_API_KEY ?? config.router.apiKey;

  if (!config.vendors.length) {
    config.vendors = vendorsFromEnvironment();
  }

  config.vendors = config.vendors
    .filter((vendor) => vendor.enabled !== false)
    .map((vendor) => {
      return {
        ...vendor,
        models: normalizeRuntimeVendorModels(vendor, config.model.id),
        timeoutMs: Number(config.router.requestTimeoutMs),
      };
    })
    .filter((vendor) => vendor.models.some((model) => model.enabled !== false));

  validateConfig(config, { configPath });
  return { config, configPath };
}

function normalizeRuntimeVendorModels(vendor, defaultModelId) {
  const models = Array.isArray(vendor.models) ? vendor.models : [];
  if (!models.length) {
    const id = String(vendor.model || defaultModelId || "model-id").trim();
    return [{ id, enabled: true }];
  }

  return models
    .map((model) => ({
      id: String(model.id || defaultModelId || "model-id").trim(),
      enabled: model.enabled !== false,
    }))
    .filter((model) => model.id);
}

function vendorsFromEnvironment() {
  const first = vendorFromEnvironment("VENDOR_A", "vendor-a");
  const second = vendorFromEnvironment("VENDOR_B", "vendor-b");
  return [first, second].filter(Boolean);
}

function vendorFromEnvironment(prefix, fallbackName) {
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (!baseUrl && !apiKey) {
    return null;
  }

  return {
    name: process.env[`${prefix}_NAME`] || fallbackName,
    baseUrl,
    apiKey,
    model: process.env[`${prefix}_MODEL`] || "model-id",
    authentication: apiKey ? "api-key" : "none",
    enabled: true,
  };
}

function createLogger(config) {
  const logFile = config.router.logFile;
  const resolvedLogFile = isAbsolute(logFile) ? logFile : resolve(runtimeRoot, logFile);
  mkdirSync(dirname(resolvedLogFile), { recursive: true });

  const stream = createWriteStream(resolvedLogFile, { flags: "a" });

  return {
    info(event, data = {}) {
      writeLog(stream, "info", event, data);
    },
    warn(event, data = {}) {
      writeLog(stream, "warn", event, data);
    },
    error(event, data = {}) {
      writeLog(stream, "error", event, data);
    },
  };
}

function writeLog(stream, level, event, data) {
  const entry = {
    time: new Date().toISOString(),
    level,
    event,
    ...redact(data),
  };

  const line = JSON.stringify(entry);
  stream.write(`${line}\n`);

  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api[_-]?key|authorization|token|secret/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redact(item);
    }
  }
  return result;
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function getRequestPath(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.pathname.replace(/\/+$/, "") || "/";
}

function isAuthorized(req, config) {
  const expectedKey = config.router.apiKey;
  if (!expectedKey) {
    return true;
  }

  const authorization = req.headers.authorization || "";
  return authorization === `Bearer ${expectedKey}`;
}

async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error(`Request body exceeds maxBodyBytes (${maxBodyBytes}).`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }
}

function buildUpstreamUrl(vendor) {
  const baseUrl = vendor.baseUrl.replace(/\/+$/, "");
  const path = vendor.chatCompletionsPath || "/chat/completions";
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildUpstreamHeaders(vendor) {
  return {
    ...(vendor.apiKey ? { authorization: `Bearer ${vendor.apiKey}` } : {}),
    "content-type": "application/json",
  };
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeout),
  };
}

async function callVendor(vendor, requestBody) {
  const timeout = createTimeoutSignal(vendor.timeoutMs);

  try {
    const body = {
      ...requestBody,
      model: vendor.selectedModel.id,
    };

    const response = await fetch(buildUpstreamUrl(vendor), {
      method: "POST",
      headers: buildUpstreamHeaders(vendor),
      body: JSON.stringify(body),
      signal: timeout.signal,
    });

    return response;
  } finally {
    timeout.cancel();
  }
}

function shouldFallback(statusCode, config) {
  return config.router.fallbackStatusCodes.includes(statusCode) || statusCode >= 500;
}

async function readBoundedText(response, maxBytes = 64 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total <= maxBytes) {
      chunks.push(Buffer.from(value));
    }

    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

function summarizeUpstreamError(statusCode, body) {
  const text = String(body || "").trim();
  let errorType = "upstream_error";

  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.type) {
      errorType = String(parsed.error.type);
    } else if (parsed?.error?.code) {
      errorType = String(parsed.error.code);
    }
  } catch {
    errorType = text ? "upstream_text_error" : "upstream_empty_error";
  }

  return {
    statusCode,
    errorType,
    bodyBytes: Buffer.byteLength(text, "utf8"),
  };
}

function copyUpstreamHeaders(upstream, res, vendorName) {
  for (const [key, value] of upstream.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }
  res.setHeader("x-router-vendor", vendorName);
}

async function pipeUpstream(upstream, res) {
  if (!upstream.body) {
    res.end();
    return;
  }

  await pipeline(Readable.fromWeb(upstream.body), res);
}

async function handleChat(req, res, config, logger) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const requestBody = await readJsonBody(req, config.router.maxBodyBytes);
  const requestedModel = String(requestBody.model || config.model.id).trim() || config.model.id;
  const vendors = getVendorsForModel(config.vendors, requestedModel);
  const failures = [];

  if (!vendors.length) {
    sendJson(res, 404, {
      error: {
        message: `No enabled vendor supports model: ${requestedModel}`,
        type: "model_not_found",
        model: requestedModel,
      },
    });
    return;
  }

  for (const vendor of vendors) {
    const vendorStartedAt = Date.now();

    try {
      logger.info("vendor_request_started", {
        requestId,
        vendor: vendor.name,
        model: requestedModel,
        stream: requestBody.stream === true,
      });

      const upstream = await callVendor(vendor, requestBody);
      const elapsedMs = Date.now() - vendorStartedAt;

      if (!upstream.ok) {
        const errorText = await readBoundedText(upstream);
        const failure = {
          vendor: vendor.name,
          elapsedMs,
          ...summarizeUpstreamError(upstream.status, errorText),
        };
        failures.push(failure);

        logger.warn("vendor_request_failed_status", {
          requestId,
          ...failure,
        });

        if (shouldFallback(upstream.status, config)) {
          continue;
        }

        res.statusCode = upstream.status;
        res.setHeader("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
        res.setHeader("x-router-vendor", vendor.name);
        res.end(errorText);
        return;
      }

      logger.info("vendor_request_selected", {
        requestId,
        vendor: vendor.name,
        model: requestedModel,
        statusCode: upstream.status,
        elapsedMs,
        totalElapsedMs: Date.now() - startedAt,
      });

      res.statusCode = upstream.status;
      copyUpstreamHeaders(upstream, res, vendor.name);
      await pipeUpstream(upstream, res);
      return;
    } catch (error) {
      const failure = {
        vendor: vendor.name,
        elapsedMs: Date.now() - vendorStartedAt,
        errorName: error.name,
        errorMessage: error.message,
      };
      failures.push(failure);

      logger.warn("vendor_request_failed_error", {
        requestId,
        ...failure,
      });
    }
  }

  logger.error("all_vendors_failed", {
    requestId,
    totalElapsedMs: Date.now() - startedAt,
    failures,
  });

  sendJson(res, 502, {
    error: {
      message: "All configured vendors failed before a response could be returned.",
      type: "router_error",
      request_id: requestId,
      failures,
    },
  });
}

function getVendorsForModel(vendors, requestedModel) {
  return vendors.flatMap((vendor) => {
    const selectedModel = vendor.models.find((model) => model.enabled !== false && model.id === requestedModel);
    return selectedModel ? [{ ...vendor, selectedModel }] : [];
  });
}

function handleModels(_req, res, config) {
  const modelIds = [...new Set(config.vendors.flatMap((vendor) => vendor.models
    .filter((model) => model.enabled !== false)
    .map((model) => model.id)))];

  sendJson(res, 200, {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: config.model.ownedBy,
    })),
  });
}

function handleHealth(_req, res, config) {
  sendJson(res, 200, {
    ok: true,
    model: config.model.id,
    vendorCount: config.vendors.length,
    vendors: config.vendors.map((vendor) => ({
      name: vendor.name,
      models: vendor.models.map((model) => ({
        id: model.id,
        enabled: model.enabled !== false,
      })),
      enabled: vendor.enabled !== false,
    })),
  });
}

async function handleRequest(req, res, config, logger) {
  const path = getRequestPath(req);

  try {
    if (!isAuthorized(req, config)) {
      sendJson(res, 401, {
        error: {
          message: "Invalid router API key.",
          type: "authentication_error",
        },
      });
      return;
    }

    if (req.method === "GET" && path === "/health") {
      handleHealth(req, res, config);
      return;
    }

    if (req.method === "GET" && path === "/v1/models") {
      handleModels(req, res, config);
      return;
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      await handleChat(req, res, config, logger);
      return;
    }

    sendJson(res, 404, {
      error: {
        message: `Unsupported route: ${req.method} ${path}`,
        type: "not_found",
      },
    });
  } catch (error) {
    logger.error("request_failed", {
      path,
      method: req.method,
      errorName: error.name,
      errorMessage: error.message,
    });

    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        error: {
          message: error.message,
          type: "router_error",
        },
      });
    } else {
      res.destroy(error);
    }
  }
}

function main() {
  const { config, configPath } = loadConfig();
  const logger = createLogger(config);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, config, logger);
  });

  server.listen(config.router.port, config.router.host, () => {
    logger.info("router_started", {
      host: config.router.host,
      port: config.router.port,
      configPath,
      model: config.model.id,
      vendors: config.vendors.map((vendor) => vendor.name),
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      logger.info("router_stopping", { signal });
      server.close(() => process.exit(0));
    });
  }
}

main();
