import SolidMount from '../../host/SolidMount'
import type { ThemeSettings } from '../../domains/theme/themeStore'
import type { ZoneName } from '../../domains/theme/themeFieldDefs'
import Select from '../ui/Select.tsx'
import type { PluginSettingOptionsContribution } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'
import type { RegistryEntry } from '../../plugin-runtime/registry/types.ts'

/**
 * themeFieldRenderer — 声明式字段渲染器（自定义系统骨架）。
 *
 * #515：实体已迁 `themeFieldRenderer.solid.tsx`（ZoneGroupFields 及全部字段控件），
 * 本文件是 React 世界薄桥（批7 拆除）。Row/Slider/Num/Sel/Txt 是无依赖的 DOM
 * 原语且导出面被 React 消费者引用，按迁移模板「纯原语不迁」保留原实现在这里；
 * Solid 域内（WindowPanel.solid 等）直连 .solid 实体导出的同名原语。
 */

export interface RenderCtx {
  t: ThemeSettings & { ccEditMode: boolean }
  onChange: (partial: Partial<ThemeSettings>) => void
  /** 设置搜索：按字段 label 过滤；非空时强制展开全部匹配组 */
  search?: string
  settingOptionEntries?: readonly RegistryEntry<PluginSettingOptionsContribution>[]
}

export interface ZoneGroupFieldsProps {
  zone: ZoneName
  ctx: RenderCtx
  density?: 'basic' | 'standard' | 'all'
}

export function Row({ label, children, className = '', anchor, dataProv }: { label: string; children: React.ReactNode; className?: string; anchor?: string; dataProv?: string }) {
  return <div className={`set-row${className ? ` ${className}` : ''}`} data-search-anchor={anchor} data-prov={dataProv}><span className="set-row-label">{label}</span>{children}</div>
}

export function Slider({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return <input type="range" min={min} max={max} step={step || 0.05} value={value}
    onChange={e => onChange(+e.target.value)} className="set-range" />
}

export function Num({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return <input type="number" min={min} max={max} value={value} step={0.1}
    onChange={e => onChange(+e.target.value)} className="set-num" />
}

export function Sel({ value, onChange, options, ariaLabel }: { value: string; onChange: (v: string) => void; options: readonly (string | { value: string; label: string; description?: string; disabled?: boolean })[]; ariaLabel: string }) {
  return <Select ariaLabel={ariaLabel} value={value} onChange={onChange} className="set-select" options={options.map(option => typeof option === 'string' ? { value: option, label: option } : option)} />
}

export function Txt({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input" />
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface ThemeFieldRendererSolidModule {
  renderZoneGroupFields(container: HTMLElement, latest: () => ZoneGroupFieldsProps): () => void
}

const modules = import.meta.glob<ThemeFieldRendererSolidModule>('./themeFieldRenderer.solid.tsx', { eager: true })
const solidModule = modules['./themeFieldRenderer.solid.tsx']
if (!solidModule) throw new Error('themeFieldRenderer Solid 实体未进入 Vite module graph')

export function ZoneGroupFields(props: ZoneGroupFieldsProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderZoneGroupFields(container, latest)} />
}
