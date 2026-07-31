# Pylon 项目现状与上线距离评估

> 评估日期：2026-07-31  
> 工作区：`G:\Project\prism-desktop`  
> 评估依据：当前 `main` 源码、Frontend/Backend worktree、Hermes Kanban 状态及本轮实际构建结果。

## 一、结论

Pylon 当前不是“临门一脚”，而是“核心主链已经成型，但当前 `main` 尚不能发布”的阶段。

按不同上线标准评估：

| 目标 | 当前完成度 | 判断 |
|---|---:|---|
| 个人机器内部 Alpha | 约 65% | 核心 Agent/Session/Chat 已存在，但需要先恢复 Rust 编译并完成真实 Tauri + Peri 主链验收 |
| 少量用户 Beta | 约 45% | 还缺安装包、干净环境验证、Prism 只读接入和关键生命周期收口 |
| 正式发布 v1 | 约 30%～35% | Prism/Git/Runtime 等产品能力及签名、更新、安装、迁移等发布工程尚未完成 |

当前不能上线。

最合理的路线不是立即补齐所有规划功能，而是先收口一个功能边界诚实、运行稳定的 Pylon 0.1 Alpha。

---

## 二、当前工程状态

### 2.1 Git 基线

```text
branch: main
HEAD: 2c766bd
main ahead origin/main: 7 commits
```

主工作区当前有一个未跟踪文件：

```text
scripts/agent-workflow/sync_kanban.py
```

Backend/Frontend 固定 worktree 当前均无未提交修改。

### 2.2 尚未集成的 Frontend Worker 成果

Frontend Worker 已完成：

```text
91c9864 feat(F1.1): 清理 RightPanel Reserved Tabs，固定四类 Tab 模型
```

该提交目前位于 `agent/frontend`，尚未进入 `main`。

它完成了：

- 删除 `ReservedTab`；
- 将右栏 Tab 固定为 `workspace / logs / activity / changes`；
- 为尚未接入的 Activity/Changes 显示明确 unavailable 状态；
- 更新对应测试和前端交接手册。

### 2.3 版本状态

当前版本仍为：

```text
package.json:              0.1.0
src-tauri/Cargo.toml:      0.1.0
src-tauri/tauri.conf.json: 0.1.0
```

### 2.4 源码规模

```text
前端 TypeScript/TSX/CSS：约 10,640 行
Rust：约 4,711 行
tracked src/src-tauri/scripts 文件：260 个
前端回归脚本：111 个
```

---

## 三、已经具备的核心能力

### 3.1 Agent 与 ACP 主链

后端已实现并注册核心 Tauri commands：

```text
new_session
load_persisted_session
send_message
cancel_prompt
close_session
set_mode
set_config_option
list_agents
switch_agent
reconnect_agent
reload_agents
agent_status
```

前端已实际调用这些命令，并监听：

```text
peri:user
peri:update
peri:done
peri:error
peri:agent-status
```

因此以下主链已经存在于当前源码中：

```text
创建/恢复 Session
→ 发送消息
→ 接收流式文本、reasoning 与 tool updates
→ 完成/错误/取消
→ 本地状态与消息持久化
```

### 3.2 Session 生命周期与隔离

当前源码已经覆盖相当多生命周期边界：

- `source / periId / generation` 身份隔离；
- replay 与 live event 分离；
- 后台 Session 消息缓存；
- Session 消息本地持久化；
- cancel 状态收敛；
- Agent 替换后的旧事件过滤；
- Session 导出敏感字段过滤；
- 导出文件原子写入。

这是当前项目完成度最高、价值最大的核心部分。

### 3.3 Agent Registry

当前 `agents.yaml` 配置了 Peri 与 Hermes：

```yaml
peri:
  exe: F:\A-I\Agent\Peri\target\release\peri.exe
  default: true

hermes:
  exe: hermes
  args: ["acp"]
```

本机已确认 Peri release executable 和 Hermes CLI 均存在。

后端支持：

- Agent 配置解析；
- deterministic default；
- 多个 default 时拒绝加载；
- 运行时 reload；
- Agent 不可用时降级启动；
- status、switch、reconnect。

### 3.4 Workspace 只读能力

后端已实现：

```text
get_workspace_root
list_workspace_entries
read_workspace_text
```

