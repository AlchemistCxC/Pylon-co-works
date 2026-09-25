/**
 * 错误码 → 人话解释的**单点收口**（#325）。
 *
 * 错误中心与聊天内错误卡的技术详情区此前只输出裸码（`config_revision_conflict`、
 * `provider.error`…），用户看到一串内部标识符无从下手。本表是前端**唯一**的一张码表：
 * 展示面取 `explainErrorCode(code)`，未知码返回 null → 界面保留原文（不猜、不吞）。
 *
 * 码的**拼写**归 Rust 各域的单源方法（`PylonError::code` / `AcpError::code` /
 * `SessionError::code` / `ConfigError::code` / `EventError::code` / `MessageError::code` /
 * `UserDataError::code` / `RetentionError::code` 与 pylon-core 探测诊断；先例见
 * `pylon-acp/src/error.rs` 的 `wire_codes_are_stable_and_machine_readable`）。
 * 本表只负责**解释**，不重新定义码；`errorCodeExplanations.test.ts` 以精确集合看守，
 * 防止悄悄改词或漏码。
 *
 * 只写"这意味着什么 + 能做什么"，不写实现细节（错误码本身已由界面在旁展示）。
 */
export interface ErrorCodeExplanation {
  /** 一句话：这个失败意味着什么。 */
  readonly summary: string
  /** 常见下一步（可选；能给可操作建议时才写）。 */
  readonly hint?: string
}

