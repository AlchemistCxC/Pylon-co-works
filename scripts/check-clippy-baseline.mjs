#!/usr/bin/env node
// P60 施工书 §5.2 门禁：clippy「相对基线零新增」。
//
// 用法（与 v2 同名同参数，保持 §5.2 既有调用不破）：
//   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --message-format=json > clippy.json
//   node scripts/check-clippy-baseline.mjs clippy.json artifacts/clippy-baseline.json
//
// 可选参数（子 crate 纳入同一份基线时必须给出）：
//   --crate=<label>     该份 clippy 输出所属 crate 名，默认 "pylon"
//   --crate-dir=<dir>   该 crate 根目录（clippy 诊断里的文件路径相对它生成），默认 "src-tauri"
//
//   cd src-tauri
//   cargo clippy --manifest-path pylon-core/Cargo.toml --all-targets --message-format=json > ../artifacts/clippy-pylon-core.json
//   node ../scripts/check-clippy-baseline.mjs ../artifacts/clippy-pylon-core.json ../artifacts/clippy-baseline.json --crate=pylon-core --crate-dir=pylon-core
//
//   ⚠️ 不要用 `cargo clippy -p pylon-core`（从 src-tauri 起跑）：实测静默返回 0 警告，
//      path 依赖即便 `-p` 指名也只被当作依赖编译，lint 不会上报。必须 --manifest-path。
//
// 语义：
//   - 基线文件不存在 → 写入当前诊断作为基线，退出 0（首次建立基线）；
//   - 基线存在 → 判定「本片新增」，退出 1。消失/减少只作为 info 报告。
//   - `--write` → 显式重建基线（唯一允许覆盖基线的入口；重建前应先确认 added 为空）。
//
// 指纹 = crate | code | 仓库相对文件 | 诊断消息（不含行号/列号，避免无关行位移造成噪声）。
//
// v3 相比 v2 的两处收紧（只增判红能力，不减）：
//   1. 指纹带 **crate 限定**，不同 crate 的同形相对路径不再互相碰撞；
//   2. 每个指纹记 **计数**（= 该指纹下不同 (文件,行) 的个数，跨 lib/test target 去重），
//      而不只是「存在与否」。v2 的同文件同消息重复诊断会被集合压成一个指纹，
//      导致「同一文件里再加一处同类诊断」被判绿；v3 会判红。
//
// 遗留的已知局限：指纹仍不含函数/符号名，只按「计数」兜住同文件重复；
// 若同文件内两处诊断互换（删一处、加一处），计数不变，门禁不会报——此时靠
// 行号 diff 与评审兜底。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import process from "node:process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// v2 基线最多只收录过主 crate，其文件路径均相对 src-tauri。
const V2_CRATE_DIR = "src-tauri";
const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const arg of argv) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (match) flags.set(match[1], match[2] ?? true);
  else positional.push(arg);
}
const [clippyPath, baselinePath] = positional;
const crate = flags.get("crate") ?? "pylon";
const crateDir = flags.get("crate-dir") ?? "src-tauri";
const write = flags.get("write") === true || flags.get("write") === "true";

if (!clippyPath || !baselinePath) {
  console.error(
    "usage: node scripts/check-clippy-baseline.mjs <clippy.json> <baseline.json> [--crate=name] [--crate-dir=dir] [--write]",
  );
  process.exit(2);
}

/** clippy 诊断里的文件路径相对 crate 根生成，统一折算成仓库相对路径。 */
const toRepoRelative = (fileName) => {
  const absolute = isAbsolute(fileName)
    ? fileName
    : resolve(root, crateDir, fileName);
  return relative(root, absolute).replaceAll("\\", "/");
};

// ── 当前诊断：指纹 → 该指纹下不同 (文件, 行) 的集合 ───────────────────────────
// 同一诊断会在 lib 与 test target 各报一次，按 (文件, 行) 去重后即为「真实出现处数」。
const occurrences = new Map();
for (const line of readFileSync(resolve(root, clippyPath), "utf8").split(
  "\n",
)) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) continue;
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    continue;
  }
  const message = payload?.message;
  if (!message || (message.level !== "error" && message.level !== "warning"))
    continue;
  const code = message.code?.code ?? `rustc-${message.level}`;
  const span = message.spans?.[0];
  const file = span?.file_name ? toRepoRelative(span.file_name) : "<unknown>";
  const fingerprint = `${crate} | ${code} | ${file} | ${message.message}`;
  if (!occurrences.has(fingerprint)) occurrences.set(fingerprint, new Set());
  occurrences.get(fingerprint).add(`${file}:${span?.line_start ?? 0}`);
}
const counts = new Map(
  [...occurrences].map(([fingerprint, sites]) => [fingerprint, sites.size]),
);

const absoluteBaseline = resolve(root, baselinePath);
/**
 * 写入基线。多 crate 共用一份基线，所以 `--write` 是**按 crate 合并**：
 * 只替换本次 crate 的条目，其余 crate 的条目原样保留。否则逐个 crate
 * `--write` 会互相覆盖，最后只剩一个 crate。
 * v2/v1 基线只含过主 crate，不可合并，直接重建。
 */
