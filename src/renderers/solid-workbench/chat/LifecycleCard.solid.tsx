import { Show } from 'solid-js'
import type { LifecycleState } from '../../../domains/workbench/lifecycle/lifecycleModel.ts'

export interface SolidLifecycleCardProps {
  state: LifecycleState
  reducedMotion?: boolean
}

/**
 * C13：生命周期卡（retry/compact/rewind/suspended/recovered）。
 * 数据来自 document.lifecycle 的 semantic snapshot；技术详情默认折叠；
 * 恢复动作经 command port（capability-gated），本组件不自行决定业务动作。
 */
export function SolidLifecycleCard(props: SolidLifecycleCardProps) {
  const phase = () => props.state.suspended ? 'suspended'
    : props.state.retry ? 'retry'
      : props.state.rewind?.phase === 'preview' ? 'rewind'
        : props.state.compact?.phase === 'started' ? 'compact'
          : props.state.lastRecovery ? 'recovered' : undefined
  return (
    <Show when={phase()}>
      {current => (
        <div
          class="lifecycle-card"
          data-phase={current()}
          data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
          role="status"
        >
          <Show when={props.state.retry}>
            {retry => (
              <div class="lifecycle-retry">
                <span class="lifecycle-label">第 {retry().attempt}{retry().maxAttempts !== undefined ? `/${retry().maxAttempts}` : ''} 次重试</span>
                <Show when={retry().delayMs !== undefined}>
                  <span class="lifecycle-delay">{`约 ${Math.round(retry()!.delayMs! / 1000)} 秒后自动继续`}</span>
                </Show>
                <Show when={retry().error}>
                  {error => (
                    <details class="lifecycle-technical">
                      <summary>{error().userSummary}</summary>
                      <pre>{error().technicalMessage ?? error().userSummary}{error().code ? `\ncode: ${error().code}` : ''}</pre>
                    </details>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <Show when={props.state.suspended}>
            {suspended => (
              <div class="lifecycle-suspended">
                <span class="lifecycle-label">已暂停</span>
                <Show when={suspended().reason}><span class="lifecycle-reason">{suspended().reason}</span></Show>
              </div>
            )}
          </Show>
          <Show when={props.state.compact?.phase === 'started'}>
            <div class="lifecycle-compacting"><span class="lifecycle-label">正在压缩上下文{props.state.compact?.strategy ? `（${props.state.compact.strategy}）` : ''}…</span></div>
          </Show>
          <Show when={props.state.rewind?.phase === 'preview'}>
            <div class="lifecycle-rewind-preview">
              <span class="lifecycle-label">回退预览</span>
              <Show when={(props.state.rewind?.files?.length ?? 0) > 0}>
                <span class="lifecycle-files">{`${props.state.rewind!.files!.length} 个文件将被还原`}</span>
              </Show>
              <Show when={props.state.rewind?.summary}><span class="lifecycle-reason">{props.state.rewind!.summary}</span></Show>
            </div>
          </Show>
          <Show when={current() === 'recovered' && props.state.history.filter(item => item.kind === 'compact').at(-1)}>
            {compact => (
              <div class="lifecycle-history">
                <span class="lifecycle-reason">{`压缩完成${compact().tokensBefore !== undefined && compact().tokensAfter !== undefined ? `（${compact().tokensBefore}→${compact().tokensAfter} tokens）` : ''}${compact().summary ? ` — ${compact().summary}` : ''}`}</span>
              </div>
            )}
          </Show>
          <Show when={props.state.lastRecovery}>
            {recovery => (
              <div class="lifecycle-recovery">
                <span class="lifecycle-label">{recovery().source === 'agent-import' ? '已从回放导入恢复' : '已从本地记录恢复'}</span>
                <Show when={recovery().importedEvents !== undefined}>
                  <span class="lifecycle-reason">{`导入 ${recovery()!.importedEvents} 条事件（未验证来源）`}</span>
                </Show>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}
