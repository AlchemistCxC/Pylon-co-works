# Pylon 全量审计报告（FINAL-AUDIT 2026-07-31）

> 审计方式：3 子 agent 并行全量通读（前端 10,800 行 / Rust 4,703 行 / 配置集成层）+ Riccati 亲自通读 lib.rs(1778)/acp.rs(1328)/全部小文件 + 脚本级 CSS-TSX 交叉 + 实测编译
> 范围：G:\Project\prism-desktop main@868b0be（审计期间前端有并发修改——宫木云本人正在重构前端）
> 结论：协议层全对（8/8 核销），无 P0；后端 P1×1、前端 P1×2、配置 P1×3；P2 若干

## 一、协议层核销（8/8 ✅，Peri 源码交叉验证）

| 验证点 | 结论 |
|:--|:--|
| initialize `_meta.peri.tokenStats/skillNames/replay` | ✅ 与 peri_caps.rs 逐键一致 |
| set_config_option 三层嵌套 | ✅ config.rs:40 ValueId 匹配 |
| set_mode modeId / cancel 通知 / close 参数 | ✅ requests.rs:189 |
| 通知循环全 snake_case（7 处无 camelCase 残留） | ✅ |
| usage_update used/value 双字段兼容 + _meta 统计 | ✅ |
| session/load 重放 _meta.periReplay | ✅ |
| prompt stopReason 白名单 | ✅ |
| 16 路 pending 分片一致性 | ✅ |

## 二、后端问题（Riccati 亲读验证）

### P1-后端：关窗回调内 block_on 必 panic（lib.rs on_window_event）

```rust
// lib.rs CloseRequested 分支（Riccati 实测代码）
let rt = tokio::runtime::Handle::current();
rt.block_on(async { ... acp.lock().await.kill() ... });
```

- 根因：run() 由 `rt.block_on(Builder::run(...))` 驱动（lib.rs:1679），Windows 消息循环回调运行在同一线程栈内；tokio `Handle::block_on` 在已 Entered 线程上无条件 panic（"Cannot start a runtime from within a runtime"）。
- 影响：每次关窗 panic。kill 逻辑不执行；子进程清理依赖 unwind 传播中 ManagedChild::drop 兜底（大概率仍会 kill，但进程以崩溃路径退出，无优雅 shutdown）。
- 修复：删除 block_on，依赖 AppState drop 链（ManagedChild::drop 已实现 kill_and_wait）；或改用 `tauri::async_runtime::spawn`。

### P2-后端（验证过，按价值排序）

| 编号 | 位置 | 问题 |
|:--|:--|:--|
| P2-1 | lib.rs:1335 close_session | prompt 运行中直接 close，pending oneshot 挂到 300s 超时（前端先 cancel 可规避，后端无防御） |
| P2-2 | lib.rs:1498 load_persisted_session | 绕过 MAX_SESSIONS=100 上限（new_session/send 都有检查，这里没有） |
| P2-3 | acp.rs:501 | agent stderr 经 log::error! 直出未脱敏（runtime_log hub 侧安全，日志后端暴露原文） |
| P2-4 | acp.rs:549 | stdout 读线程 shard.lock().unwrap()——poison 时线程 panic，pending 不 drain |
| P2-5 | lib.rs:1113/1306/1319/1339/1353/1500/1543/1635 | 非 prompt RPC 锁内完整 await（最长 30s 超时），Peri 卡顿时全局串行化——与 V14 锁外写不一致，正确性无碍 |
| P2-6 | acp.rs:593-599 | load_session_params 传 mcpServers——Peri 忽略无害，但 Hermes 严格校验可能报错（ACP 标准应仅传 sessionId+cwd） |
| P2-7 | agent_config.rs:26-40 | 相对路径 exe 仅在 PYLON_AGENTS_CONFIG 时解析；默认 include_str 下不解析（当前 agents.yaml 全绝对路径/裸命令，实际不触发） |
| P2-8 | runtime_log.rs:83/99/114 | 3 处 expect("runtime log mutex poisoned")——按生产零 expect 铁律可降级 |
| P2-9 | lib.rs:537 | notification_is_current 调用参数冗余（source/source、peri_id/peri_id 同值两遍），API 设计可简化 |
| P2-10 | lib.rs:1467 | pet_action "sleepy" 丢弃 check_sleepy 返回值，前端无法得知睡眠状态 |

### 附件路径风险（Riccati 补充）

