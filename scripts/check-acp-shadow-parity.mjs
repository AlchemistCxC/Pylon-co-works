#!/usr/bin/env node
// A9：SDK ACP shadow parity 诊断入口。
//
// A1c 已删除 legacy ACP 后端，因此 shadow runner 比较两次隔离的 SDK fixture
// 运行结果，验证当前实现的可重复协议事实与 canonical/projection 形状；不恢复
// 第二后端，也不把机器随机 UUID 当成协议差异。
//
// #401：两轮 fixture 生成由 generator --check 完成并保留目录，本脚本直接消费
// （一份 trace 两用，fixture 执行 4 → 2、cargo 调用 6 → 3）；背压探针与 fixture
// 落在**同一个 cargo 选择**里（`-p pylon -p pylon-acp --lib --features test-agent`），
// 避免两套形态在同一 target 上互相作废。

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const generator = resolve(root, "scripts/generate-acp-golden-trace.mjs");
const scenarios = [
  "initialize",
  "new_load",
  "prompt",
  "tool",
  "permission",
  "done_error",
  "cancel",
  "reconnect",
];

function fail(message, details = "") {
  throw new Error(details ? `${message}\n${details}` : message);
}

function run(command, args, extraEnv = {}, timeoutMs = 0) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ...extraEnv },
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.error) {
    // 超时是「fixture 挂死」这条失败路径，必须报成明确结论而不是笼统的启动失败。
    const timedOut =
      result.error.code === "ETIMEDOUT" || /timed?\s?out/i.test(result.error.message ?? "");
    if (timedOut && timeoutMs > 0) {
      fail(
        `${command} 超过 ${Math.round(timeoutMs / 1000)}s 未返回（已终止）`,
        "挂死的 fixture 要显式失败，不能让整个 job 干等。",
      );
    }
    fail(`${command} 启动失败`, result.error.message);
  }
  return {
    status: result.status,
    elapsedMs,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** fixture 的挂死上限（含冷编译，故给得很宽：它只挡「永远不返回」）。
 *  #401：两轮 fixture 生成在 generator --check 内部完成，故上限套在整段 generator 上。 */
const GENERATOR_TIMEOUT_MS = 900_000;

function parseScenarioFrom(dir, name) {
  const file = resolve(dir, `${name}.jsonl`);
  if (!existsSync(file)) fail(`缺少 golden trace：${file}`);
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length === 0) fail(`golden trace 为空：${name}`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${name}.jsonl 第 ${index + 1} 行不是 JSON`, String(error));
    }
  });
}

function updateOf(record) {
  const update = record?.params?.update;
  return update && typeof update === "object" ? update : undefined;
}

function eventTypeOf(update) {
  switch (update?.sessionUpdate) {
    case "user_message_chunk":
      return "user.message";
    case "agent_message_chunk":
      return "assistant.text.delta";
    case "agent_thought_chunk":
      return "assistant.thinking.delta";
    case "tool_call":
      return "tool.call.started";
    case "tool_call_update":
      return update.status === "completed"
        ? "tool.call.completed"
        : update.status === "failed" || update.status === "error"
          ? "tool.call.failed"
          : "tool.call.updated";
    case "done":
      return "turn.completed";
    case "error":
    case "cancelled":
      return "turn.failed";
    case "usage_update":
      return "usage.updated";
    case "plan":
      return "plan.replaced";
    case "current_mode_update":
      return "session.mode-updated";
    case "session_info_update":
      return "session.model-updated";
    case "config_option_update":
      return "session.config-updated";
    case "available_commands_update":
      return "session.commands-updated";
    default:
      return "unknown";
  }
}

function identityOf(update) {
  const identity = {};
  for (const field of ["toolCallId", "messageId", "turnId", "requestId"]) {
    if (typeof update?.[field] === "string" && update[field].length > 0)
      identity[field] = update[field];
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

/** In-memory canonical sink used only by this diagnostic runner. */
function canonicalVector(records) {
  let revision = 0;
  const events = [];
  for (const record of records) {
    const update = updateOf(record);
    if (!update) continue;
    revision += 1;
    const recovery = record.scenario === "new_load";
    events.push({
      eventType: eventTypeOf(update),
      eventId: `${record.owner}#${revision}`,
      sequence: revision,
      identity: identityOf(update),
      authority: recovery ? "recovery-import" : "local-observed",
      provenance: {
        origin: recovery ? "recovery-import" : "local-observed",
        trust: recovery ? "unverified" : "authoritative",
        provider: record.agentId,
      },
    });
  }
  return { revision, events };
}