const writeBaseline = (note) => {
  const mergable = (() => {
    if (!existsSync(absoluteBaseline)) return new Map();
    try {
      const prev = JSON.parse(readFileSync(absoluteBaseline, "utf8"));
      if (prev.version !== 3 || !prev.counts) return new Map();
      const kept = new Map();
      for (const [key, count] of Object.entries(prev.counts)) {
        if (key.slice(0, key.indexOf(" | ")) === crate) continue;
        kept.set(key, count);
      }
      return kept;
    } catch {
      return new Map();
    }
  })();

  const merged = new Map(mergable);
  for (const [fingerprint, count] of counts) merged.set(fingerprint, count);
  const entries = [...merged].sort(([a], [b]) => a.localeCompare(b));
  const crates = [
    ...new Set(entries.map(([key]) => key.slice(0, key.indexOf(" | ")))),
  ].sort();

  mkdirSync(dirname(absoluteBaseline), { recursive: true });
  writeFileSync(
    absoluteBaseline,
    `${JSON.stringify(
      {
        version: 3,
        note,
        counts: Object.fromEntries(entries),
        crates,
      },
      null,
      2,
    )}\n`,
  );
  return { merged: entries.length, fromOtherCrates: mergable.size, crates };
};

if (write || !existsSync(absoluteBaseline)) {
  const written = writeBaseline(
    "P60 clippy baseline v3 (relative: zero new diagnostics; fingerprint carries crate + occurrence count)",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: write ? "rewrite" : "write",
        baseline: baselinePath,
        crate,
        current: counts.size,
        occurrences: [...counts.values()].reduce((sum, n) => sum + n, 0),
        keptFromOtherCrates: written.fromOtherCrates,
        baselineTotal: written.merged,
        crates: written.crates,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

// ── 基线读取（v3 计数表；兼容 v2 数组与 v1 counts） ──────────────────────────
const baseline = (() => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absoluteBaseline, "utf8"));
  } catch (error) {
    console.error(
      `clippy baseline is not valid JSON: ${absoluteBaseline}\n${error.message}`,
    );
    process.exit(2);
  }

  if (parsed.version === 3 && parsed.counts) return new Map(Object.entries(parsed.counts));

  // v2/v1：无 crate 限定，且只记「存在与否」。历史上该基线只收录过 pylon 主 crate。
  if (crate !== "pylon") {
    console.error(
      `baseline at ${baselinePath} is version ${parsed.version ?? 1} (pylon-only) but this run is crate "${crate}".\n` +
        `Rebuild the baseline with --write after the multi-crate scan; refusing to compare across versions.`,
    );
    process.exit(2);
  }
  const legacy = Array.isArray(parsed.diagnostics)
    ? parsed.diagnostics
    : Object.keys(parsed.counts ?? {});
  const migrated = new Map();
  const seeded = [];
  for (const fingerprint of legacy) {
    // v2 指纹 = `code | crate 相对文件 | 消息`；v3 = `crate | code | 仓库相对文件 | 消息`。
    // 迁移需同时补 crate 前缀与 src-tauri/ 路径基。按前两个 " | " 切分，
    // 不假设消息里没有 " | "。
    const first = fingerprint.indexOf(" | ");
    const second = fingerprint.indexOf(" | ", first + 3);
    if (first < 0 || second < 0) {
      migrated.set(fingerprint, 1);
      continue;
    }
    const code = fingerprint.slice(0, first);
    const file = fingerprint.slice(first + 3, second);
    const message = fingerprint.slice(second + 3);
    const repoFile = file.startsWith("<")
      ? file
      : `${V2_CRATE_DIR}/${file}`.replace(/\/\/+/g, "/");
    const key = `${crate} | ${code} | ${repoFile} | ${message}`;
    // v2 只有「存在」语义，没有计数。迁移时用当前观测到的处数做种子，
    // 否则既有重复诊断会在首次迁移时被误判为「新增」。种子动作逐条打印，可复核。
    const observed = counts.get(key) ?? 0;
    if (observed > 1) seeded.push({ fingerprint: key, count: observed });
    migrated.set(key, observed > 0 ? observed : 1);
  }
  if (seeded.length > 0) {
    console.error(
      `note: migrated ${legacy.length} v2 fingerprint(s) to v3 counts; ` +
        `${seeded.length} had >1 occurrence site and were seeded from the current run:`,
    );
    for (const { fingerprint, count } of seeded) {
      console.error(`  - ${count}× ${fingerprint}`);
    }
  }
  return migrated;
})();

// ── 比较 ─────────────────────────────────────────────────────────────────────
// 基线是四个 crate 共用的，本次只能与本 crate 的条目比：其它 crate 的条目
// 不属本次运行，既不是「消失」也不是「新增」。
const ownerOf = (key) => key.slice(0, key.indexOf(" | "));
const scoped = new Map([...baseline].filter(([key]) => ownerOf(key) === crate));

const added = [];
for (const [fingerprint, count] of counts) {
  const base = scoped.get(fingerprint);
  if (base === undefined) added.push({ fingerprint, reason: "new-fingerprint", count });
  else if (count > base)
    added.push({ fingerprint, reason: "more-occurrences", baseline: base, count });
}
const removed = [...scoped.keys()].filter((key) => !counts.has(key));
const reduced = [];
for (const [fingerprint, base] of scoped) {
  const count = counts.get(fingerprint);
  if (count !== undefined && count < base)
    reduced.push({ fingerprint, baseline: base, count });
}

process.stdout.write(
  `${JSON.stringify(
    {
      mode: "check",
      baseline: baselinePath,
      crate,
      current: counts.size,
      occurrenceSites: [...counts.values()].reduce((sum, n) => sum + n, 0),
      baselineCount: baseline.size,
      baselineSites: [...baseline.values()].reduce((sum, n) => sum + n, 0),
      scopedBaselineCount: scoped.size,
      added,
      removed,
      reduced,
    },
    null,
    2,
  )}\n`,
);
if (added.length > 0) {
  console.error(
    `check-clippy-baseline FAILED: ${added.length} new diagnostic(s) in crate ${crate}`,
  );
  process.exitCode = 1;
}
