import SolidMount from '../../host/SolidMount'

/**
 * HistoryRetention — 消息历史保留策略设置（I13-A-FE-02，D-03/D-15）。
 *
 * #515：实体已迁 `HistoryRetention.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface HistoryRetentionProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface HistoryRetentionSolidModule {
  renderHistoryRetention(container: HTMLElement, latest: () => HistoryRetentionProps): () => void
}

const modules = import.meta.glob<HistoryRetentionSolidModule>('./HistoryRetention.solid.tsx', { eager: true })
const solidModule = modules['./HistoryRetention.solid.tsx']
if (!solidModule) throw new Error('HistoryRetention Solid 实体未进入 Vite module graph')

export default function HistoryRetention(_props: HistoryRetentionProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderHistoryRetention(container, latest)} />
}
