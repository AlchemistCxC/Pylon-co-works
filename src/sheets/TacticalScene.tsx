import SolidMount from '../host/SolidMount'

/**
 * TacticalScene — tactical-blue 的装饰场景平面。
 *
 * 本文件是 interfaceModeScenes（React 世界）与 Solid 实体之间的**薄桥 + 加载缝**：
 * 实体在 `TacticalScene.solid.tsx`（React 类型图不触碰 .solid 文件，P52 D4 同构，
 * 模块接口在此声明）。
 * A decorative plane only. It cannot intercept clicks or move operational controls.
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface TacticalSceneSolidModule {
  mountTacticalScene(container: HTMLElement): () => void
}

const modules = import.meta.glob<TacticalSceneSolidModule>('./TacticalScene.solid.tsx', { eager: true })
const solidModule = modules['./TacticalScene.solid.tsx']
if (!solidModule) throw new Error('TacticalScene Solid 实体未进入 Vite module graph')

// #515：实体在 TacticalScene.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
export default function TacticalScene() {
  return <SolidMount initial={{}} mount={container => solidModule.mountTacticalScene(container)} />
}
