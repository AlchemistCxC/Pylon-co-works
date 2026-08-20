import { useEffect, useState } from 'react'
import Select from '../ui/Select.tsx'
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
import { IS_TAURI } from '../../infrastructure/tauri/env'
import {
  loadRetentionPolicy,
  previewRetentionPolicy,
  pruneRetentionPolicy,
  retentionErrorCode,
  retentionErrorMessage,
  saveRetentionPolicy,
  type RetentionPolicySnapshot,
  type RetentionPreview,
} from '../../retentionPolicyRepository'

/**
 * HistoryRetention — 消息历史保留策略设置（I13-A-FE-02，D-03/D-15）。
 *
 * I13-W3：Tauri 模式保留策略真值迁移到后端权威存储（retention_policy_get/set，
 * versioned + revision 乐观并发），localStorage 不再是 Tauri 模式真值；browser
 * 模式（无后端）保持 localStorage 既有路径。
 *
 * 设置页**只写策略**，不绕过 Rust 数据层删除：
 * - 切换下拉/档位仅持久化策略，绝不触发删除；
 * - 非永久策略必须显示预计影响（D-15），并明确「保存策略不等于立即清理」；
 * - 默认永久保存；新安装/字段缺失/解析失败回退永久保存；
 * - 后端 payload 损坏回退 permanent 时显示 warning，不静默覆盖（D-15）；
 * - revision 冲突（别处已改）→ 重读最新值 + 提示，旧写不覆盖新写。
 * A1-c/B5：清理执行已切到 canonical_events（唯一会话数据源）；by_count =
 * 每 owner 保留最近 N 条 canonical 事件。本组件无删除路径之外语义变化。
 */

