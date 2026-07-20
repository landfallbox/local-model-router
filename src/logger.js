import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isPlainObject } from "./config.js";

/** Creates the process logger. Sensitive fields are redacted recursively before serialization. */
export function createLogger(config, runtimeRoot) {
  const logFile = config.router.logFile;
  const resolvedLogFile = isAbsolute(logFile) ? logFile : resolve(runtimeRoot, logFile);
  mkdirSync(dirname(resolvedLogFile), { recursive: true });

  const stream = createWriteStream(resolvedLogFile, { flags: "a" });
  stream.on("error", (error) => {
    console.error(JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      event: "log_stream_failed",
      errorMessage: error.message,
    }));
  });

  return {
    info: (event, data = {}) => writeLog(stream, "info", event, data),
    warn: (event, data = {}) => writeLog(stream, "warn", event, data),
    error: (event, data = {}) => writeLog(stream, "error", event, data),
    close: (callback) => stream.end(callback),
  };
}

function writeLog(stream, level, event, data) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...redact(data),
  });
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
    result[key] = /api[_-]?key|authorization|token|secret/i.test(key) ? "[redacted]" : redact(item);
  }
  return result;
}