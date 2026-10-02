/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import { createSolidMount } from '../../host/solidBridge.solid'
import { createZustandSignal } from '../../host/solidStoreBridge.ts'
import { useStore } from '../../domains/theme/themeStore'
import { useCustomPresetStore } from '../../domains/theme/customPresetStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'
import { applyGlobalPreset as applyGlobalPresetTransaction } from '../../application/transactions/applyGlobalPreset.ts'
import { normalizeCustomPresetId } from '../../domains/theme/customPresets'
import type { PresetApplyResult } from '../../domains/theme/presetBundle.ts'
import { deriveGlobalStatus } from '../../domains/theme/presetReducer'
import { fallbackPresetChip, INTERFACE_MODE_PRESET_BUCKET, presetsForInterfaceMode } from '../../domains/theme/presets/index.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import type { ZoneName } from '../../domains/theme/themeFieldDefs'
import { ZoneGroupFields, type RenderCtx } from './themeFieldRenderer.solid.tsx'
import InterfaceModePicker from './InterfaceModePicker.solid.tsx'

/**
 * Settings 域内错误上报/解除的统一 key 口径——与 settingsSectionShared.tsx 的纯函数
 * 逐字一致（该 .ts(x) 是 React 面文件且 eager-glob 自身实体，solid 实体不做静态
 * 回向引用，此处按同源口径本地声明；漂移会被 Settings.customPreset 契约测试钉住）。
 */
function reportSettingsError(action: string, error: unknown, agentId?: string): ReturnType<typeof reportRuntimeError> {
  return reportRuntimeError(action, error, agentId, {
    key: `settings:${action}:${agentId ?? 'app'}`,
    scope: agentId ? { kind: 'agent', id: agentId } : { kind: 'app', id: 'settings' },
    source: 'settings',
  })
}

function resolveSettingsError(action: string, agentId?: string): void {
  resolveRuntimeErrors({
    key: `settings:${action}:${agentId ?? 'app'}`,
  })
}

/** 折叠 Group——settingsSectionShared.solid.tsx 内私有 Group 的同构本地副本
 * （该文件属 settings 在途批，不为本批扩其导出面；DOM/aria 逐字一致）。
 * Settings.solid 实体复用本副本（模板库 / 布局编辑 Group），避免养第三份。 */
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

export interface GlobalPresetSectionProps {
  isSearching: boolean
  /** 声明式字段组渲染上下文（原由 Settings.tsx 注入 children，#515 同批改 solid 直连）。 */
  ctx: RenderCtx
  density?: 'basic' | 'standard' | 'all'
}

/**
 * GlobalPresetSection — 设置页 global 分区的预设事务与呈现（A-V3 拆分自
 * Settings.tsx，逻辑逐字随迁）：界面模式组、全局预设 chips（含兜底 chip）、
 * 「保存当前为自定义预设」与应用/覆盖/删除（两段式确认）。自定义预设事务的
 * 竞态序号（presetApplyRequest）与反馈态由本组件自持。
 *
 * #515：第一批 deferred 项——原 props 含 children（Settings.tsx 注入的 React 子树
 * ZoneGroupFields），Settings 同批 Solid 化后改 solid 直连（本组件按 props.ctx/density
 * 直接渲染 ZoneGroupFields 的 Solid 实体，renderCtx 单源不变）。
 */
