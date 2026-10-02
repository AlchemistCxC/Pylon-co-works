/** @jsxImportSource solid-js */
import { createComponent, createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import { render } from 'solid-js/web'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'
import { useCustomPresetStore } from '../../domains/theme/customPresetStore'
import { zonePresetsFor, isCustomZonePresetEntry, type ZonePresetEntry } from '../../domains/theme/zones/index.ts'
import { createZustandSignal } from '../../host/solidStoreBridge.ts'
import { bridgedProps } from '../../host/solidBridge.solid'

/**
 * settingsSectionShared.solid — Settings 共享呈现原语的 Solid 实体（#515）。
 *
 * #515 第二批收尾：`Group`（折叠组）、error key 口径（report/resolveSettingsError）
 * 在本实体落地面——此前 GlobalPresetSection.solid.tsx 因本文件在途而按同源口径本地
 * 声明过副本（其漂移由 Settings.customPreset 契约测试钉住；收拢副本由该文件归属批处理）。
 * React 世界（AgentSettingsSection / ZonePresetSection / settingsAgentActions 等
 * React 消费者）继续从 settingsSectionShared.tsx 消费——React 面文件不得静态回向引用
 * .solid 实体，因此该 .tsx 保留 React 实现与 ZonePresetRow 薄桥。
 */

export function Group(props: { title: string; children: JSX.Element; defaultOpen?: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? true)
  return (
    <div class="set-group">
      <button type="button" class="set-group-title" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="set-group-arrow">{open() ? '▾' : '▸'}</span>
        {props.title}
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  )
}

/** Settings 域内错误上报的统一 key 口径（agentActions 与预设事务共用；与
 * settingsSectionShared.tsx 的纯函数逐字一致）。 */
export function reportSettingsError(action: string, error: unknown, agentId?: string): ReturnType<typeof reportRuntimeError> {
  return reportRuntimeError(action, error, agentId, {
    key: `settings:${action}:${agentId ?? 'app'}`,
    scope: agentId ? { kind: 'agent', id: agentId } : { kind: 'app', id: 'settings' },
    source: 'settings',
  })
}

export function resolveSettingsError(action: string, agentId?: string): void {
  resolveRuntimeErrors({
    key: `settings:${action}:${agentId ?? 'app'}`,
  })
}

export interface ZonePresetRowProps {
  zone: ZonePresetEntry['zone']; interfaceMode: string; activeName: string; isDirty: boolean
  onApply: (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => void
  onSaveCurrent: (zone: ZonePresetEntry['zone'], name: string) => void
  onRemoveEntry: (id: string) => void
}

/**
 * 刀6（#206）：区域预设行。候选不再是「平铺 10 个整体预设」，而是该
 * (界面模式桶, 区域) 的池条目——出厂条目（存引用，应用时现场切）+ 自定义条目（存值快照）。
 * 未登记归属桶的界面模式（如 tactical-blue）⇒ 池为空 ⇒ **整组不渲染**（与刀5 同口径）。
 */
export function ZonePresetRow(props: ZonePresetRowProps) {
  const customEntries = createZustandSignal(useCustomPresetStore, s => s.zonePresetEntries)
  const entries = createMemo(() => zonePresetsFor(props.interfaceMode, props.zone, customEntries()))
  const [entryName, setEntryName] = createSignal('')
  // 刀7 前置（#211）：行内两段式确认的待删条目（照全局自定义预设先例，不常驻、不开模态）
  const [pendingDeleteEntryId, setPendingDeleteEntryId] = createSignal<string | null>(null)
  return (
    <Show when={entries().length > 0} fallback={null}>
      <Group title="局部预设">
        <div class="set-preset-row">
          <For each={entries()}>{entry => {
            const selected = () => props.activeName === entry.id && !props.isDirty
            // 刀7 前置（#211）出现条件：**只在自定义条目**上；普通条目「被选中才出现」
            // （那排 chip 本来就挤），Q8 灰显占位条目常驻——那是它唯一的自然出口。
            // 刀2（#223）起判据是显式来源字段 `origin`：出厂条目（`origin:'factory'`）**任何情况下**
            // 都不进入这一段（铁律 1：出厂件不可改、不可删）。
            const deletable = () => isCustomZonePresetEntry(entry) && (entry.stale === true || selected())
            return (
              <>
                <button type="button"
                  class={`set-preset-chip ${selected() ? 'active' : ''}`}
                  aria-current={selected() ? 'true' : undefined}
                  // Q8：清理后已无有效字段的自定义条目 = 行内占位（灰显、不可应用）；不给用户开关。
                  disabled={entry.stale === true}
                  title={entry.stale
                    ? '该条目引用的字段已被删除，值已自动清理，不能再应用'
                    : undefined}
                  onClick={() => props.onApply(props.zone, entry)}>{entry.label}</button>
                {/* 刀7 前置（#211）：删除钮只在 deletable 条目上出现（React 原版
                    `{deletable && (pending ? confirm : 删除)}` 的逐字对应——批1-A 曾把
                    删除钮误放进外层 fallback，导致出厂/未选中条目也被渲染删除钮）。 */}
                <Show when={deletable()}>
                  <Show when={pendingDeleteEntryId() === entry.id} fallback={
                    <button type="button" class="ps-btn sm danger"
                      onClick={() => setPendingDeleteEntryId(entry.id)}>删除</button>
                  }>
                    <div class="set-confirm set-confirm-inline" role="alertdialog" aria-label={`确认删除区域预设 ${entry.label}`}>
                      <span class="set-confirm-text">删除后不可恢复；将移除本区的自定义条目「{entry.label}」，本区保留现值但失去该预设基准。</span>
                      <div class="set-confirm-actions">
                        <button type="button" class="ps-btn sm danger"
                          onClick={() => { setPendingDeleteEntryId(null); props.onRemoveEntry(entry.id) }}>确认删除</button>
                        <button type="button" class="ps-btn sm" onClick={() => setPendingDeleteEntryId(null)}>取消</button>
                      </div>
                    </div>
                  </Show>
                </Show>
              </>
            )
          }}</For>
          <Show when={props.isDirty}><span class="set-preset-chip active">自定义</span></Show>
        </div>
        <div class="set-hint">只改本区外观参数，自动切换为自定义；改动后可存成属于本区的自定义条目</div>
        <div class="set-custom-preset-save">
          <input class="set-input" value={entryName()} onInput={event => setEntryName(event.currentTarget.value)} placeholder="区域预设名称" />
          <button type="button" class="ps-btn sm" disabled={!entryName().trim()} title={entryName().trim() ? undefined : '保存必须命名'}
            onClick={() => { props.onSaveCurrent(props.zone, entryName()); setEntryName('') }}>存当前</button>
        </div>
      </Group>
    </Show>
  )
}

/** React 薄桥（settingsSectionShared.tsx）经 eager glob 调用的挂载缝。 */
export function renderZonePresetRow(container: HTMLElement, latest: () => ZonePresetRowProps): () => void {
  return render(() => createComponent(ZonePresetRow, bridgedProps(latest)), container)
}