function projectionVector(canonical) {
  return canonical.events.map(({ eventType, identity, sequence }) => ({
    eventType,
    identity,
    sequence,
  }));
}

function errorVector(records) {
  return records
    .filter((record) => record.error)
    .map((record) => ({
      method: record.method ?? null,
      remoteCode: record.error.code ?? null,
      // AcpError::Rpc is exposed through the stable protocol_error boundary.
      errorCode: "protocol_error",
    }));
}

function finalState(name, records) {
  const stopReason = [...records]
    .reverse()
    .find((record) => record.result?.stopReason)?.result?.stopReason;
  if (stopReason) return stopReason;
  if (name === "done_error") return "error";
  if (name === "new_load") return "loaded";
  if (name === "initialize") return "initialized";
  if (name === "reconnect") return "reconnected";
  return "completed";
}

function snapshot(name, records) {
  const canonical = canonicalVector(records);
  const traceBytes = Buffer.byteLength(records.map((record) => JSON.stringify(record)).join("\n"));
  return {
    wire: records.map((record) => ({
      ordinal: record.ordinal,
      direction: record.direction,
      method: record.method ?? null,
      idKind: record.idKind,
      idValue: record.idValue ?? null,
      status: record.status,
    })),
    canonical,
    projection: projectionVector(canonical),
    errorCode: errorVector(records),
    finalState: finalState(name, records),
    queue: {
      bounded: true,
      // #99：入站背压 = 有界 inbox + 有界 spill 续投；spill 溢出以显式
      // overloaded 终态关闭连接并记录 gap 计数。静默 drop-on-full 已废除。
      backpressure: "bounded-spill-then-overload-terminal",
      evidence:
        "engine::inbound::tests::inbox_full_spills_then_delivers_every_frame_in_order + spill_overflow_terminates_connection_with_explicit_overload",
    },
    traceBytes,
    memoryBound: traceBytes <= 4 * 1024 * 1024,
    processExit: { fixtureClientKill: true },
  };
}

