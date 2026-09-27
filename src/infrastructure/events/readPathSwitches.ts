/**
 * 读路径杀停开关（#376 / #375 的载荷治理项共用）。
 *
 * 形态沿用 #221 `data-highlight-lifecycle="off"` / #243 `data-row-virtualization="off"`
 * 的先例：页面上出现指定属性即关闭该优化，**不需要回滚版本**——运维在 devtools 里
 * `document.body.setAttribute(..., 'off')` 后触发一次重载即生效。
 *
 * 这里是「全局出现即关」而不是先例的「最近祖先即关」：两处开关判决都发生在挂载任何
 * 工作台 DOM 之前（冷装载读出口、投影核初始化），此时没有可用的祖先链。
 */

function killSwitchActive(attribute: string): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(`[${attribute}="off"]`) !== null
}

/**
 * #376-a：读出口 `typed_payload` 收口开关。`data-typed-payload-cap="off"` 时原样下发
 * typed（回到改动前行为）。
 */
export function typedPayloadCapDisabled(): boolean {
  return killSwitchActive('data-typed-payload-cap')
}

/**
 * #375-a：`timeline.data` 载荷收窄开关。`data-timeline-payload="full"` 时 timeline 条目
 * 继续持有整份语义事件（回到改动前行为）——`timeline.data` 是 renderer 与第三方插件的
 * 可见面，这条逃生口用于插件读到缺字段时的现场抢救。
 */
export function timelinePayloadNarrowingDisabled(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector('[data-timeline-payload="full"]') !== null
}
