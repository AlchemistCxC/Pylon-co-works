#!/usr/bin/env node
// #106 P3b：IPC 静态契约门禁（check:ipc）。
//
// 后端注册面与前端调用面双向静态比对，消灭「前端调了未注册命令 / 后端注册了
// 无人消费的命令」两类接缝漂移：
//   1. 后端面：解析 src-tauri/src/lib.rs 的 `generate_handler![...]` 注册表，
//      取每项 `crate::模块::函数` 的函数名（tauri 命令名 = 函数名，snake_case）。
//   2. 前端面：扫描 src/**/*.{ts,tsx} 的 `invoke('name')` / `invoke("name")` /
//      `invoke<T>('name')` / `transport.invoke('name')` 首参字面量。
//   3. 比对：
//      - 前端调用了未注册命令 → FAIL（运行时必炸的接缝断裂）；
//      - 后端注册但前端零调用 → 仅允许 IPC_EXEMPT 清单内的命令（WebView 外
//        消费者：pylon CLI 桥 / kernel hook 桥 / browser-bridge 子命令等），
//        清单外新增 → FAIL（走豁免须先补消费方说明）。
//
// 负向自测：`--self-test` 以合成输入跑解析与比对核心，断言两类断裂都能判红
// （CI 与本地同一入口；用例见 runSelfTest）。
//
// 用法：node scripts/check-ipc-contract.mts [--self-test]

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import console from "node:console";
import process from "node:process";

const root = resolveRepoRoot();

function resolveRepoRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}

// ── 后端面：generate_handler! 注册表 ──────────────────────────────────────────

/** 解析 generate_handler! 注册表，返回命令名集合（函数名）。 */
export function parseBackendRegistry(libRs: string): Set<string> {
  const start = libRs.indexOf("generate_handler![");
  if (start < 0) throw new Error("generate_handler! not found in lib.rs");
  const depthEnd = libRs.indexOf("]", start);
  const body = libRs.slice(start + "generate_handler![".length, depthEnd);
  const names = new Set<string>();
  for (const match of body.matchAll(/crate::[A-Za-z0-9_:]+::([A-Za-z0-9_]+)/g)) {
    names.add(match[1]!);
  }
  return names;
}

// ── 前端面：invoke 首参字面量 ────────────────────────────────────────────────

/** 严格 invoke 调用首参（判定「调用未注册命令」）。 */
const INVOKE_NAME = /\binvoke(?:<[^>()]*>)?\(\s*['"]([A-Za-z0-9_]+)['"]/g;
/** 宽匹配：命令名作为任意引号字面量出现（判定「已注册但零调用」——前端存在
 * fetchPet('get_pet') / call('browser_agent_x') 等本地转发包装，按名字出现即算
 * 消费；宁可漏报不可误报）。 */
const ANY_QUOTED = /['"]([a-z][a-z0-9_]*)['"]/g;

/** 不消费 Tauri IPC 的 invoke 形态（排除路径而非豁免命令——这些调用面的
 * 「命令名」属于其他命名空间）：插件命令门面（宿主命令）与合成测试夹具。 */
const EXCLUDED_PATHS = [
  "src/domains/workbench/workbenchCommandFacade.ts",
  "src/test/",
];

/** 递归收集前端 invoke 命令名 → 引用文件列表；同时返回全量字面量集合。 */
export function scanFrontendInvocations(
  srcDir: string,
): { invocations: Map<string, Set<string>>; literals: Set<string> } {
  const invocations = new Map<string, Set<string>>();
  const literals = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const repoPath = relative(root, full).replaceAll("\\", "/");
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(ANY_QUOTED)) {
          literals.add(match[1]!);
        }
        if (EXCLUDED_PATHS.some((prefix) => repoPath.startsWith(prefix))) {
          continue;
        }
        for (const match of text.matchAll(INVOKE_NAME)) {
          const name = match[1]!;
          if (!invocations.has(name)) invocations.set(name, new Set());
          invocations.get(name)!.add(repoPath);
        }
      }
    }
  };
  walk(srcDir);
  return { invocations, literals };
}

// ── 豁免清单：WebView 外消费者 ───────────────────────────────────────────────
// 每项须注明消费方；新增豁免 = 先确认消费方存在，再登记此处。

const IPC_EXEMPT: ReadonlySet<string> = new Set([
  // ── WebView 外消费者（子进程/外部工具经 stdio 驱动）──
  "pylon_cli_ready", // CLI/hook 桥 stdio 应答
  "pylon_cli_respond", // CLI/hook 桥 stdio 应答
  "pylon_cli_window_capture", // CLI/hook 桥 stdio 应答
  "pylon_hook_ready", // CLI/hook 桥 stdio 应答
  "pylon_hook_respond", // CLI/hook 桥 stdio 应答
  "hook_registry_sync", // CLI/hook 桥 stdio 应答
  // ── Prism 集成历史面（前端无静态消费点；保留待数据面重构定夺，#106 遗留）──
  "prism_health",
  "prism_status",
  "prism_state",
  "prism_scenarios",
  "prism_sources",
  "prism_aliases",
  "prism_config",
  "prism_logs",
  "prism_chronicle",
  "prism_history",
  "prism_scenario",
  "prism_blocks",
  "prism_inject",
  "prism_command",
  "prism_create_scenario",
  "prism_delete_scenario",
  "prism_create_source",
  "prism_delete_source",
  "prism_source_detail",
  "prism_source_files",
  "prism_read_source_file",
  "prism_write_source_file",
  "prism_delete_source_file",
  "prism_source_entries",
  "prism_source_entry",
  "prism_add_source_entry",
  "prism_edit_source_entry",
  "prism_delete_source_entry",
  "prism_update_config",
  "prism_update_scenario",
  "prism_create_block",
  "prism_update_block",
  "prism_delete_block",
  "prism_add_scenario_block",
  "prism_edit_scenario_block",
  "prism_delete_scenario_block",
  "prism_reorder_scenario_blocks",
  "prism_reload",
  "prism_llm_test",
  // ── 调试/诊断面（外部 MCP 工具与手动 invoke 消费；前端无入口）──
  "acp_instance_overview",
  "session_inspector",
  "validate_agents",
  "cancel_detection_refresh",
  "push_frontend_log",
  "load_sessions", // 旧枚举面：前端消费 list_persisted_sessions，此命令保留兼容
]);