export const ERROR_CODE_EXPLANATIONS: Readonly<Record<string, ErrorCodeExplanation>> = Object.freeze({
  // ── Agent 启动与连接（宿主 agent 域）──
  agent_executable_missing: { summary: '配置里那个可执行文件不存在或不可执行', hint: '在 设置 → Agent 里重新选择 exe 路径' },
  agent_spawn_failed: { summary: 'Agent 进程启动失败', hint: '确认该程序能独立运行，并检查运行日志里的系统错误' },
  agent_initialize_failed: { summary: 'Agent 启动了，但 ACP 握手没通过', hint: '确认这是支持 ACP 的 Agent，且版本不过旧' },
  agent_connection_timeout: { summary: '连接 Agent 超时，未在预算内完成握手', hint: '可能是首次启动较慢或进程卡住；查看运行日志后重试' },
  agent_crashed: { summary: 'Agent 进程意外退出' },
  agent_runtime_unavailable: { summary: '当前没有可用的 Agent 运行时', hint: '先在 设置 → Agent 中完成连接' },
  no_active_agent: { summary: '还没有选择要使用的 Agent', hint: '在 设置 → Agent 中新建或切换一个 Agent' },
  agent_detection_refresh_cancelled: { summary: '本机探测被取消（离开页面或重新发起）' },

  // ── Agent 探测（pylon-core 诊断码）──
  version_probe_spawn_failed: { summary: '系统拒绝执行该程序（不是有效的可执行文件）' },
  version_probe_timeout: { summary: '探测超时，该程序未在预算内返回版本信息' },
  version_probe_wait_failed: { summary: '等待探测子进程结束时失败' },
  version_probe_non_zero: { summary: '该程序返回了非零退出码，不像常规 Agent 可执行文件' },
  version_probe_empty: { summary: '程序能运行，但没输出版本信息' },
  detection_budget_exhausted: { summary: '本机探测的总时间预算用尽，部分候选未探测', hint: '点「重试探测」可重新发起一轮完整探测' },
  unknown_detector_id: { summary: '请求了未知的探测器标识' },
  candidate_limit_reached: { summary: '发现的候选超过上限，已按优先级截断一部分' },
  adapter_version_below_declared_minimum: { summary: '该 Agent 的版本低于目录声明的最低要求', hint: '升级该 Agent 后可重新探测' },

  // ── 会话与存储 ──
  session_not_found: { summary: '这个会话不存在（可能已被删除或归档）' },
  session_binding_unavailable: { summary: '会话绑定不可用，当前 Agent 无法接管它' },
  session_deleted: { summary: '会话已被删除，相关记录不再可用' },
  event_session_deleted: { summary: '会话已被删除，无法继续写入事件' },
  event_revision_conflict: { summary: '并发写入冲突：事件流已被别处改动', hint: '界面会自动按最新版本重放；持续出现请反馈' },
  event_repo_corrupt: { summary: '事件存储内容损坏' },
  event_repo_constraint: { summary: '事件写入违反了存储约束' },
  event_repo_conflict: { summary: '事件写入冲突' },
  event_db_unavailable: { summary: '事件数据库暂时不可用' },
  event_invalid: { summary: '事件数据本身不合法（被存储层拒绝）' },
  message_repo_corrupt: { summary: '消息记录损坏' },
  message_repo_constraint: { summary: '消息写入违反了存储约束' },
  message_repo_conflict: { summary: '消息写入冲突' },
  message_db_unavailable: { summary: '消息数据库暂时不可用' },
  replay_truncated: { summary: '会话回放被截断（历史过长，只重放了最近一段）' },
  replay_load_in_progress: { summary: '会话正在回放加载中，稍后重试即可' },
  replay_timeout: { summary: '回放超时' },
  replay_lag: { summary: '回放落后于实时流（追赶中）' },
  replay_transport_error: { summary: '回放通道中断' },
  database_future_schema: { summary: '数据文件来自更新的 Pylon 版本，当前版本读不了', hint: '升级 Pylon 后再打开这个数据目录' },
  database_schema_invalid: { summary: '数据文件结构非法，无法读取' },
  database_integrity_failed: { summary: '数据完整性校验失败' },

  // ── 会话保留策略 ──
  invalid_retention_policy: { summary: '保留策略本身不合法（被拒绝保存）' },
  retention_unavailable: { summary: '保留策略存储暂时不可用' },
  retention_revision_conflict: { summary: '保留策略已被别处改动，本次修改基于旧版本', hint: '重新打开设置页会刷新到最新版本' },
  retention_stale_preview: { summary: '预览已过期（期间策略被改动），请重新预览' },

  // ── 用户数据 ──
  user_data_revision_conflict: { summary: '用户数据已被别处改动，本次修改基于旧版本' },
  user_data_unavailable: { summary: '用户数据存储暂时不可用' },
  user_data_corrupt: { summary: '用户数据损坏' },
  user_data_not_found: { summary: '要读写的用户数据不存在' },
  invalid_owner_key: { summary: '数据归属键非法' },

  // ── 配置（agents.yaml / 网关 / 主题 envelope）──
  config_error: { summary: '配置内容不合法' },
  config_read_error: { summary: '读不到配置文件', hint: '确认 设置 → Agent 里的配置路径存在且可读' },
  config_parse_error: { summary: '配置文件语法有错（YAML 解析失败）', hint: '先在 设置 → Agent 的高级 YAML 区修正语法' },
  config_invalid_agent: { summary: '某个 Agent 的配置字段非法', hint: '错误详情里会指出是哪个 Agent' },
  config_read_only: { summary: '当前配置来自内嵌兜底或只读位置，不能直接写入', hint: '新建 Agent 时 Pylon 会在 exe 旁生成 agents.yaml' },
  config_write_error: { summary: '写配置文件失败', hint: '确认配置文件可写（未被占用、目录存在）' },
  config_revision_conflict: { summary: '配置文件已被别处改动，本次保存基于旧版本', hint: '点「重载配置」拿到最新内容后再保存' },
  config_revision_required: { summary: '保存缺少版本号（revision）而无法保证不覆盖别人的改动' },
  config_backup_error: { summary: '写入前的备份步骤失败', hint: '确认配置目录可写' },
  config_lock_busy: { summary: '另一处正在写入配置，请稍后重试' },
  config_active_agent_protected: { summary: '不能删除当前正在使用的 Agent', hint: '先切换到别的 Agent 再删除它' },
  config_not_applied: { summary: '改动已落盘但未生效（需要重连 Agent）' },

  // ── ACP 传输（pylon-acp 引擎）──
  acp_error: { summary: 'Agent 通信协议层报错' },
  connect_error: { summary: '与 Agent 建立连接失败' },
  connection_closed: { summary: '与 Agent 的连接已关闭' },
  transport_error: { summary: 'Agent 子进程通道出错' },
  write_timeout: { summary: '向 Agent 写入超时' },
  rpc_timeout: { summary: '等待 Agent 响应超时' },
  rpc_error: { summary: 'Agent 返回了协议层错误' },

  // ── 其它宿主域 ──
  serialize_error: { summary: '数据序列化失败（内部不一致）' },
  io_error: { summary: '文件读写失败' },
  protocol_error: { summary: '协议或内部状态不一致' },
  workspace_error: { summary: '工作区操作失败' },
  prism_error: { summary: 'Prism 服务调用失败' },
  git_error: { summary: 'Git 操作失败' },
  command_error: { summary: '命令执行失败' },

  // ── 前端语义码（不在 Rust 词表内，但会出现在错误中心）──
  'provider.error': { summary: 'Agent 上报了一个错误' },
  'turn.failed': { summary: '本轮处理失败' },
  'wire.unknown': { summary: '收到了当前版本不认识的协议帧' },
  'renderer.mount.failed': { summary: '渲染器挂载失败' },
})

/** 取某个码的人话解释；未知码返回 null（调用方保留原文展示）。 */
export function explainErrorCode(code: string | undefined | null): ErrorCodeExplanation | null {
  if (!code) return null
  return ERROR_CODE_EXPLANATIONS[code] ?? null
}