路径安全措施包括：

- 拒绝绝对路径；
- 拒绝 `..`；
- canonicalize containment；
- 拒绝越界 symlink；
- 文件预览大小限制；
- 二进制文件拒绝；
- 目录条目数量限制。

前端 RightPanel 已调用 Workspace commands，具备目录展示和文本预览基础。

### 3.5 Runtime Logs

后端已实现：

```text
list_runtime_logs
clear_runtime_logs
push_frontend_log
```

RuntimeLogHub 具备：

- 固定容量 ring buffer；
- 条件查询；
- 实时广播；
- 消息截断；
- token、authorization、prompt、persona、env、rawInput/rawOutput 等敏感字段脱敏。

### 3.6 Prism 后端适配

Rust 已注册大量 Prism commands，覆盖：

- health/status/state；
- scenario/source/block；
- source files；
- worldbook entries；
- inject/command/reload；
- config/LLM test；
- logs/history/chronicle；
- 创建、更新、删除与排序操作。

`PrismClient` 已具备：

- loopback URL 限制；
- 固定 endpoint；
- Admin Bearer token；
- connect/request timeout；
- 非 2xx 错误处理；
- 错误正文截断；
- API 路径逃逸限制。

因此 Prism 后端桥接层不是从零开发状态，主要缺口位于 route audit、真实 Tauri 验收和前端接入。

---

## 四、当前上线硬阻塞

## 4.1 `main` 的 Rust 当前无法编译

本轮实际执行：

```bash
cargo check
```

结果：

```text
exit code: 101
```

错误位置：

```text
src-tauri/src/lib.rs:1177
src-tauri/src/lib.rs:1284
src-tauri/src/lib.rs:1298
```

错误内容：