// ── 比对核心 ─────────────────────────────────────────────────────────────────

export interface IpcDiff {
  unregistered: Array<{ name: string; files: string[] }>;
  uncalled: string[];
}

export function compare(
  backend: Set<string>,
  frontend: Map<string, Set<string>>,
  literals: ReadonlySet<string>,
  exempt: ReadonlySet<string>,
): IpcDiff {
  const unregistered = [...frontend.entries()]
    .filter(([name]) => !backend.has(name))
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const uncalled = [...backend]
    .filter((name) => !literals.has(name) && !exempt.has(name))
    .sort((a, b) => a.localeCompare(b));
  return { unregistered, uncalled };
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

function main(): number {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  const libRs = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
  const backend = parseBackendRegistry(libRs);
  const { invocations, literals } = scanFrontendInvocations(join(root, "src"));
  const { unregistered, uncalled } = compare(backend, invocations, literals, IPC_EXEMPT);

  let failed = false;
  if (unregistered.length > 0) {
    failed = true;
    console.error(`check:ipc FAIL — 前端调用了 ${unregistered.length} 个未注册命令:`);
    for (const { name, files } of unregistered) {
      console.error(`  - ${name}  (引用: ${files.join(", ")})`);
    }
  }
  if (uncalled.length > 0) {
    failed = true;
    console.error(
      `check:ipc FAIL — ${uncalled.length} 个已注册命令前端零调用且不在豁免清单:`,
    );
    for (const name of uncalled) console.error(`  - ${name}`);
    console.error(
      "  （WebView 外消费者请登记脚本顶部 IPC_EXEMPT，并注明消费方）",
    );
  }
  if (failed) return 1;
  console.log(
    `check:ipc ok — 后端注册 ${backend.size} 个命令，前端 invoke ${invocations.size} 个，双向一致（豁免 ${IPC_EXEMPT.size}）`,
  );
  return 0;
}

// ── 负向自测 ─────────────────────────────────────────────────────────────────

function runSelfTest(): number {
  const backend = parseBackendRegistry(
    [
      "fn build() {",
      "    tauri::Builder::default()",
      "        .invoke_handler(tauri::generate_handler![",
      "            crate::session::send_message,",
      "            crate::session::new_session,",
      "            crate::pet_cmds::get_pet,",
      "        ])",
      "}",
    ].join("\n"),
  );
  const wantBackend = new Set(["send_message", "new_session", "get_pet"]);
  assert(
    wantBackend.size === backend.size &&
      [...wantBackend].every((name) => backend.has(name)),
    "self-test: backend registry parse",
  );

  const frontendText = [
    "const a = transport.invoke('send_message')",
    'const b = invoke("new_session")',
    "const c = invoke<Pet>('get_pet')",
    "const d = invoke('ghost_command')",
  ].join("\n");
  const tmpFrontend = new Map<string, Set<string>>();
  for (const match of frontendText.matchAll(INVOKE_NAME)) {
    tmpFrontend.set(match[1]!, new Set(["synthetic.ts"]));
  }

  const broken = compare(backend, tmpFrontend, new Set(["send_message", "new_session", "get_pet"]), IPC_EXEMPT);
  assert(
    broken.unregistered.length === 1 &&
      broken.unregistered[0]!.name === "ghost_command",
    "self-test: unregistered command must FAIL",
  );
  assert(
    broken.uncalled.length === 0,
    "self-test: fully-called registry must not flag uncalled",
  );

  const frontendNoPet = new Map([...tmpFrontend].filter(([name]) => name !== "get_pet"));
  const exempt = new Set(["get_pet"]);
  const withExempt = compare(backend, frontendNoPet, new Set(["send_message", "new_session"]), exempt);
  assert(
    withExempt.uncalled.length === 0,
    "self-test: exempted uncalled command must pass",
  );
  const withoutExempt = compare(backend, frontendNoPet, new Set(["send_message", "new_session"]), new Set());
  assert(
    withoutExempt.uncalled.length === 1 &&
      withoutExempt.uncalled[0] === "get_pet",
    "self-test: non-exempt uncalled command must FAIL",
  );
  // 宽匹配消费面：命令名以任意引号字面量出现即算消费（fetchPet('get_pet') 形态）。
  const viaWrapper = compare(
    backend,
    new Map(),
    new Set(["send_message", "new_session", "get_pet"]),
    new Set(),
  );
  assert(
    viaWrapper.uncalled.length === 0,
    "self-test: literal-presence counts as consumption",
  );

  console.log("check:ipc self-test ok — 双向断裂判定与豁免语义均验证");
  return 0;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`check:ipc SELF-TEST FAILED: ${message}`);
    process.exit(2);
  }
}

process.exitCode = main();
