import { useState } from 'react'
import {
  DEFAULT_COUNT_LIMIT,
  DEFAULT_TIME_DAYS,
  RETENTION_COUNT_LIMITS,
  RETENTION_MODE_OPTIONS,
  RETENTION_TIME_DAYS,
  readRetentionPolicy,
  retentionPolicyImpact,
  writeRetentionPolicy,
  type RetentionMode,
  type RetentionPolicy,
} from './historyRetentionPolicy'

/**
 * HistoryRetention — 消息历史保留策略设置（I13-A-FE-02，D-03/D-15）。
 *
 * 设置页**只写策略**（localStorage 独立 key），不绕过 Rust 数据层删除：
 * - 切换下拉/档位仅持久化策略，绝不触发删除；
 * - 非永久策略必须显示预计影响（D-15），并明确「保存策略不等于立即清理」；
 * - 默认永久保存；新安装/字段缺失/解析失败回退永久保存。
 * 实际清理由后端（msg_repo 数据层）在事务边界安全调度，本组件无删除路径。
 */

export default function HistoryRetention() {
  const [policy, setPolicy] = useState<RetentionPolicy>(() => readRetentionPolicy(localStorage))

  const update = (next: RetentionPolicy) => {
    setPolicy(next)
    writeRetentionPolicy(localStorage, next)
  }

  const changeMode = (mode: RetentionMode) => {
    const next: RetentionPolicy =
      mode === 'by_time'
        ? { mode, days: DEFAULT_TIME_DAYS }
        : mode === 'by_count'
          ? { mode, count: DEFAULT_COUNT_LIMIT }
          : { mode }
    update(next)
  }

  const impact = retentionPolicyImpact(policy)

  return (
    <div className="set-group">
      <h3 className="set-group-inner-title">历史保留策略</h3>
      <div className="set-row">
        <span className="set-row-label">保留策略</span>
        <select
          aria-label="保留策略"
          className="set-select"
          value={policy.mode}
          onChange={event => changeMode(event.target.value as RetentionMode)}
        >
          {RETENTION_MODE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      {policy.mode === 'by_time' && (
        <div className="set-row">
          <span className="set-row-label">保留天数</span>
          <select
            aria-label="保留天数"
            className="set-select"
            value={String(policy.days ?? DEFAULT_TIME_DAYS)}
            onChange={event => update({ mode: 'by_time', days: Number(event.target.value) })}
          >
            {RETENTION_TIME_DAYS.map(days => (
              <option key={days} value={days}>{days} 天</option>
            ))}
          </select>
        </div>
      )}
      {policy.mode === 'by_count' && (
        <div className="set-row">
          <span className="set-row-label">每会话保留条数</span>
          <select
            aria-label="每会话保留条数"
            className="set-select"
            value={String(policy.count ?? DEFAULT_COUNT_LIMIT)}
            onChange={event => update({ mode: 'by_count', count: Number(event.target.value) })}
          >
            {RETENTION_COUNT_LIMITS.map(count => (
              <option key={count} value={count}>{count} 条</option>
            ))}
          </select>
        </div>
      )}
      {impact && <div className="set-hint set-impact" role="status">{impact.text}</div>}
      <div className="set-hint">设置页只保存策略，不会直接删除消息；自动清理由后端数据层在事务边界执行。</div>
    </div>
  )
}
