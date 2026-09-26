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
 *
 * `recovery`（#338）：错误中心恢复按钮按码派生的**单源**——解释与下一步动作同表维护，
 * hint 语义指向哪里、按钮就路由到哪里。未标注的码由 `recoveryForCode` 兜底为
 * 「查看运行日志」（纯诊断动作，不猜修复方式）。
 */
import type { RecoveryKind } from './runtimeError.ts'

export interface ErrorCodeExplanation {
  /** 一句话：这个失败意味着什么。 */
  readonly summary: string
  /** 常见下一步（可选；能给可操作建议时才写）。 */
  readonly hint?: string
  /** 错误中心恢复按钮的路由（#338）；缺省走「查看运行日志」诊断兜底。 */
  readonly recovery?: RecoveryKind
}

/**
 * Agent 崩溃原因（pylon-acp `CrashReason` wire 词表）的子表。
 *
 * 与 Rust 侧 `engine.rs::CrashReason::as_str` 的封闭集**双向精确对齐**，由
 * `scripts/acp-vocabulary.test.mts` 静态比对看守：Rust 增删变体而本表不同步、
 * 或本表残留死码（先例：#348 A1 摘除 `WriterTimeout` 后 `writer_timeout` 词条
 * 滞留，#357），门禁都红灯。`pending_lock_poisoned` 属 #348 返工裁定的一对
 * 豁免保留（Rust 变体无产生点但因本词条而暂留），摘除须两侧同轮。
 */
const ACP_CRASH_CAUSE_EXPLANATIONS = {
  writer_failed: { summary: 'Agent 进程管道通信失败（stdin 写 / stdout 读物理 IO 错误），连接已按崩溃收敛', hint: '在运行日志里查看该进程的最后输出' },
  stdout_closed: { summary: 'Agent 进程已退出（标准输出关闭）' },
  pending_lock_poisoned: { summary: '内部状态锁中毒，连接已按崩溃收敛', hint: '重启 Pylon 后重试；持续出现请反馈' },
  overloaded: { summary: 'Agent 入站事件速率超过背压上限，连接按过载收敛（事件有缺口）' },
} satisfies Record<string, ErrorCodeExplanation>

/** `CrashReason` wire 码的前端镜像（门禁比对面，见上）。 */
export const ACP_CRASH_CAUSE_CODES: readonly string[] = Object.keys(ACP_CRASH_CAUSE_EXPLANATIONS)