export default function HistoryRetention() {
  // browser 模式同步就绪（保持既有 localStorage 行为，测试/无后端环境不受影响）；
  // Tauri 模式异步加载后端权威值（loading skeleton）。
  const [snapshot, setSnapshot] = useState<RetentionPolicySnapshot | null>(() =>
    IS_TAURI
      ? null
      : { policy: readRetentionPolicy(localStorage), revision: null, source: 'local', corruptWarning: null },
  )
  const [loading, setLoading] = useState(IS_TAURI)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // I13-W4：立即清理流（preview 影响 → 二次确认 → prune → 结果；stale/失败可重试）
  const [preview, setPreview] = useState<RetentionPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [cleanError, setCleanError] = useState<string | null>(null)
  const [cleanResult, setCleanResult] = useState<RetentionPreview | null>(null)

  const reload = () => {
    setLoading(true)
    setLoadError(null)
    // 不清 saveError：冲突重读后需保留「已在别处修改」提示；下次保存时再清
    loadRetentionPolicy(localStorage)
      .then(next => setSnapshot(next))
      .catch(error => setLoadError(retentionErrorMessage(error)))
      .finally(() => setLoading(false))
  }

  // A1-c/B5：Tauri 模式重接后端权威值（canonical retention 已就绪）；browser
  // 模式从 localStorage 同步初始化（见 useState 初值），无需异步加载。
  useEffect(() => {
    if (IS_TAURI) void reload()
  }, [])

  const update = (next: RetentionPolicy) => {
    if (!snapshot) return
    // 策略已变 → 旧 preview/清理结果失效，重置（W4 CR-001：改下拉后不得沿用旧预览统计）
    const resetCleanState = () => {
      setPreview(null)
      setConfirming(false)
      setCleanResult(null)
      setCleanError(null)
    }
    if (snapshot.source === 'local') {
      writeRetentionPolicy(localStorage, next)
      setSnapshot({ ...snapshot, policy: next })
      return
    }
    setSaving(true)
    setSaveError(null)
    saveRetentionPolicy(localStorage, next, snapshot.revision)
      .then(revision => {
        setSnapshot(current => (current ? { ...current, policy: next, revision, corruptWarning: null } : current))
        resetCleanState()
      })
      .catch(error => {
        if (retentionErrorCode(error) === 'retention_revision_conflict') {
          setSaveError('策略已在别处修改，已重新加载最新值')
          void reload()
        } else {
          setSaveError(`保存失败：${retentionErrorMessage(error)}`)
        }
      })
      .finally(() => setSaving(false))
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

  const policy = snapshot?.policy
  const impact = policy ? retentionPolicyImpact(policy) : null

  // I13-W4：立即清理 = 独立确认操作（preview → 确认 → prune），修改下拉项不触发任何删除
  const canClean = snapshot?.source === 'backend' && policy && policy.mode !== 'permanent'

  const startPreview = async () => {
    if (!snapshot || !policy || policy.mode === 'permanent' || saving) return
    setPreviewing(true)
    setCleanError(null)
    setCleanResult(null)
    setConfirming(false)
    setPreview(null)
    try {
      setPreview(await previewRetentionPolicy(policy))
    } catch (error) {
      setCleanError(`预览失败：${retentionErrorMessage(error)}`)
    } finally {
      setPreviewing(false)
    }
  }

  const confirmPrune = async () => {
    if (!snapshot || !policy) return
    setPruning(true)
    setCleanError(null)
    try {
      const result = await pruneRetentionPolicy(policy, snapshot.revision)
      setCleanResult(result)
      setPreview(null)
      setConfirming(false)
    } catch (error) {
      if (retentionErrorCode(error) === 'retention_stale_preview') {
        // 预览后策略已变 → 拒绝按旧统计执行，重读最新策略要求重新预览
        setCleanError('策略已变化，请重新预览后再确认清理')
        setPreview(null)
        setConfirming(false)
        void reload()
      } else {
        setCleanError(`清理失败：${retentionErrorMessage(error)}`)
        setConfirming(false)
      }
    } finally {
      setPruning(false)
    }
  }

  // A1-c/B5：清理执行已切到 canonical_events；Tauri 下保留策略 UI 重新开放。
  return (
    <div className="set-group">
      <h3 className="set-group-inner-title">历史保留策略</h3>
      {loadError ? (
        <>
          <div className="set-hint" role="alert">{loadError}</div>
          <div className="set-preset-row">
            <button type="button" className="ps-btn sm" onClick={reload}>重试</button>
          </div>
        </>
      ) : loading || !snapshot || !policy ? (
        <div className="set-hint">正在加载保留策略…</div>
      ) : (
        <>
          {snapshot.corruptWarning && <div className="set-hint set-impact" role="alert">{snapshot.corruptWarning}</div>}
          <div className="set-row">
            <span className="set-row-label">保留策略</span>
            <Select ariaLabel="保留策略" className="set-select" value={policy.mode} disabled={saving} onChange={value => changeMode(value as RetentionMode)} options={RETENTION_MODE_OPTIONS.map(option => ({ value: option.value, label: option.label }))} />
          </div>
          {policy.mode === 'by_time' && (
            <div className="set-row">
              <span className="set-row-label">保留天数</span>
              <Select ariaLabel="保留天数" className="set-select" value={String(policy.days ?? DEFAULT_TIME_DAYS)} disabled={saving} onChange={value => update({ mode: 'by_time', days: Number(value) })} options={RETENTION_TIME_DAYS.map(days => ({ value: String(days), label: `${days} 天` }))} />
            </div>
          )}
          {policy.mode === 'by_count' && (
            <div className="set-row">
              <span className="set-row-label">每会话保留事件数</span>
              <Select ariaLabel="每会话保留事件数" className="set-select" value={String(policy.count ?? DEFAULT_COUNT_LIMIT)} disabled={saving} onChange={value => update({ mode: 'by_count', count: Number(value) })} options={RETENTION_COUNT_LIMITS.map(count => ({ value: String(count), label: `${count} 条` }))} />
            </div>
          )}
          {impact && <div className="set-hint set-impact" role="status">{impact.text}</div>}
          {saveError && <div className="set-hint" role="alert">{saveError}</div>}
          {saving && <div className="set-hint">保存中…</div>}
          {canClean && (
            <>
              <div className="set-preset-row">
                <button type="button" className="ps-btn sm" disabled={previewing || pruning || saving}
                  onClick={() => void startPreview()}>
                  {previewing ? '预览中…' : '立即清理'}
                </button>
                {preview && !confirming && (
                  <button type="button" className="ps-btn sm danger" disabled={pruning}
                    onClick={() => setConfirming(true)}>
                    确认清理
                  </button>
                )}
                {confirming && (
                  <>
                    <button type="button" className="ps-btn sm danger" disabled={pruning || saving}
                      onClick={() => void confirmPrune()}>
                      {pruning ? '清理中…' : '确认执行'}
                    </button>
                    <button type="button" className="ps-btn sm" disabled={pruning}
                      onClick={() => setConfirming(false)}>取消</button>
                  </>
                )}
              </div>
              {preview && (
                <div className="set-hint set-impact" role="status">
                  预览：将删除 {preview.totalCandidates} 条事件，影响 {preview.affectedSessions} 个会话
                  {preview.oldestDeletedAt != null
                    ? `（最早删除时间 ${new Date(preview.oldestDeletedAt).toLocaleString('zh-CN')}）`
                    : ''}
                </div>
              )}
              {cleanResult && (
                <div className="set-hint" role="status">
                  已清理 {cleanResult.totalCandidates} 条事件，影响 {cleanResult.affectedSessions} 个会话
                </div>
              )}
              {cleanError && <div className="set-hint" role="alert">{cleanError}</div>}
            </>
          )}
          <div className="set-hint">立即清理是独立确认操作；修改下拉项只保存策略，不会删除任何事件。</div>
        </>
      )}
    </div>
  )
}