- acp.rs:328-363 prompt_blocks 接受任意绝对路径附件（.env 等敏感文件可读入 prompt）。前端用户主动选择，风险可控；建议限制 workspace 内或加确认。P2 防御性。

## 三、前端问题（宫木云自行重构范围——仅转达，子 agent 全量通读）

### P1-前端
- B1 App.tsx:63-68 sheet 聚焦回弹 effect 覆盖用户主动切换——非 Agent sheet 打开一帧即被弹回，无法停留。修复 1-3 行（effect 只在 activeAgent 变化时聚焦）。
- B2 InputBar/cancelState.ts:48-50 resolveCancelCommand 恒等式——取消一次后状态卡死 'canceling'，该会话取消功能永久失效（静默）。修复：resolveCancelCommand 返回 { ...state, status:'generating' }。

### P2-前端精选
- B4/B5 render 期 useStore.getState()（ControlCenter:136、ChatView:443 非响应式）
- B8 ControlCenter inputSplit 一刀切——send/attach 一个隐藏时另一个入口也消失
- B9 Settings/RightPanel 条件挂载状态丢失（ChatView overlay 正确）
- C1 16 个 TSX 用了但 CSS 无定义（pe-close/sheet-empty-host/sheet-empty-kicker 等用户必见路径）
- C2 8 个死 CSS（modal-header/model-dropdown/cc-model-widget/prism-tag/term-user-tag 等）
- D 类死代码约 600+ 行（StatusBar.tsx 222 行整文件无引用、resolveCancelCommand、restoreSessions、PresetRow、agentFailureState、configOptionEventState 等）
- P1/P2 Settings 整树订阅 store、ControlCenter 未 memo——高频重渲染热点
- renderMetrics 埋点专项：正确 ✅（recordRender 在 render 主体、measureRender 完整包住 map、DEV 门控零生产开销）

## 四、配置/集成层（子 agent 验证）

### P1-配置
- CONF-01 tauri.conf.json csp:null + dangerousDisableAssetCspModification——CSP 完全禁用，XSS 无缓解层
- CONF-10 worktree（prism-desktop-backend/frontend）已删，但 sync_kanban.py LANE_CONFIG / workspaces.yaml / ORCHESTRATOR_HANDOFF 仍引用——自动化会失败
- SCRIPT-01 test-profile-prompt-visibility.mts 被排除且断言过时（should_forward_user_update 已重构消失）——replay gate 回归点无守护

### P2-配置精选
- CONF-06/07/DEP-10 shell:default + fs:default 前后端零使用（死权限 + 死依赖 tauri-plugin-shell/fs，可删）
- CONF-08 dialog:default 过宽（实际仅 open/save）
- DEP-05/06 5 个 npm 包零引用可删（immer/copy-to-clipboard/react-diff-viewer/dnd-kit×3）
- DEP-08/09 crate-type cdylib/staticlib 桌面 app 不需要；无 [profile.release] 优化
- CONF-02/03 标题/identifier 品牌残留（Prism Desktop/com.prism.desktop）
- CONF-11 CSS data-agent-state="inactive" 是死规则（Rust 枚举无 Inactive 变体），connecting/disconnected 无专属样式

## 五、编译/回归实测（Riccati）

- cargo check ✅（1 dead_code warning：WorkspaceError::InvalidRelativePath/TooLarge 从未构造——DEAD-1）
- cargo test --lib --no-run ✅
- npm run test:frontend ✅ 全绿 EXIT 0
- 子 agent 的 cargo 检查因工具链 PATH 未注入失败过一次——以 Riccati 实测为准

## 六、修复优先级建议

```
立刻（P1，改动极小）
  1. lib.rs on_window_event 删 block_on（后端）——每次关窗 panic
  2. cancelState.ts resolveCancelCommand 返 generating（前端，用户范围）
  3. App.tsx sheet 聚焦 effect 收敛（前端，用户范围）
  4. sync_kanban.py 更新 worktree 引用或删 LANE_CONFIG（配置）
  5. test-profile-prompt-visibility 恢复或重写断言（配置）

本周（P2 高价值）
  6. load_persisted_session 补 MAX_SESSIONS 检查
  7. stderr 脱敏复用 sanitize
  8. 删死权限/死依赖（shell/fs/dialog 收窄 + 5 npm 包 + 2 Cargo 插件）
  9. C1 补 CSS（pe-close/sheet-empty-host 用户必见）

上线前（发布工程）
  10. CSP 策略（非 null）、updater/签名/identifier、[profile.release] 优化
```
