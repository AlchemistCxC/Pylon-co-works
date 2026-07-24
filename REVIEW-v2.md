REVIEW-v2 — 0a50373 agent registry + session persistence + export
══════════════════════════════════════════════════════════

总体：P0 和 P1 实现正确，架构干净。P2 是占位符。3 个待修项 + 3 个建议。

──────────────────────────────────────────
🔴 必须修
──────────────────────────────────────────

R1. acp.rs — spawn() 死代码（68 行重复）

  L38-134 的 spawn() 与 L226-298 的 connect() 逻辑完全重复（reader
  线程、stderr drain、broadcast、initialize）。connect() 已是唯一调用路径，
  spawn() 应删除，或改为内部委托：

    pub async fn spawn(peri_exe: &str, cwd: &str, model: &str) -> Result<Self, String> {
        let agent = AgentDef {
            name: "peri".into(), transport: "subprocess".into(),
            exe: peri_exe.into(), args: vec!["acp".into(), "--cwd".into(), cwd.into(), "--model".into(), model.into()],
            cwd: Some(cwd.into()), env: HashMap::new(),
        };
        Self::connect(&agent).await
    }

  保留 spawn() 作为向后兼容快捷方式是合理的，但不要重复实现。

R2. export_session 是假实现

  lib.rs:199-203 只写了一个占位 header。`session/load` 会触发 Peri
  重放全部消息为 session/update 事件，但当前代码没有捕获这些事件。

  正确实现需要：先打开 broadcast 订阅 → 调 load_session → 收集所有
  session/update → 等 session/load 返回 → 格式化写入。

  伪代码：

    let mut broadcast = state.acp.rx.resubscribe();
    let mut messages = Vec::new();
    let handle = tokio::spawn(async move {
        while let Ok(raw) = broadcast.recv() {
            if raw.method == Some("session/update".into()) {
                messages.push(raw.params.unwrap_or_default());
            }
        }
    });
    state.acp.load_session(&peri_id, cwd).await?;
    handle.abort();
    // format messages as markdown/jsonl → write to output_path

  这是 P2 核心逻辑，现在的占位符不算"完成了 P2"。

R3. 3 个文件在 commit 外 modified

  src-tauri/Cargo.lock、src-tauri/src/acp.rs、src-tauri/src/lib.rs
  有未提交的修改（编译修补——agent.name 闭包生命周期 + ownership）。
  这些应该属于这个 commit。先 commit 再往下走。

──────────────────────────────────────────
🟡 建议修
──────────────────────────────────────────

S1. store.ts — sessions 初始值应从 localStorage 读取

  L58: `sessions: []` 硬编码空数组。Sidebar 的 useEffect 在 mount 后
  才 restoreSessions，导致首次渲染会话列表为空。

  改为：

    const initialSessions = (() => {
      try { const r = localStorage.getItem('prism-sessions'); return r ? JSON.parse(r) : []; }
      catch { return []; }
    })();

    // ...
    sessions: initialSessions,

  这样首次渲染就有数据，不需要等 Sidebar 的 effect。

S2. acp.rs — stderr drain 中 agent.name 的写法

  当前 working tree 里改成了 `agent_name` clone（解决 borrow checker），
  方向对。commit 它。

S3. ChatView.tsx — 新增 `invoke` import 未使用

  diff 显示 `import { invoke } from '@tauri-apps/api/core'` 但 ChatView
  中没有 invoke 调用。如果是为 export 按钮准备的，那没关系，后续会用到。

──────────────────────────────────────────
通过项
──────────────────────────────────────────

✅ agent_config.rs — include_str! 嵌入 YAML，零运行时 I/O
✅ agents.yaml — 结构清晰，Peri + Hermes 两个 agent
✅ acp.rs connect() — 正确抽象，env/cwd/args 全部可配
✅ acp.rs load_session / list_persisted — 正确调用 ACP 方法
✅ lib.rs AppState — agents + active_agent 字段合理
✅ lib.rs send_message — 'session block label 正确解锁
✅ lib.rs list_agents / switch_agent — 干净
✅ lib.rs load_persisted_session — 调 session/load + 注册本地
✅ store.ts addSession/removeSession/setSessionPeriId — localStorage 持久化
✅ Sidebar.tsx handleSelect — load 优先、fallback new 逻辑正确
✅ Sidebar.tsx restoreSessions useEffect — 启动恢复
✅ ChatView.tsx tool card — 改用 upd.toolCallId 匹配，修复多工具并行 bug
✅ ChatView.tsx formatToolInput — 按工具类型提取关键字段
✅ index.css — 删了重复 --accent，现在蓝色生效

──────────────────────────────────────────
改动量
──────────────────────────────────────────

  12 files, +657 / -75 lines
  acp.rs: connect +93, load/list +17, spawn -0 (待删)
  lib.rs: 6 命令 + Agent 管理 +140/-?
  agent_config.rs: 新 27 行
  agents.yaml: 新 13 行
  前端: store +29, Sidebar +25, ChatView +30