export default function GlobalPresetSection(props: GlobalPresetSectionProps) {
  const globalStatus = createZustandSignal(useStore, s => deriveGlobalStatus(s))
  const customPresets = createZustandSignal(useCustomPresetStore, s => s.customPresets)
  const currentInterfaceMode = createZustandSignal(useInterfaceModeStore, s => s.interfaceMode)
  const modeBucket = () => INTERFACE_MODE_PRESET_BUCKET[currentInterfaceMode()]
  /** #116 子项 7：预设行兜底 chip 的口径见 presets.ts 的 fallbackPresetChip。 */
  const fallbackPresetChipView = createMemo(() => fallbackPresetChip(globalStatus(), customPresets().map(preset => preset.id)))
  // 刀5（#201，UI 二次修订 2026-09-19）：当前模式不在归属表内（如 tactical-blue）⇒ 整组不出现。

  // #116 子项 9：破坏性操作（删除自定义预设）两段式确认。
  const [pendingDeletePresetId, setPendingDeletePresetId] = createSignal<string | null>(null)
  const [customPresetName, setCustomPresetName] = createSignal('')
  const [customPresetFeedback, setCustomPresetFeedback] = createSignal<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [applyingPresetId, setApplyingPresetId] = createSignal<string | null>(null)
  let presetApplyRequest = 0

  const applyGlobalPreset = (name: string) => {
    applyGlobalPresetTransaction(name)
  }

  const applyCustomPresetFromSettings = async (requestedId: string): Promise<PresetApplyResult> => {
    const id = normalizeCustomPresetId(requestedId)
    const request = ++presetApplyRequest
    setApplyingPresetId(id)
    setCustomPresetFeedback(null)
    try {
      const result = await useCustomPresetStore.getState().applyCustomPreset(id)
      if (request !== presetApplyRequest) return result
      if (result.status === 'applied') {
        resolveRuntimeErrors({ key: `preset:${id}` })
        resolveSettingsError('应用自定义预设')
        setCustomPresetFeedback({
          kind: 'success',
          message: result.unavailable && result.unavailable.length > 0
            ? `自定义预设已应用（不可用提供者：${result.unavailable.join('、')}）`
            : '自定义预设已应用',
        })
      } else {
        setCustomPresetFeedback({
          kind: 'error',
          message: `自定义预设应用失败（${result.failedProvider}）：${result.message}`,
        })
      }
      return result
    } catch (error) {
      const detail = reportSettingsError('应用自定义预设', error)
      const result: PresetApplyResult = {
        status: 'failed', id, failedProvider: 'unknown', message: detail.message, rolledBack: false, revision: request,
      }
      if (request === presetApplyRequest) setCustomPresetFeedback({ kind: 'error', message: `自定义预设应用失败：${detail.message}` })
      return result
    } finally {
      if (request === presetApplyRequest) setApplyingPresetId(null)
    }
  }

  /**
   * Custom preset persistence is a user action, so failures must stay visible
   * in this dialog. Previously an exception from provider capture (or a stale
   * overwrite id) escaped the click handler and looked like a dead button.
   */
  const saveCustomPresetFromSettings = (name: string, id?: string): string | undefined => {
    const isOverwrite = Boolean(id)
    try {
      const savedId = useCustomPresetStore.getState().saveCustomPreset(name, id)
      resolveSettingsError(isOverwrite ? '覆盖已有自定义预设' : '保存自定义预设')
      setCustomPresetFeedback({
        kind: 'success',
        message: isOverwrite ? '自定义预设已覆盖' : '自定义预设已保存',
      })
      return savedId
    } catch (error) {
      const action = isOverwrite ? '覆盖已有自定义预设' : '保存自定义预设'
      const detail = reportSettingsError(action, error)
      setCustomPresetFeedback({ kind: 'error', message: `${action}失败：${detail.message}` })
      return undefined
    }
  }

  return (
    <>
      <Show when={!props.isSearching}>
        <Group title="界面模式"><InterfaceModePicker /></Group>
      </Show>
      <Show when={!props.isSearching && modeBucket()}>
        <Group title="全局预设">
          <div class="set-preset-row">
            <For each={presetsForInterfaceMode(currentInterfaceMode())}>{p => (
              <button type="button" class={`set-preset-chip ${globalStatus() === p.name ? 'active' : ''}`}
                aria-current={globalStatus() === p.name ? 'true' : undefined}
                onClick={() => applyGlobalPreset(p.name)}>{p.label}</button>
            )}</For>
            {/* #116 子项 7：兜底 chip 原先直接输出 globalStatus 原文——它是 'custom'
                哨兵或自定义预设 id 时会把内部标识当预设名显示，且与下方
                .set-custom-presets 里的具名 chip 重复点亮。现在：自定义预设 id 由
                具名列表负责（此处不出兜底），'custom' 哨兵显示为「自定义」，其余
                无法识别的值显示为「未知预设」并把原值留在 title/data 上供排查。 */}
            <Show when={fallbackPresetChipView()}>
              <button type="button" class="set-preset-chip active" aria-current="true"
                title={fallbackPresetChipView()!.title} data-preset-status={globalStatus()}>{fallbackPresetChipView()!.label}</button>
            </Show>
          </div>
          <div class="set-hint">
            {globalStatus() === 'custom'
              ? '当前为自定义 — 可保存为新预设或覆盖已有自定义预设'
              : '选择预设后修改任意外观参数，自动切换为自定义'}
          </div>
          <div class="set-custom-preset-save">
            <input class="set-input" value={customPresetName()} onInput={event => setCustomPresetName(event.currentTarget.value)} placeholder="自定义预设名称" />
            {/* A3：保存必须命名——空名禁用按钮（数据层 saveCustomPresetReducer 抛错兜底），不再静默 return */}
            <button type="button" class="ps-btn sm" disabled={!customPresetName().trim()} title={customPresetName().trim() ? undefined : '保存必须命名'}
              onClick={() => {
                const id = saveCustomPresetFromSettings(customPresetName())
                if (id) {
                  void applyCustomPresetFromSettings(id).then(result => {
                    if (result.status === 'applied') setCustomPresetName('')
                  })
                }
              }}>保存当前</button>
          </div>
          <Show when={customPresetFeedback()}>
            <div class={`set-hint custom-preset-feedback ${customPresetFeedback()!.kind === 'error' ? 'is-error' : 'is-success'}`}
              role={customPresetFeedback()!.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
              {customPresetFeedback()!.message}
            </div>
          </Show>
          <Show when={customPresets().length > 0}>
            <div class="set-custom-presets">
              <For each={customPresets()}>{preset => (
                <div class="set-custom-preset">
                  <button type="button" class={`set-preset-chip ${globalStatus() === preset.id ? 'active' : ''}`} disabled={applyingPresetId() !== null} aria-busy={applyingPresetId() === preset.id || undefined} onClick={() => { void applyCustomPresetFromSettings(preset.id) }}>{preset.name}</button>
                  <button type="button" class="ps-btn sm" onClick={() => { void saveCustomPresetFromSettings(preset.name, preset.id) }}>覆盖</button>
                  <Show when={pendingDeletePresetId() === preset.id} fallback={
                    <button type="button" class="ps-btn sm danger" onClick={() => setPendingDeletePresetId(preset.id)}>删除</button>
                  }>
                    <div class="set-confirm set-confirm-inline" role="alertdialog" aria-label={`确认删除预设 ${preset.name}`}>
                      <span class="set-confirm-text">删除后不可恢复；引用它的区域会保留现值但失去预设基准。</span>
                      <button type="button" class="ps-btn sm danger"
                        onClick={() => { setPendingDeletePresetId(null); useCustomPresetStore.getState().removeCustomPreset(preset.id) }}>确认删除</button>
                      <button type="button" class="ps-btn sm" onClick={() => setPendingDeletePresetId(null)}>取消</button>
                    </div>
                  </Show>
                </div>
              )}</For>
            </div>
          </Show>
        </Group>
      </Show>
      {/* 个人信息/强调色/布局骨架/玻璃效果/字体 已声明式化（defs 组），自动获得搜索/custom/恢复默认。
          #515：原 children（Settings.tsx 注入的 React 子树）改 solid 直连。 */}
      <ZoneGroupFields zone={'global' as ZoneName} ctx={props.ctx} density={props.density} />
    </>
  )
}

/** React 薄桥（GlobalPresetSection.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export const renderGlobalPresetSection = createSolidMount(GlobalPresetSection)