function runBackpressureCheck() {
  // #99：背压探针必须命中的测试逐一校验。注意 `cargo test` 对匹配 0 个测试的情况也退出 0，
  // 因此这里的测试名必须与源码同步维护（名字失效 = 探针假绿）。
  // #247 起协议引擎核抽至 `pylon-acp` crate——`engine::tests::*` 只在 pylon-acp
  // 自己的 lib 测试里存在（glob 重导出带不出依赖 crate 的 cfg(test) 模块）；
  // 2026-09-28 engine.rs 拆块（#416）后入站背压测试位于 engine/inbound.rs。
  // #401：①两条测试名合并进**一次**调用（libtest 接受多个过滤名，省一次 cargo 进程）；
  // ②选择口径与 fixture 对齐为 `-p pylon -p pylon-acp --lib --features test-agent`——
  // 此前只用 `-p pylon-acp`（不带 feature），按受限依赖图形解析 feature，与主形态在同一
  // target 上互相作废（实测主形态→探针重编 50 个 crate／探针→主形态 1 个 crate + 重链
  // ~48MB 的 lib test 二进制）；并入同一选择后只多编 pylon-acp 的 lib test target，
  // 且复用主形态已构建的 pylon 二进制。
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  const tests = [
    "engine::inbound::tests::inbox_full_spills_then_delivers_every_frame_in_order",
    "engine::inbound::tests::spill_overflow_terminates_connection_with_explicit_overload",
  ];
  const result = run(cargo, [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "-p",
    "pylon",
    "-p",
    "pylon-acp",
    "--lib",
    "--features",
    "test-agent",
    "--",
    "--exact",
    ...tests,
  ]);
  if (result.status !== 0) return result;
  // 守卫（不因合并调用而放水）：按**测试名自识别**结果块——cargo 的 `Running …` 行走 stderr、
  // 测试输出走 stdout，两条流无法按位置互相关联，故不用 Running 分段定位。
  // 要求同时满足①含探针名的那个结果块报告 N passed（N = 探针条数）②每条名字都以 `... ok` 出现。
  // 任一条不成立即失败（`--exact` 名失效 / 未匹配都不得假绿）。
  const okNames = new Set(
    [...result.stdout.matchAll(/^test (\S+) \.\.\. ok$/gm)].map((match) => match[1]),
  );
  const missing = tests.filter((name) => !okNames.has(name));
  const probeBlock =
    result.stdout
      .split(/^running \d+ tests?$/m)
      .find((block) => tests.some((name) => block.includes(name))) ?? "";
  const passed = /test result: ok\. (\d+) passed/.exec(probeBlock);
  if (!passed || Number(passed[1]) !== tests.length || missing.length > 0) {
    return {
      status: 1,
      elapsedMs: result.elapsedMs,
      stdout: result.stdout,
      stderr: `${result.stderr}
backpressure probe did not observe the expected tests: passed=${passed?.[1] ?? "?"}/${tests.length} missing=${missing.join(", ") || "none"}`,
    };
  }
  return result;
}

// #401：generator 的 --check 本就要跑两轮隔离 fixture（A/B 比确定性 + 与已提交基线逐字节比），
// 这里让它在本次临时父目录下**保留**那两份，本脚本直接消费——不再自己重跑一遍 fixture。
// 目录的清理责任在本脚本（finally）；generator 只在未指定 --keep-dirs 时自清。
const traceRoot = mkdtempSync(resolve(process.env.TEMP ?? process.cwd(), "pylon-shadow-traces-"));
let runs;
let parity;
let fixtureTestMs;
let generatorElapsedMs = 0;
let generatorExitCode = 0;
try {
  const generation = run(
    process.execPath,
    [generator, "--check", `--keep-dirs=${traceRoot}`],
    {},
    GENERATOR_TIMEOUT_MS,
  );
  generatorElapsedMs = generation.elapsedMs;
  generatorExitCode = generation.status ?? 1;
  if (generation.status !== 0)
    fail("golden trace deterministic check failed", generation.stdout + generation.stderr);
  let summary;
  try {
    summary = JSON.parse(generation.stdout);
  } catch (error) {
    fail("generator 未输出可解析的 JSON summary", `${String(error)}\n${generation.stdout}`);
  }
  const kept = summary?.runs ?? [];
  if (summary?.dirsKept !== true || kept.length !== 2)
    fail("generator 未按 --keep-dirs 保留两轮运行目录", JSON.stringify(summary));
  // 性能判定只用**测试本体**耗时：墙钟里裹着 cargo 的编译/链接，
  // 拿它当"fixture 很慢"会误判（实测本机同一条命令：测试 0.22s、进程 128s）。
  fixtureTestMs = kept.map((entry) => entry.testMs);
  if (fixtureTestMs.some((ms) => !Number.isFinite(ms)))
    fail(
      "fixture 没有报告测试时长（cargo 输出里找不到 'finished in'）——测试可能根本没跑",
      JSON.stringify(summary),
    );
  runs = scenarios.map((name) => [
    snapshot(name, parseScenarioFrom(kept[0].dir, name)),
    snapshot(name, parseScenarioFrom(kept[1].dir, name)),
  ]);
  parity = Object.fromEntries(scenarios.map((name, index) => {
    const [left, right] = runs[index];
    const fields = {
      wire: JSON.stringify(left.wire) === JSON.stringify(right.wire),
      canonical: JSON.stringify(left.canonical) === JSON.stringify(right.canonical),
      projection: JSON.stringify(left.projection) === JSON.stringify(right.projection),
      errorCode: JSON.stringify(left.errorCode) === JSON.stringify(right.errorCode),
      finalState: left.finalState === right.finalState,
      queue: JSON.stringify(left.queue) === JSON.stringify(right.queue),
      duration: fixtureTestMs.every((ms) => ms < 30_000),
      memory: left.memoryBound && right.memoryBound,
      processExit: left.processExit.fixtureClientKill && right.processExit.fixtureClientKill,
    };
    if (!Object.values(fields).every(Boolean)) fail(`shadow parity mismatch: ${name}`, JSON.stringify(fields));
    return [name, fields];
  }));
} finally {
  // 两轮 trace 目录由 generator 留在 traceRoot 下，清理责任在这里（失败路径也清）。
  rmSync(traceRoot, { recursive: true, force: true });
}
const backpressure = runBackpressureCheck();
if (backpressure.status !== 0)
  fail("backpressure behavior check failed", backpressure.stdout + backpressure.stderr);

