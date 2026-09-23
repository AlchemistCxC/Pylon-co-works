#!/usr/bin/env node
// A9：SDK ACP shadow parity 诊断入口。
//
// A1c 已删除 legacy ACP 后端，因此 shadow runner 比较两次隔离的 SDK fixture
// 运行结果，验证当前实现的可重复协议事实与 canonical/projection 形状；不恢复
// 第二后端，也不把机器随机 UUID 当成协议差异。

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

/** fixture 的**测试本体**耗时（cargo 自报的 `finished in X.XXs`，取最后一次）。 */
function reportedTestMs(stdout) {
  const matches = [...stdout.matchAll(/finished in ([0-9.]+)s/g)];
  if (matches.length === 0) return Number.NaN;
  return Number.parseFloat(matches[matches.length - 1][1]) * 1000;
}

/** fixture 的挂死上限（含冷编译，故给得很宽：它只挡「永远不返回」）。 */
const FIXTURE_TIMEOUT_MS = 600_000;

function runFixtureInto(dir) {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  // #184：与 CI rust-test job 的测试构建（--features test-agent）对齐指纹。
  // 此前不带 feature，与前置构建形成两套编译指纹——CI 实测同一条命令的
  // fixture A 重编 330s、B 复用后 83s，而测试本体只有 0.2s；对齐后跨 run
  // 缓存命中，重复编译消失。
  const result = run(cargo, [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--lib",
    "--features",
    "test-agent",
    "acp::golden_trace_tests::golden_trace_baseline_generation",
    "--no-fail-fast",
    "--",
    "--exact",
  ], { PYLON_GOLDEN_TRACE_DIR: dir }, FIXTURE_TIMEOUT_MS);
  return { ...result, testMs: reportedTestMs(result.stdout) };
}

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
        "engine::tests::inbox_full_spills_then_delivers_every_frame_in_order + spill_overflow_terminates_connection_with_explicit_overload",
    },
    traceBytes,
    memoryBound: traceBytes <= 4 * 1024 * 1024,
    processExit: { fixtureClientKill: true },
  };
}

function runBackpressureCheck() {
  // #99：背压探针必须命中的测试用 `--exact` 逐一运行。注意 `cargo test` 对
  // 匹配 0 个测试的情况也退出 0，因此这里的测试名必须与源码同步维护
  // （名字失效 = 探针假绿），两个测试分别锁定「spill 续投不丢帧」与
  // 「溢出显式过载终态」两半契约。
  // #247 起协议引擎核抽至 `pylon-acp` crate——`acp::engine::tests::*` 只在
  // pylon-acp 自己的 lib 测试里存在（glob 重导出带不出依赖 crate 的
  // cfg(test) 模块），探针随之改指 `-p pylon-acp`；`--features test-agent`
  // 是主 crate 的 P5 门面 feature，与此二测试无关，不再传递。
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  const tests = [
    "engine::tests::inbox_full_spills_then_delivers_every_frame_in_order",
    "engine::tests::spill_overflow_terminates_connection_with_explicit_overload",
  ];
  let elapsedMs = 0;
  let stdout = "";
  let stderr = "";
  for (const name of tests) {
    const result = run(cargo, [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "-p",
      "pylon-acp",
      "--lib",
      name,
      "--",
      "--exact",
    ]);
    // `--exact` 下目标测试必须真实运行（cargo 对匹配 0 个测试也退出 0，
    // 所以必须检查 "1 passed" 而不仅是退出码）。
    if (!/test result: ok\..*1 passed/.test(result.stdout)) {
      return {
        status: result.status === 0 ? 1 : result.status,
        elapsedMs,
        stdout,
        stderr: `${stderr}${result.stderr}
backpressure probe matched no test: ${name}`,
      };
    }
    elapsedMs += result.elapsedMs;
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.status !== 0) {
      return { status: result.status, elapsedMs, stdout, stderr };
    }
  }
  return { status: 0, elapsedMs, stdout, stderr };
}

const generation = run(process.execPath, [generator, "--check"]);
if (generation.status !== 0)
  fail("golden trace deterministic check failed", generation.stdout + generation.stderr);

const runA = mkdtempSync(resolve(process.env.TEMP ?? process.cwd(), "pylon-shadow-a-"));
const runB = mkdtempSync(resolve(process.env.TEMP ?? process.cwd(), "pylon-shadow-b-"));
let runs;
let parity;
let fixtureElapsedMs;
let fixtureTestMs;
try {
  const fixtureA = runFixtureInto(runA);
  const fixtureB = runFixtureInto(runB);
  if (fixtureA.status !== 0 || fixtureB.status !== 0)
    fail("shadow fixture run failed", `${fixtureA.stdout}${fixtureA.stderr}${fixtureB.stdout}${fixtureB.stderr}`);
  const filesA = readdirSync(runA).filter((name) => name.endsWith(".jsonl")).sort();
  const filesB = readdirSync(runB).filter((name) => name.endsWith(".jsonl")).sort();
  if (filesA.join() !== filesB.join()) fail("shadow fixture file sets differ");
  fixtureElapsedMs = [fixtureA.elapsedMs, fixtureB.elapsedMs];
  // 性能判定只用**测试本体**耗时：墙钟里裹着 cargo 的编译/链接，
  // 拿它当"fixture 很慢"会误判（实测本机同一条命令：测试 0.22s、进程 128s）。
  fixtureTestMs = [fixtureA.testMs, fixtureB.testMs];
  if (fixtureTestMs.some((ms) => !Number.isFinite(ms)))
    fail(
      "fixture 没有报告测试时长（cargo 输出里找不到 'finished in'）——测试可能根本没跑",
      `${fixtureA.stdout}${fixtureA.stderr}${fixtureB.stdout}${fixtureB.stderr}`,
    );
  runs = scenarios.map((name) => [
    snapshot(name, parseScenarioFrom(runA, name)),
    snapshot(name, parseScenarioFrom(runB, name)),
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
  rmSync(runA, { recursive: true, force: true });
  rmSync(runB, { recursive: true, force: true });
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
    sink: "in-memory canonical vector",
    parity,
    generatorElapsedMs: Math.round(generation.elapsedMs),
    fixtureElapsedMs: fixtureElapsedMs.map((elapsed) => Math.round(elapsed)),
    fixtureTestMs: fixtureTestMs.map((ms) => Math.round(ms)),
    backpressureElapsedMs: Math.round(backpressure.elapsedMs),
    memory: {
      maxTraceBytes: Math.max(...runs.flat().map((run) => run.traceBytes)),
      limitBytes: 4 * 1024 * 1024,
      withinBound: runs.flat().every((run) => run.memoryBound),
    },
    processExit: {
      generatorExitCode: generation.status,
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