```text
no method named `session_matches` found for struct `State<'_, AppState>`
```

受影响的关键路径：

- `send_message`；
- `close_session`；
- `cancel_prompt`。

当前 `AppState` 有：

```rust
with_session_if_matches(...)
remove_session_if_matches(...)
```

但不存在被调用的：

```rust
session_matches(...)
```

`cargo test --lib --no-run` 也因同样错误失败。

因此当前事实是：

```text
前端可构建
Rust 不可编译
当前 main 无法生成可信的新桌面发布产物
```

这是上线前第一优先级阻塞。

## 4.2 前端全量回归不是全绿

本轮执行：

```bash
npm run test:frontend
```

结果：

```text
exit code: 1
```

失败项：

```text
scripts/test-scroll-bottom-offset.mts
```

失败原因与当前代码结构变化有关。测试仍断言 `--right-panel-inset` 位于 `App.tsx`，而当前实现已将该变量设置移动到 `AgentSheetView`。

这更像测试基线漂移，但在修正并重新验证前，不能宣称前端回归全绿。

runner 还明确排除了：

```text
test-profile-prompt-visibility.mts
原因：直接读取 src-tauri 后端源码
```

## 4.3 现有 release executable 已过期

当前存在：

```text
src-tauri/target/release/pylon.exe
大小：35,239,571 bytes
生成时间：2026-07-30 18:36
```

由于当前 HEAD 的 Rust 已无法编译，该 executable 不是当前源码的 fresh 构建产物，不能作为当前版本的发布包。

## 4.4 尚无正式安装包

当前未发现：

```text
MSI
NSIS setup.exe
release bundle
正式 CI/release workflow
```

即使恢复源码编译，还需要：

- fresh release build；
- Windows 安装包；
- 安装/卸载验证；
- 干净环境启动验证；
- 外部 Peri/Hermes executable 的部署或发现策略；
- 资源路径 read-back。

## 4.5 发布配置尚未收口

当前 `tauri.conf.json` 包含：

```json
{
  "csp": null,
  "dangerousDisableAssetCspModification": true
}
```

Capabilities 当前包含：

```text
shell:default
dialog:default
fs:default
```

内部 Alpha 可以暂时接受，但正式分发前需要重新审查 CSP 与 capabilities 范围。

当前也未发现：

- updater 配置；
- 签名配置；
- publisher/certificate；
- release targets；
- 自动升级链路。

---

## 五、各产品模块完成度

## 5.1 Agent Chat 核心：约 75%

已有：

- new/load/send/cancel/close；
- replay；
- 流式消息；
- reasoning/tool 渲染；
- mode/model 配置；
- 附件；
- 导出；
- Agent switch/reconnect；
- Runtime logs；
- Session 持久化；
- HTML sanitizer。

主要缺口：

- 恢复 Rust 编译；
- 真实 Tauri + Peri 端到端验收；
- A→B→A Agent 快速切换；
- stale response/event 压力验证；
- Agent 进程崩溃与恢复验证；
- fresh release 运行验证。

## 5.2 Workspace Sheet：约 65%

已有：

- Sheet registry/reducer/persistence；
- 顶栏；
- Launcher；
- pinned/close/reopen；
- Agent Sheet；
- Prism Sheet 壳；
- Workspace tree；
- 文本预览；
- Runtime logs。

未完成：

- Workspace transport 单一真值收敛；
- preview state 去双 owner；
- 深层展开/读取的真实桌面验收；
- Runtime Sheet；
- File Sheet；
- Diff Sheet；
- Changes Sheet；
- Git History Sheet。

当前 `SheetHost.tsx` 只有以下真实 renderer：

```text
agent
prism
```

以下 Sheet 仍统一显示“尚未接入”：

```text
runtime
file
diff
changes
git-history
```

## 5.3 RightPanel：壳约 90%，完整能力约 50%

当前 `main` 仍使用：

```text
workspace
logs
reserved-1
reserved-2
```

未集成的 `91c9864` 已将其改为：

```text
workspace
logs
activity
changes
```

即使集成该提交，仍存在：

- Activity unavailable；
- Changes unavailable；
- Workspace transport 尚待收敛；
- Logs 缺少完整实时刷新/订阅闭环。

## 5.4 Prism 管理 UI：约 15%

`src/components/PrismSheet.tsx` 明确显示：

```text
演示预览：尚未接入 Prism API，所有管理操作已禁用。
```

当前页面中的以下内容均为静态演示：

- Bot 列表；
- 场景；
- World Book；
- Blocks；
- Debug；
- System。

后端已有大量 Prism commands，但前端尚未消费。

因此当前 Pylon 更准确的产品定位是：

```text
AI Agent 桌面客户端 + Prism 管理 UI 原型
```

而不是完整可用的 Prism Desktop 管理器。

## 5.5 Git/Changes：约 5%

当前仅有：

- Sheet 类型；
- Launcher unavailable 标记；
- RightPanel Changes 占位。

后端尚无 Git 模块，`BE-B5-001` 也未开始。

## 5.6 Runtime/Activity：约 35%

已有 RuntimeLog backend 和 LogsPanel。

仍缺：

- Session Inspector 聚合 DTO；
- Activity 语义与数据源；
- Runtime Sheet；
- 更完整的 process/runtime 信息；
- 真实生命周期验收。

## 5.7 MCP/Session Settings：约 40%

后端支持 `set_mcp_servers` 和 MCP 校验，但当前配置是 runtime-only 的进程内 snapshot。

设置页也明确提示：

```text
会话级 Skills / Hooks 暂未接入运行时。
```

因此设置 UI 与真实运行时契约尚未完全闭环。

---

## 六、版本化任务图进度

版本化任务卡总数：

```text
14 张
```

已进入 `main`：

```text
BE-B0-001
FE-F0-008
```

已由 Worker 完成但尚未集成：

```text
FE-F1-001
```

按任务数量计算：

```text
main 完成：2 / 14 = 14.3%
算上未集成 Worker：3 / 14 = 21.4%
剩余：11 张
```

剩余关键任务：

```text
BE-B1-001  Session mutation 身份重验
BE-B3-001  Prism route audit
BE-B2-001  Session Inspector
BE-B4-001  MCP 契约
BE-B5-001  Git status

