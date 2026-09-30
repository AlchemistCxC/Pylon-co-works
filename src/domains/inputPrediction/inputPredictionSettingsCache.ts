/**
 * inputPredictionSettingsCache — 输入预测设置的进程内同步缓存（#448 PR2）。
 *
 * 消费面（InputBar ghost 判定 / 调度 effect / standalone provider / router
 * fallback）需要**同步**读当前设置——此前每帧直读 localStorage（JSON.parse）。
 * #321 决议（收敛到后端权威）后，Tauri 模式真值在 SQLite，同步读改为读本缓存：
 * - hydrate 前（bootstrap 早期）回落 localStorage 直读，与旧行为逐字等价；
 * - hydrate 后为后端权威值的内存镜像（写入方：repository 的 hydrate/保存路径）。
 *
 * browser 预览模式：localStorage 即权威，缓存只是免重复 parse 的镜像，语义不变。
 */
import { loadInputPredictionSettings, type InputPredictionSettings } from './inputPredictionSettings.ts'

let cached: InputPredictionSettings | null = null

/** 同步读当前设置：缓存命中 → 返回；未 hydrate → localStorage 直读兜底（等价旧行为）。 */
export function cachedInputPredictionSettings(): InputPredictionSettings {
  return cached ?? loadInputPredictionSettings()
}

/** 缓存写入（repository 的 hydrate/保存路径调用）；null 重置为未 hydrate 态（测试用）。 */
export function updateCachedInputPredictionSettings(settings: InputPredictionSettings | null): void {
  cached = settings && typeof settings === 'object' ? settings : null
}
