import type { AgentSidebarContributionProps } from '../../../plugin-runtime/sidebar/sidebarTypes.ts'

/**
 * 左栏「模块区」的占位区块。
 *
 * **这四个是 mock，不是产品功能。** 它们存在的目的是把区块栈模型压到真实排版里：
 * 各有不同体型（列表 / 列表+开关 / 计数量表 / 摘要+动作），且**前两个声明了 `page`**
 * ——点击它们的标题会把内容展开成主区整页，用来同时验证「只能折叠」与「可展开成页」
 * 两种模块形态。数据是静态常量，不接任何域。
 *
 * 真实能力落地时逐个替换本文件的导出即可——注册点、宿主外壳、折叠状态、
 * `page` 声明与 `headerActions` 协议都不需要再动。
 *
 * 同一组件以两种体量出现（`presentation`）：区块里给紧凑小样，整页里铺开更多细节。
 */

const MOCK_SCHEDULES = [
  { id: 's1', name: '每日构建巡检', cron: '每天 09:00', state: 'idle', lastRun: '昨天 09:00', nextRun: '明天 09:00' },
  { id: 's2', name: '依赖升级检查', cron: '每周一 10:30', state: 'running', lastRun: '周一 10:30', nextRun: '下周一 10:30' },
  { id: 's3', name: '长会话清理', cron: '每月 1 日', state: 'paused', lastRun: '本月 1 日', nextRun: '已暂停' },
] as const

const MOCK_AUTOMATIONS = [
  { id: 'a1', name: '提交前跑单测', trigger: 'git commit 前', enabled: true, action: '运行 bun test' },
  { id: 'a2', name: 'PR 打开时摘要', trigger: 'pull_request.opened', enabled: false, action: '总结改动并发评论' },
] as const

const MOCK_TASKS = { running: 2, queued: 5, done: 18, total: 25 }

export function ScheduledBlock({ presentation = 'block' }: Partial<AgentSidebarContributionProps>) {
  const isPage = presentation === 'page'
  return (
    <div className={isPage ? 'mock-page' : undefined}>
      {isPage && <p className="mock-page-lead">按计划唤醒 Agent。这里只是占位，尚未接调度器。</p>}
      <ul className="sidebar-block-list" aria-label="定时任务">
        {MOCK_SCHEDULES.map(item => (
          <li className="sidebar-block-row" key={item.id} data-state={item.state}>
            <span className="sidebar-block-status" aria-hidden="true" />
            <span className="sidebar-block-row-copy">
              <span className="sidebar-block-row-name">{item.name}</span>
              <span className="sidebar-block-row-meta">{item.cron}</span>
            </span>
            {isPage && (
              <span className="mock-row-cols">
                <span className="sidebar-block-row-meta">上次 {item.lastRun}</span>
                <span className="sidebar-block-row-meta">下次 {item.nextRun}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AutomationBlock({ presentation = 'block' }: Partial<AgentSidebarContributionProps>) {
  const isPage = presentation === 'page'
  return (
    <div className={isPage ? 'mock-page' : undefined}>
      {isPage && <p className="mock-page-lead">规则式自动化。占位内容，未接 hook 运行时。</p>}
      <ul className="sidebar-block-list" aria-label="自动化">
        {MOCK_AUTOMATIONS.map(item => (
          <li className="sidebar-block-row" key={item.id} data-enabled={item.enabled ? 'true' : 'false'}>
            <span className="sidebar-block-row-copy">
              <span className="sidebar-block-row-name">{item.name}</span>
              <span className="sidebar-block-row-meta">{isPage ? `${item.trigger} → ${item.action}` : item.trigger}</span>
            </span>
            <span className="sidebar-block-switch" role="img" aria-label={item.enabled ? '已启用' : '已停用'} />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TasksBlock() {
  return (
    <div className="sidebar-block-metrics">
      <div className="sidebar-block-metric"><strong>{MOCK_TASKS.running}</strong><span>进行中</span></div>
      <div className="sidebar-block-metric"><strong>{MOCK_TASKS.queued}</strong><span>待办</span></div>
      <div className="sidebar-block-metric"><strong>{MOCK_TASKS.done}</strong><span>已完成</span></div>
      <div className="sidebar-block-progress" role="img" aria-label={`进度 ${MOCK_TASKS.done}/${MOCK_TASKS.total}`}>
        <span style={{ width: `${Math.round((MOCK_TASKS.done / MOCK_TASKS.total) * 100)}%` }} />
      </div>
    </div>
  )
}

export function ExtensionsBlock() {
  return (
    <div className="sidebar-block-summary">
      <span className="sidebar-block-row-meta">已启用 3 个扩展 · 1 个待重启</span>
      <button type="button" className="sidebar-block-cta" disabled>管理…</button>
    </div>
  )
}