FE-F1-002  Workspace transport 收敛
FE-F5-001  Chat message ID allocator
FE-F4-001  Agent status v2 消费
FE-F0-009  Agent Sheet 真实切换事务
FE-F2-001  Prism 只读数据接入
FE-F6-001  Workspace 回归基线
```

任务卡完成比例不能直接等同整体产品完成度，因为 Agent/ACP 主链在该任务图建立前已经完成了大量开发。但它说明当前 Workspace Sheet 后续收口计划仍处于前期。

---

## 七、离不同上线阶段还差什么

## 7.1 内部 Alpha

目标定义：

- 仅供开发者本人机器使用；
- Peri 路径可以固定；
- Prism 管理页可以继续明确标记未接入；
- 核心 Chat、Session、Agent 和 Workspace 必须稳定。

上线前最低要求：

1. 修复 Rust 编译错误；
2. 修复前端失败回归；
3. 集成 `91c9864`；
4. 完成 `BE-B1-001` 核心生命周期收敛；
5. 完成 `FE-F4-001` 与 `FE-F0-009`；
6. 执行真实 Tauri + Peri 主链：
   - new；
   - send；
   - stream；
   - cancel；
   - close；
   - load；
   - Agent A→B→A；
7. fresh release build；
8. 对产物进行启动和 read-back 验证。

工程判断：距离内部 Alpha 约还差一个集中开发周期。

## 7.2 小范围 Beta

目标定义：

- 可提供给少量用户试用；
- 核心能力不依赖开发机偶然状态；
- 有安装包；
- 错误可见；
- 崩溃后可恢复；
- 至少 Prism 只读能力可用。

在 Alpha 基础上还需要：

- 完成 `BE-B3-001` Prism route audit；
- 完成 `FE-F2-001` Prism 只读接入；
- 完成 `FE-F1-002` Workspace 收敛；
- Runtime/Activity 最小可用；
- Windows 安装包；
- 干净机器验证；
- Peri/Hermes executable 发现与配置；
- 配置迁移和损坏恢复；
- 基本发布说明；
- CSP/capability 审查。

工程判断：距离小范围 Beta 约还差 2～3 个集中开发周期。

## 7.3 正式 v1

如果正式 v1 要兑现当前 UI 和规划暗示的全部能力，还需要：

- Prism 完整管理 CRUD；
- Git Changes/Diff/History；
- Runtime Sheet；
- Activity；
- MCP 持久化与作用域契约；
- 安装、卸载和升级；
- 应用签名；
- updater；
- release CI；
- crash recovery；
- 版本迁移；
- 多机器路径适配；
- 长 Session、大消息和性能压测；
- 安全审查；
- 用户文档。

工程判断：当前尚未进入正式发布收尾阶段。正式 v1 至少还需要一个完整功能阶段和一个独立发布工程阶段。

---

## 八、建议的 Pylon 0.1 Alpha 范围

建议先发布一个功能边界明确的内部 Alpha，而不是等待所有 Sheet 完成。

### Alpha 必须包含

```text
Agent Chat
Session create/load/send/cancel/close/export
Agent list/status/switch/reconnect
Workspace tree/text preview
Runtime logs
Sheet 导航/pinning
Settings/Profile/Session 基础设置
Pet
```

### Alpha 应明确隐藏或标记 unavailable

```text
Prism 写管理
Git/Changes/Diff/History
Activity
Runtime 独立 Sheet
Skills/Hooks
多 Agent 后台并行
```

---

## 九、推荐优先级

```text
P0  修复 Rust 编译
P0  集成 91c9864
P0  修复前端失败回归
P0  完成 BE-B1-001
P0  完成 FE-F4-001 + FE-F0-009
P0  真实 Tauri/Peri 主链验收
P0  fresh release build
P1  安装包与干净环境验证
P1  Prism 只读接入
```

---

## 十、最终判断

Pylon 的技术核心已经完成大半，尤其 ACP、Session、事件隔离、Workspace 安全和 UI 框架已经超过普通原型阶段。

但产品上线闭环尚未完成，当前主要问题是：

1. `main` 存在 Rust 编译断裂；
2. 前端回归存在失败项；
3. 真实 Tauri + Peri 运行时证据不足；
4. Prism 管理 UI 基本仍为静态演示；
5. Git、Activity、Runtime Sheet 等能力尚未实现；
6. 安装、签名、更新和 CI 等发布工程几乎尚未开始。

因此当前不能上线。

应先收口 Pylon 0.1 内部 Alpha。完成编译恢复、生命周期关键任务、Agent Sheet 切换和真实桌面主链验收后，项目会从“核心功能开发期”进入“可用性与发布收口期”。