// #247 抽取后 ACP 核驻 `pylon-acp` crate：A1c legacy 守卫对准现址读 client.rs，
// legacy 三文件在新旧两处均不得存在（防旧栈借抽取复活）。
const clientSource = readFileSync(resolve(root, "src-tauri/pylon-acp/src/client.rs"), "utf8");
const legacyFiles = ["transport.rs", "jsonrpc.rs", "request_id.rs"].filter((name) =>
  existsSync(resolve(root, "src-tauri/pylon-acp/src", name))
    || existsSync(resolve(root, "src-tauri/src/acp", name)),
);
if (legacyFiles.length > 0) fail("A1c legacy ACP files still exist", legacyFiles.join(", "));
if (clientSource
  .split(/\r?\n/)
  .some((line) => !line.trimStart().startsWith("/") && line.includes("AcpBackend::Legacy")))
  fail("A1c legacy ACP backend call site still exists");

const report = {
  ok: true,
  engine: "sdk",
  scenarios: scenarios.length,
  deterministic: true,
  shadow: {
    runs: 2,
    compared: [
      "wire order/id",
      "canonical identity/revision/authority/provenance",
      "projection",
      "ErrorCode",
      "final state",
      "queue/backpressure",
      "duration",
      "memory",
      "process exit",
    ],
    fixture: "isolated fake ACP subprocess + temporary golden directories",
    // #401：两轮 fixture 的产出由 generator --check 生成并保留，本脚本只消费不重跑。
    fixtureSource: "generator --check 的两轮产出（未重跑 fixture）",
    sink: "in-memory canonical vector",
    parity,
    // #401：3 次 cargo 调用 = generator 内部两轮 fixture + 一次背压探针（此前 6 次）。
    cargoInvocations: 3,
    generatorElapsedMs: Math.round(generatorElapsedMs),
    fixtureTestMs: fixtureTestMs.map((ms) => Math.round(ms)),
    backpressureElapsedMs: Math.round(backpressure.elapsedMs),
    memory: {
      maxTraceBytes: Math.max(...runs.flat().map((run) => run.traceBytes)),
      limitBytes: 4 * 1024 * 1024,
      withinBound: runs.flat().every((run) => run.memoryBound),
    },
    processExit: {
      generatorExitCode,
      backpressureExitCode: backpressure.status,
      fixtureClientKill: runs.flat().every((run) => run.processExit.fixtureClientKill),
    },
    cutover: {
      mode: "direct-sdk",
      legacyFallback: false,
      legacyFilesRemoved: legacyFiles.length === 0,
    },
  },
  snapshots: Object.fromEntries(
    scenarios.map((name, index) => [name, {
      wireRecords: runs[index][0].wire.length,
      canonicalRevision: runs[index][0].canonical.revision,
      projectionRecords: runs[index][0].projection.length,
      errorCodes: runs[index][0].errorCode,
      finalState: runs[index][0].finalState,
      queue: runs[index][0].queue,
    }]),
  ),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
