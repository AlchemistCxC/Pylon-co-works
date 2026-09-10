#!/usr/bin/env node
// A0/A9：Pylon ACP golden trace 基线生成/校验入口。
//
// 用法：
//   node scripts/generate-acp-golden-trace.mjs           # 重新生成基线并写入 src-tauri/tests/golden-traces/
//   node scripts/generate-acp-golden-trace.mjs --check   # 只校验：连跑两遍须逐字节一致，且与已提交基线一致
//
// 生成器本体是 test-only 的 Rust 测试（src-tauri/src/acp/golden_trace_tests.rs），
// 由 PYLON_GOLDEN_TRACE_DIR 环境变量启用；本脚本负责两次运行的确定性比对与落盘。

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import process from "node:process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const crateDir = resolve(root, "src-tauri");
const baselineDir = resolve(crateDir, "tests/golden-traces");
const checkOnly = process.argv.includes("--check");
const SCENARIOS = [
  "initialize",
  "new_load",
  "prompt",
  "tool",
  "permission",
  "done_error",
  "cancel",
  "reconnect",
];

function generateInto(dir) {
  rmSync(dir, { recursive: true, force: true });
  const result = spawnSync(
    "cargo",
    [
      "test",
      "--lib",
      "acp::golden_trace_tests::golden_trace_baseline_generation",
      "--no-fail-fast",
      "--",
      "--exact",
    ],
    {
      cwd: crateDir,
      env: { ...process.env, PYLON_GOLDEN_TRACE_DIR: dir },
      encoding: "utf8",
      shell: true,
    },
  );
  if (result.status !== 0) {
    console.error(result.stdout ?? "");
    console.error(result.stderr ?? "");
    throw new Error(`golden trace generation failed (exit ${result.status})`);
  }
  for (const scenario of SCENARIOS) {
    const file = resolve(dir, `${scenario}.jsonl`);
    if (!existsSync(file))
      throw new Error(`generator did not produce ${scenario}.jsonl`);
    if (readFileSync(file, "utf8").trim().length === 0) {
      throw new Error(`generated ${scenario}.jsonl is empty`);
    }
  }
}

/** 比较前统一换行：
 *  Windows 检出（`.gitattributes` 的 `text=auto`）会把基线读成 CRLF，而生成器恒写 LF；
 *  这是行尾差异而非内容差异。本仓 `core.autocrlf=false`，故统一为 LF 后做逐字节比较。
 *  根治在 `.gitattributes` 的 `*.jsonl text eol=lf`；此处的归一化是对既有检出的兼容。 */
function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n");
}

function compareDirs(left, right, label) {
  const leftFiles = readdirSync(left)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const rightFiles = readdirSync(right)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  if (leftFiles.join() !== rightFiles.join()) {
    throw new Error(
      `${label}: 文件集合不一致\n  ${leftFiles.join()}\n  ${rightFiles.join()}`,
    );
  }
  for (const name of leftFiles) {
    const a = normalizeEol(readFileSync(resolve(left, name), "utf8"));
    const b = normalizeEol(readFileSync(resolve(right, name), "utf8"));
    if (a !== b) throw new Error(`${label}: ${name} 内容不一致`);
  }
  return leftFiles;
}

const runA = mkdtempSync(resolve(tmpdir(), "pylon-golden-a-"));
const runB = mkdtempSync(resolve(tmpdir(), "pylon-golden-b-"));
let files;
try {
  generateInto(runA);
  generateInto(runB);
  files = compareDirs(runA, runB, "确定性校验");
  if (checkOnly) {
    if (!existsSync(baselineDir))
      throw new Error(`缺少已提交基线目录：${relative(root, baselineDir)}`);
    compareDirs(runA, baselineDir, "基线校验");
  } else {
    // 只替换生成的 JSONL，保留目录内的 README 等 provenance 文档。
    mkdirSync(baselineDir, { recursive: true });
    for (const name of readdirSync(baselineDir)) {
      if (name.endsWith(".jsonl")) rmSync(resolve(baselineDir, name), { force: true });
    }
    for (const name of files)
      cpSync(resolve(runA, name), resolve(baselineDir, name));
  }
} finally {
  rmSync(runA, { recursive: true, force: true });
  rmSync(runB, { recursive: true, force: true });
}

const summary = {
  mode: checkOnly ? "check" : "write",
  scenarios: files.length,
  baselineDir: relative(root, baselineDir).replaceAll("\\", "/"),
  deterministic: true,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}
`);
if (files.length !== SCENARIOS.length) {
  console.error(`expected ${SCENARIOS.length} scenarios, got ${files.length}`);
  process.exitCode = 1;
}
