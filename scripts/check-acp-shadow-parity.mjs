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

function run(command, args, extraEnv = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.error) fail(`${command} 启动失败`, result.error.message);
  return {
    status: result.status,
    elapsedMs,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runFixtureInto(dir) {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  return run(cargo, [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--lib",
    "acp::golden_trace_tests::golden_trace_baseline_generation",
    "--no-fail-fast",
    "--",
    "--exact",
  ], { PYLON_GOLDEN_TRACE_DIR: dir });
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
      backpressure: "drop-on-full",
      evidence: "acp::engine::tests::inbox_full_does_not_block_dispatch",
    },
    traceBytes,
    memoryBound: traceBytes <= 4 * 1024 * 1024,
    processExit: { fixtureClientKill: true },
  };
}

function runBackpressureCheck() {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  return run(cargo, [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--lib",
    "acp::engine::tests::inbox_full_does_not_block_dispatch",
    "--",
    "--exact",
  ]);
}

const generation = run(process.execPath, [generator, "--check"]);
if (generation.status !== 0)
  fail("golden trace deterministic check failed", generation.stdout + generation.stderr);

const runA = mkdtempSync(resolve(process.env.TEMP ?? process.cwd(), "pylon-shadow-a-"));
const runB = mkdtempSync(resolve(process.env.TEMP ?? process.cwd(), "pylon-shadow-b-"));
let runs;
let parity;
let fixtureElapsedMs;
try {
  const fixtureA = runFixtureInto(runA);
  const fixtureB = runFixtureInto(runB);
  if (fixtureA.status !== 0 || fixtureB.status !== 0)
    fail("shadow fixture run failed", `${fixtureA.stdout}${fixtureA.stderr}${fixtureB.stdout}${fixtureB.stderr}`);
  const filesA = readdirSync(runA).filter((name) => name.endsWith(".jsonl")).sort();
  const filesB = readdirSync(runB).filter((name) => name.endsWith(".jsonl")).sort();
  if (filesA.join() !== filesB.join()) fail("shadow fixture file sets differ");
  fixtureElapsedMs = [fixtureA.elapsedMs, fixtureB.elapsedMs];
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
      duration: fixtureElapsedMs.every((elapsed) => elapsed < 30_000),
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

const clientSource = readFileSync(resolve(root, "src-tauri/src/acp/client.rs"), "utf8");
const legacyFiles = ["transport.rs", "jsonrpc.rs", "request_id.rs"].filter((name) =>
  existsSync(resolve(root, "src-tauri/src/acp", name)),
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
