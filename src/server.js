import http from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger } from "./logger.js";
import { loadRuntimeConfig, runtimeRoot } from "./runtime-config.js";

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

function isAuthorized(req, config, path) {
  const managementToken = process.env.LOCAL_MODEL_ROUTER_MANAGEMENT_TOKEN;
  if (path === "/health" && managementToken && req.headers["x-router-management-token"] === managementToken) {
    return true;
  }

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
    abort: () => controller.abort(),
    cancel: () => clearTimeout(timeout),
  };
}

function linkClientAbort(req, res, abort) {
  const abortClosedResponse = () => {
    if (!res.writableEnded) {
      abort();
    }
  };
  req.once("aborted", abort);
  res.once("close", abortClosedResponse);
  return () => {
    req.off("aborted", abort);
    res.off("close", abortClosedResponse);
  };
}

async function callVendor(vendor, requestBody, signal) {
  const body = {
    ...requestBody,
    model: vendor.selectedModel.id,
  };

  return fetch(buildUpstreamUrl(vendor), {
    method: "POST",
    headers: buildUpstreamHeaders(vendor),
    body: JSON.stringify(body),
    signal,
  });
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
    const timeout = createTimeoutSignal(vendor.timeoutMs);
    const unlinkClientAbort = linkClientAbort(req, res, timeout.abort);

    try {
      logger.info("vendor_request_started", {
        requestId,
        vendor: vendor.name,
        model: requestedModel,
        stream: requestBody.stream === true,
      });

      const upstream = await callVendor(vendor, requestBody, timeout.signal);
      // requestTimeoutMs limits connection and response-header wait time. Once a
      // vendor responds, long-running streams may continue until completion or
      // until the client disconnects.
      timeout.cancel();
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

      if (req.aborted || res.destroyed) {
        return;
      }

      // Once response bytes are committed, another vendor would corrupt the stream
      // and may duplicate a billable upstream request.
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
    } finally {
      unlinkClientAbort();
      timeout.cancel();
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
    instanceId: process.env.LOCAL_MODEL_ROUTER_INSTANCE_ID || "",
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
    if (!isAuthorized(req, config, path)) {
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
  const { config, configPath } = loadRuntimeConfig();
  const logger = createLogger(config, runtimeRoot);
  let stopping = false;

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

  const stopRouter = (reason) => {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info("router_stopping", { reason });
    server.close(() => {
      logger.close(() => process.exit(0));
    });
    server.closeIdleConnections();
    if (reason === "parent_disconnect") {
      server.closeAllConnections();
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => stopRouter(signal));
  }

  if (typeof process.send === "function") {
    process.on("message", (message) => {
      if (message?.type === "shutdown") {
        stopRouter("parent_request");
      }
    });
    process.on("disconnect", () => stopRouter("parent_disconnect"));
  }
}

main();
