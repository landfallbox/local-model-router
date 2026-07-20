import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config.js";

export function resolveLogPath(config, dataDirectory) {
  const logFile = config.router?.logFile || DEFAULT_CONFIG.router.logFile;
  return isAbsolute(logFile) ? logFile : join(dataDirectory, logFile);
}

export async function ensureLogFile(logPath) {
  await fs.mkdir(dirname(logPath), { recursive: true });
  if (!existsSync(logPath)) {
    await fs.writeFile(logPath, "", "utf8");
  }
}

export async function readLogPage(logPath, { limit, before }) {
  const handle = await fs.open(logPath, "r");
  try {
    const stat = await handle.stat();
    const end = before === null ? stat.size : Math.min(before, stat.size);
    const page = await readLinesBefore(handle, end, limit);
    return {
      path: logPath,
      lines: page.lines,
      nextBefore: page.start > 0 ? page.start : null,
      hasMore: page.start > 0,
    };
  } finally {
    await handle.close();
  }
}

async function readLinesBefore(handle, end, limit) {
  const chunks = [];
  let position = end;
  let lineBreaks = 0;
  const chunkSize = 16 * 1024;

  while (position > 0 && lineBreaks <= limit) {
    const length = Math.min(chunkSize, position);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, position);
    chunks.unshift(buffer);
    for (const byte of buffer) {
      if (byte === 10) {
        lineBreaks += 1;
      }
    }
  }

  const buffer = Buffer.concat(chunks);
  const text = buffer.toString("utf8");
  const lineStarts = [0];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 10) {
      lineStarts.push(index + 1);
    }
  }

  const entries = text.split(/\r?\n/).filter(Boolean);
  const lines = entries.slice(-limit);
  const firstSelectedIndex = Math.max(0, entries.length - lines.length);
  return {
    lines,
    start: position + (lineStarts[firstSelectedIndex] || 0),
  };
}