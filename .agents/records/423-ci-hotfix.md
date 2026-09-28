# #423 CI 热修：PR #433 合并后 main 门禁全红（前端两错）

- 日期：2026-09-28
- 范围：仅 `src/cli/pylonCliDomainPorts.ts`、`src/cli/pylonCliService.ts`（各 2 行级改动）
- 关联：PR #433（refactor #423，已合并但 4/6 job 红）；issue #423

## 现象

PR #433 合并后 CI 四 job 红，main 最新 run（36429596276）同因全红。四个红灯实为两个前端问题——3 个 Rust job（fmt+测试+构建 / clippy 基线 / ACP shadow parity）都死在共同前置步骤「前端构建（tauri generate_context 前置）」，从未跑到 cargo 阶段：

1. `src/cli/pylonCliDomainPorts.ts:318` TS2345：`invoke<{ items: unknown[] }>` 的 `unknown[]` 上 `.map(normalizeWireInteractionEntry)`，回调参数逆变不匹配（`normalizeWireInteractionEntry` 收 `WireInteractionEntry`）。
2. `src/cli/pylonCliService.ts:204-205` eslint `no-useless-assignment`：`let title = ''` / `let prompt = ''` 初值从未被读（四分支全部先写后读，else 提前 return null）。

## 修复

- `invoke` 泛型改 `{ items: WireInteractionEntry[] }`——`WireInteractionEntry` 本就是 pylonCliService 导出的 wire 契约类型，normalize 内部仍逐字段防御校验，运行时行为零变化。
- `let title: string` / `let prompt: string` 去掉死初值（TS definite assignment 分析通过：全路径先赋值）。

## 验证

- `bun run lint`：0 error（仅剩 `GatewaySheetView.tsx:193` 既有 warning，非阻断，CI 同款）。
- `bun run build`（build:wasm + tsc -b + vite）：通过，`✓ built in 9.79s`。
- `vitest run src/cli/__tests__/{interactionWireNormalize,pylonCliService}.test.ts`：27/27。
- Rust 侧无改动；#423 开发记录已载明本地 `cargo test --workspace --lib` 9 目标 / `check:clippy` exit 0 / fmt 干净——CI 的 Rust 门禁本次是首次真正执行，以 PR CI 为准。

## 遗留

- Rust 三 job 在此代码上首次跑到 cargo 阶段，若有残余红将在 PR CI 暴露后跟进。
