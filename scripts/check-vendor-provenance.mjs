#!/usr/bin/env node
// A0 门禁：codeg 迁入源码的来源与许可证可复验性。
//
// 校验面：
//   1. ORIGIN.md 的 ```json provenance 块可解析，且声明了 source.licenseFile/noticeFile；
//   2. 许可证文本与 NOTICE 存在；
//   3. 每个登记文本文件按 LF 正规化后的 sha256 与 vendor/ 下的实际副本一致；
//   4. vendor/acp/ 下不存在未登记的源码文件（ORIGIN.md 除外）；
//   5. Pylon 自身源码（src-tauri/src）不出现 codeg 产品命名穿透（非注释代码）。
//
// 可选：设置 PYLON_CODEG_SRC=<path>（或默认调研副本存在）时，额外校验锁定 commit
// 与源文件 LF-normalized sha256。CI 无调研副本时跳过该段，只校验仓库内可复验事实。
//
// 用法：node scripts/check-vendor-provenance.mjs [--json]

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import process from "node:process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vendorDir = resolve(root, "src-tauri/vendor/acp");
const originPath = resolve(vendorDir, "ORIGIN.md");
const failures = [];
const notes = [];
const fail = (message) => failures.push(message);

const LOCKED_COMMIT = "b2eec98ce8d082ad48803918dd9a21ab08d1d3d4";
const DEFAULT_CODEG_SRC =
  "F:/Hermes/profiles/riccati/workspace/pylon-survey-2026-09/codeg-src";

function sha256(path) {
  const normalized = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// 1. ORIGIN.md 存在且含机器可读块
if (!existsSync(originPath)) {
  fail(`缺少 ${relative(root, originPath).replaceAll("\\", "/")}`);
}
let manifest = null;
if (existsSync(originPath)) {
  const originText = readFileSync(originPath, "utf8");
  const match = originText.match(/```json provenance\s*\n([\s\S]*?)\n```/);
  if (!match) {
    fail("ORIGIN.md 缺少 ```json provenance 机器可读块");
  } else {
    try {
      manifest = JSON.parse(match[1]);
    } catch (error) {
      fail(`ORIGIN.md provenance 块不是合法 JSON：${error.message}`);
    }
  }
}

// 2. 许可证与 NOTICE
if (manifest) {
  for (const key of ["licenseFile", "noticeFile"]) {
    const declared = manifest.source?.[key];
    if (typeof declared !== "string" || declared.length === 0) {
      fail(`provenance.source.${key} 未声明`);
      continue;
    }
    if (!existsSync(resolve(root, declared)))
      fail(`provenance.source.${key} 指向的文件不存在：${declared}`);
  }
  if (manifest.source?.commit !== LOCKED_COMMIT) {
    fail(
      `provenance.source.commit=${manifest.source?.commit} 与锁定 commit ${LOCKED_COMMIT} 不一致`,
    );
  }
  if (manifest.source?.license !== "Apache-2.0") {
    fail(
      `provenance.source.license 应为 Apache-2.0，实为 ${manifest.source?.license}`,
    );
  }
}

// 3/4. 逐文件 sha256 与未登记文件
const registered = new Set();
if (manifest && Array.isArray(manifest.files)) {
  for (const entry of manifest.files) {
    const vendored = entry?.vendoredPath;
    if (typeof vendored !== "string") {
      fail("provenance.files[] 存在缺少 vendoredPath 的条目");
      continue;
    }
    registered.add(vendored.replaceAll("\\", "/"));
    const absolute = resolve(root, vendored);
    if (!existsSync(absolute)) {
      fail(`登记文件缺失：${vendored}`);
      continue;
    }
    if (sha256(absolute) !== entry.sha256) {
      fail(
        `sha256 不匹配：${vendored}（登记 ${entry.sha256}，实际 ${sha256(absolute)}）`,
      );
    }
    if (typeof entry.sourcePath !== "string" || entry.sourcePath.length === 0) {
      fail(`${vendored} 缺少 sourcePath`);
    }
    if (
      typeof entry.modifications !== "string" ||
      entry.modifications.length === 0
    ) {
      fail(`${vendored} 缺少 modifications（修改摘要）`);
    }
    if (typeof entry.consumer !== "string" || entry.consumer.length === 0) {
      fail(`${vendored} 缺少 consumer（Pylon adapter 落点）`);
    }
    if (!Array.isArray(entry.unmigratedDeps)) {
      fail(`${vendored} 缺少 unmigratedDeps（未迁入依赖列表）`);
    }
  }
}
if (existsSync(vendorDir)) {
  for (const entry of readdirSync(vendorDir)) {
    const absolute = resolve(vendorDir, entry);
    if (statSync(absolute).isDirectory()) {
      fail(`vendor/acp/ 下不允许子目录（未登记内容）：${entry}`);
      continue;
    }
    if (entry === "ORIGIN.md") continue;
    const rel = relative(root, absolute).replaceAll("\\", "/");
    if (!registered.has(rel)) fail(`vendor/acp/${entry} 未在 ORIGIN.md 登记`);
  }
}

// 5. Pylon 源码无 codeg 产品命名穿透（跳过注释）
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
const pylonSrc = resolve(root, "src-tauri/src");
function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".rs")) out.push(path);
  }
  return out;
}
if (existsSync(pylonSrc)) {
  for (const file of walk(pylonSrc, [])) {
    const text = stripComments(readFileSync(file, "utf8"));
    if (/\bcodeg\w*/i.test(text)) {
      fail(
        `Pylon 源码出现 codeg 产品命名：${relative(root, file).replaceAll("\\", "/")}`,
      );
    }
  }
}

// 可选：校验上游调研副本
const codegSrc = process.env.PYLON_CODEG_SRC ?? DEFAULT_CODEG_SRC;
if (manifest && existsSync(codegSrc)) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: codegSrc,
      encoding: "utf8",
    }).trim();
    if (head !== LOCKED_COMMIT)
      fail(`调研副本 HEAD=${head} 与锁定 commit 不一致`);
    for (const entry of manifest.files ?? []) {
      const sourceAbsolute = resolve(codegSrc, entry.sourcePath);
      if (!existsSync(sourceAbsolute)) {
        fail(`调研副本缺少源文件：${entry.sourcePath}`);
        continue;
      }
      if (sha256(sourceAbsolute) !== entry.sha256) {
        fail(`源文件 sha256 不匹配：${entry.sourcePath}`);
      }
    }
  } catch (error) {
    notes.push(`跳过上游副本校验：${error.message}`);
  }
} else if (manifest) {
  notes.push(
    `未找到调研副本 ${codegSrc}，跳过上游 commit/sha256 校验（仓库内事实仍已校验）`,
  );
}

const result = {
  origin: relative(root, originPath).replaceAll("\\", "/"),
  registeredFiles: registered.size,
  upstreamChecked: existsSync(codegSrc),
  failures,
  notes,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
if (failures.length > 0) {
  console.error(`check-vendor-provenance FAILED (${failures.length})`);
  process.exitCode = 1;
}