export const ERROR_CODE_EXPLANATIONS: Readonly<Record<string, ErrorCodeExplanation>> = Object.freeze({
  // ── Agent 启动与连接（宿主 agent 域）──
  agent_executable_missing: { summary: '配置里那个可执行文件不存在或不可执行', hint: '在 设置 → Agent 里重新选择 exe 路径', recovery: 'select-agent-executable' },
  agent_spawn_failed: { summary: 'Agent 进程启动失败', hint: '确认该程序能独立运行，并检查运行日志里的系统错误', recovery: 'open-runtime-log' },
  agent_initialize_failed: { summary: 'Agent 启动了，但 ACP 握手没通过', hint: '确认这是支持 ACP 的 Agent，且版本不过旧', recovery: 'open-runtime-log' },
  agent_connection_timeout: { summary: '连接 Agent 超时，未在预算内完成握手', hint: '可能是首次启动较慢或进程卡住；查看运行日志后重试', recovery: 'open-runtime-log' },
  agent_crashed: { summary: 'Agent 进程意外退出', recovery: 'open-runtime-log' },
  agent_runtime_unavailable: { summary: '当前没有可用的 Agent 运行时', hint: '先在 设置 → Agent 中完成连接', recovery: 'open-agent-settings' },
  no_active_agent: { summary: '还没有选择要使用的 Agent', hint: '在 设置 → Agent 中新建或切换一个 Agent', recovery: 'open-agent-settings' },
  agent_spawn_io_failed: { summary: '启动 Agent 进程时发生 IO 错误', hint: '确认该程序存在且当前用户有权执行', recovery: 'open-runtime-log' },
  // Agent 崩溃的具体原因（子表见 ACP_CRASH_CAUSE_EXPLANATIONS，词表由门禁对齐）
  ...ACP_CRASH_CAUSE_EXPLANATIONS,

  // ── Agent 探测（pylon-core 诊断码）──
  version_probe_spawn_failed: { summary: '无法执行该程序（不存在、无权限，或不是有效的可执行文件）', hint: '在 设置 → Agent 里重新选择 exe 路径', recovery: 'select-agent-executable' },
  version_probe_timeout: { summary: '探测超时，该程序未在预算内返回版本信息' },
  version_probe_wait_failed: { summary: '等待探测子进程结束时失败' },
  version_probe_non_zero: { summary: '该程序返回了非零退出码（版本探测未成功）' },
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
  config_read_error: { summary: '读不到配置文件', hint: '确认 设置 → Agent 里的配置路径存在且可读', recovery: 'open-agent-settings' },
  config_parse_error: { summary: '配置文件语法有错（YAML 解析失败）', hint: '先在 设置 → Agent 的高级 YAML 区修正语法', recovery: 'open-agent-settings' },
  config_invalid_agent: { summary: '某个 Agent 的配置字段非法', hint: '错误详情里会指出是哪个 Agent', recovery: 'open-agent-settings' },
  config_read_only: { summary: '当前配置来自内嵌兜底或只读位置，不能直接写入', hint: '新建 Agent 时 Pylon 会在 exe 旁生成 agents.yaml', recovery: 'open-agent-settings' },
  config_write_error: { summary: '写配置文件失败', hint: '确认配置文件可写（未被占用、目录存在）', recovery: 'open-agent-settings' },
  config_revision_conflict: { summary: '配置文件已被别处改动，本次保存基于旧版本', hint: '点「重载配置」拿到最新内容后再保存', recovery: 'open-agent-settings' },
  config_revision_required: { summary: '保存缺少版本号（revision）而无法保证不覆盖别人的改动' },
  config_backup_error: { summary: '写入前的备份步骤失败', hint: '确认配置目录可写', recovery: 'open-agent-settings' },
  config_lock_busy: { summary: '另一处正在写入配置，请稍后重试' },
  config_active_agent_protected: { summary: '不能删除当前正在使用的 Agent', hint: '先切换到别的 Agent 再删除它', recovery: 'open-agent-settings' },
  config_not_applied: { summary: '改动已写入磁盘，但当前运行中的配置还没切换过去', hint: '重载配置或重连 Agent 后生效', recovery: 'open-agent-settings' },

  // ── ACP 传输（pylon-acp 引擎）──
  acp_error: { summary: 'Agent 通信协议层报错' },
  connect_error: { summary: '与 Agent 建立连接失败', recovery: 'open-runtime-log' },
  connection_closed: { summary: '与 Agent 的连接已关闭', recovery: 'open-runtime-log' },
  transport_error: { summary: 'Agent 子进程通道出错', recovery: 'open-runtime-log' },
  write_timeout: { summary: '向 Agent 写入超时', recovery: 'open-runtime-log' },
  rpc_timeout: { summary: '等待 Agent 响应超时', recovery: 'open-runtime-log' },
  rpc_error: { summary: 'Agent 返回了协议层错误', recovery: 'open-runtime-log' },

  // ── 其它宿主域 ──
  serialize_error: { summary: '数据序列化失败（内部不一致）' },
  io_error: { summary: '文件读写失败' },
  protocol_error: { summary: '协议或内部状态不一致' },
  workspace_error: { summary: '工作区操作失败' },
  prism_error: { summary: 'Prism 服务调用失败' },
  git_error: { summary: 'Git 操作失败' },
  command_error: { summary: '命令执行失败（含 CLI/插件进程、窗口捕获等宿主命令）' },

  // ── 前端语义码（不在 Rust 词表内，但会出现在错误中心）──
  'provider.error': { summary: 'Agent 上报了一个错误' },
  'turn.failed': { summary: '本轮处理失败' },
  'wire.unknown': { summary: '收到了当前版本不认识的协议帧' },
  'renderer.slot.mount.failed': { summary: '渲染器挂载失败' },
  'renderer.slot.runtime.failed': { summary: '渲染器运行时失败' },
  application_mount_failed: { summary: '应用界面初始化失败' },

  // ── Gateway / 实例存储 ──
  gateway_adapter_unavailable: { summary: '网关平台适配器不可用' },
  gateway_config_lock_poisoned: { summary: '网关配置锁中毒（内部状态异常）', hint: '重启 Pylon 后重试' },
  gateway_delivery_failed: { summary: '网关消息投递失败' },
  gateway_instance_not_connected: { summary: '该网关实例尚未连接，无法执行此操作', hint: '先连接实例再重试' },
  gateway_instance_not_found: { summary: '该网关实例不存在' },
  gateway_invalid_config: { summary: '网关配置不合法' },
  adapter_unavailable: { summary: '平台适配器不可用' },
  route_in_use: { summary: '该路由正在被使用，不能删除', hint: '先解除引用或停用相关实例' },
  invalid_transition: { summary: '当前状态下不允许这个操作', hint: '先完成或取消进行中的状态变更' },
  instance_not_found: { summary: '该实例不存在' },
  instance_store_corrupt: { summary: '实例存储内容损坏' },
  instance_store_io: { summary: '实例存储读写失败' },
  instance_store_write_failed: { summary: '写入实例存储失败' },
  credential_missing: { summary: '缺少必要的凭据（如 token/密钥）', hint: '在对应设置里补全凭据' },
  credential_corrupt: { summary: '凭据内容损坏，无法解析' },
  credential_io: { summary: '凭据读写失败' },
  credential_key_unavailable: { summary: '凭据加密密钥不可用', hint: '确认系统密钥服务可用后重试' },
  credential_store_error: { summary: '凭据存储报错' },

  // ── 插件运行时 ──
  plugin_not_found: { summary: '插件不存在（可能已被移除）' },
  plugin_invalid_id: { summary: '插件 id 不合法' },
  plugin_manifest_invalid: { summary: '插件清单（pylon-plugin.json）不合法', hint: '对照随包的 manifest schema 修正' },
  plugin_io: { summary: '插件文件读写失败' },
  plugin_resource_invalid: { summary: '插件资源不合法' },
  plugin_source_invalid: { summary: '插件来源不合法' },
  plugin_state_conflict: { summary: '插件状态冲突' },
  plugin_transaction_failed: { summary: '插件事务失败' },
})

/** 取某个码的人话解释；未知码返回 null（调用方保留原文展示）。 */
export function explainErrorCode(code: string | undefined | null): ErrorCodeExplanation | null {
  if (!code) return null
  return ERROR_CODE_EXPLANATIONS[code] ?? null
}
