#!/usr/bin/env node
/**
 * Generate user-facing release notes with an OpenAI-compatible LLM.
 *
 * Reads the commits since the previous version tag, asks the configured LLM
 * endpoint for user-friendly Chinese release notes, and writes the result to
 * release-notes.md.
 *
 * The script never blocks the release: on any error it writes an empty
 * release-notes.md so the GitHub Release action falls back to its default
 * generated changelog.
 *
 * Environment:
 *   GITHUB_REF_NAME        current release tag (e.g. v0.11.0)
 *   RELEASE_NOTES_API_KEY  bearer token for the LLM endpoint
 *   RELEASE_NOTES_BASE_URL OpenAI-compatible base URL (e.g. http://host:8000/v1)
 *   RELEASE_NOTES_MODEL    model id (default: Qwen3.8-27B)
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUTPUT_FILE = "release-notes.md";
const MAX_COMMITS = 100;
const MAX_BODY_CHARS = 400;
const LLM_TIMEOUT_MS = 300_000;

function env(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function runGit(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function semverTuple(value) {
  return value.split(".").map(Number);
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

function findPreviousTag(tag) {
  const current = tag.replace(/^v/, "");
  if (!isSemver(current)) {
    return "";
  }

  const described = runGit(
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v[0-9]*",
    "--match",
    "[0-9]*",
    "HEAD^",
  ).trim();
  const describedVersion = described.replace(/^v/, "");
  if (isSemver(describedVersion) && compareSemver(semverTuple(describedVersion), semverTuple(current)) < 0) {
    return described;
  }

  for (const line of runGit("tag", "--sort=-v:refname").split(/\r?\n/)) {
    const candidate = line.trim();
    const candidateVersion = candidate.replace(/^v/, "");
    if (isSemver(candidateVersion) && compareSemver(semverTuple(candidateVersion), semverTuple(current)) < 0) {
      return candidate;
    }
  }
  return "";
}

function collectCommits(prevTag) {
  const range = prevTag ? [`${prevTag}..HEAD`] : [];
  const raw = runGit("log", ...range, "--no-decorate", "--pretty=format:@@COMMIT@@%h|%H|%s%n%b");
  const commits = [];
  for (const block of raw.split("@@COMMIT@@")) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }
    const newline = trimmed.indexOf("\n");
    const firstLine = newline === -1 ? trimmed : trimmed.slice(0, newline);
    const body = newline === -1 ? "" : trimmed.slice(newline + 1).trim();
    const parts = firstLine.split("|");
    if (parts.length < 3) {
      continue;
    }
    commits.push({
      hash: parts[0].trim(),
      fullHash: parts[1].trim(),
      subject: parts.slice(2).join("|").trim(),
      body: body.slice(0, MAX_BODY_CHARS),
    });
  }
  return commits.slice(0, MAX_COMMITS);
}

function buildPrompt(version, prevTag, commits, repoUrl) {
  const commitLines = commits.map((commit) => {
    const line = `- hash: ${commit.hash} | subject: ${commit.subject} | link: ${repoUrl}/commit/${commit.fullHash}`;
    return commit.body ? `${line}\n  body: ${commit.body}` : line;
  });

  return `你是一名面向最终用户撰写软件发布说明的编辑。请根据提供的提交记录，为 ${version} 版本撰写一份用户友好的中文 Release Notes（Markdown）。

要求：
1. 只依据提供的提交记录撰写，禁止编造未提供的功能或变更。
2. 面向普通用户：用用户能理解的语言描述变化，不要出现 Angular 类型前缀（feat/fix/chore 等）或内部实现细节。
3. 按提交类型分组，只输出有内容的分组，顺序固定为：
   ## Features
   ## Fixes
   ## Other Changes
   feat 类提交归入 Features；fix、perf 类提交归入 Fixes；其余对用户可见的提交归入 Other Changes。纯文档、测试、构建、版本号提交（如 chore(release)）不单独列出，除非其变化对用户可见。
4. 每条变更一行，格式为：描述文字 ([hash](link))，其中 hash 和 link 必须使用提交记录中提供的值，不要自行拼写链接。
5. 如果存在破坏性变更、需要用户手动操作或数据迁移的事项，在正文最前面加一行以 ⚠️ 开头的说明（不是标题）；没有则不加。
6. 不要输出“下载”区块，不要输出折叠块，不要添加其他顶级标题，不要输出解释性文字。
7. 直接输出 Markdown 正文，不要用代码块包裹整体内容。

当前版本：${version}
上一版本：${prevTag || "无（首个版本）"}

提交记录：
${commitLines.join("\n")}`;
}

async function callLlm(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(`${env("RELEASE_NOTES_BASE_URL").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("RELEASE_NOTES_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env("RELEASE_NOTES_MODEL", "Qwen3.8-27B"),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 4000,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`LLM endpoint returned ${response.status}`);
    }
    const data = await response.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
    return content
      .replace(/^```[a-zA-Z]*\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  } finally {
    clearTimeout(timer);
  }
}

function writeOutput(content) {
  writeFileSync(OUTPUT_FILE, content, "utf8");
}

async function main() {
  const tag = env("GITHUB_REF_NAME");
  const version = tag.replace(/^v/, "") || "unknown";
  const prevTag = findPreviousTag(tag);
  const commits = collectCommits(prevTag);
  const serverUrl = env("GITHUB_SERVER_URL", "https://github.com").replace(/\/+$/, "");
  const repository = env("GITHUB_REPOSITORY", "landfallbox/heimdall");
  const repoUrl = `${serverUrl}/${repository}`;
  console.log(`tag=${tag || "(none)"} previous=${prevTag || "(none)"} commits=${commits.length}`);

  let notes = "";
  const apiKey = env("RELEASE_NOTES_API_KEY");
  const baseUrl = env("RELEASE_NOTES_BASE_URL");
  if (apiKey && baseUrl && commits.length > 0) {
    try {
      notes = await callLlm(buildPrompt(version, prevTag, commits, repoUrl));
      console.log(`LLM generated ${notes.length} characters of release notes.`);
    } catch (error) {
      console.log(`LLM release notes generation failed: ${error.message || String(error)}`);
      notes = "";
    }
  } else {
    console.log("LLM release notes skipped (missing config or no commits).");
  }

  if (!notes) {
    console.log("Writing empty release notes; GitHub will use its default generated changelog.");
  }
  writeOutput(notes);
}

main().catch((error) => {
  console.log(`Unexpected release notes error: ${error.message || String(error)}`);
  try {
    writeOutput("");
  } catch {
    // best effort
  }
  process.exitCode = 1;
});
