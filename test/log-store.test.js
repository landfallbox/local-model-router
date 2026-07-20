import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLogPage } from "../gui/electron/log-store.js";

const tempDirectory = mkdtempSync(join(tmpdir(), "local-router-log-test-"));
const logPath = join(tempDirectory, "router.log");
const expected = Array.from({ length: 240 }, (_, index) => `${index.toString().padStart(3, "0")}:${"x".repeat(400)}`);

try {
  writeFileSync(logPath, `${expected.join("\n")}\n`, "utf8");
  const collected = [];
  let before = null;

  do {
    const page = await readLogPage(logPath, { limit: 37, before });
    collected.unshift(...page.lines);
    before = page.nextBefore;
  } while (before !== null);

  assert.deepEqual(collected, expected);
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

console.log("log store tests passed");