import SolidMount from '../../host/SolidMount'

/**
 * InputPredictionSettingsPanel — 输入预测服务设置面板。
 *
 * #515：实体已迁 `InputPredictionSettingsPanel.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface InputPredictionSettingsPanelProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface InputPredictionSettingsPanelSolidModule {
  renderInputPredictionSettingsPanel(container: HTMLElement, latest: () => InputPredictionSettingsPanelProps): () => void
}

const modules = import.meta.glob<InputPredictionSettingsPanelSolidModule>('./InputPredictionSettingsPanel.solid.tsx', { eager: true })
const solidModule = modules['./InputPredictionSettingsPanel.solid.tsx']
if (!solidModule) throw new Error('InputPredictionSettingsPanel Solid 实体未进入 Vite module graph')

export default function InputPredictionSettingsPanel(_props: InputPredictionSettingsPanelProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderInputPredictionSettingsPanel(container, latest)} />
}
