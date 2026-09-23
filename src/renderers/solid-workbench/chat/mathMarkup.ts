import temml from 'temml'

/**
 * #267：数学公式 markup 渲染——Temml（LaTeX→MathML）纯函数 + 有界 FIFO 缓存。
 *
 * 失败路径：Temml `throwOnError:false` 时把错误渲染为 `temml-error` 节点而非抛出；
 * 异常兜底返回 null，回落 latex 原文。任何路径都不抛错、不阻塞渲染流。
 *
 * 性能守卫（#267 验收追问）：Temml 单次渲染实测短式 ~0.01ms、Basel 显示式
 * ~0.03ms、2K 字符病态式 ~0.6ms，但流式尾块逐 tick 重解析与 #243 行虚拟化
 * 滚回视口重挂载都会对**同一 latex 重复渲染**。渲染是纯函数，按
 * `display\0latex` 键做有界 FIFO 缓存（形态沿用 renderModelCache 的首键淘汰）
 * ——重复渲染退化为一次 Map 查找，失败（null）结果同样入缓存不重试。
 *
 * 独立成 .ts 纯模块（#271 CI 修复）：node 测试（mathCache 钉子）导入本模块
 * 不再把 mathRender.solid.tsx 组件文件拖进主 tsconfig 的 React JSX 检查
 * （class/innerHTML 在 React 语义下 TS2322）。
 */
const MATH_MARKUP_CACHE_LIMIT = 1024
const mathMarkupCache = new Map<string, string | null>()

export function renderMathMarkup(latex: string, display: boolean): string | null {
  const key = `${display ? 'd' : 'i'}\u0000${latex}`
  const cached = mathMarkupCache.get(key)
  if (cached !== undefined) return cached
  // 无初始化器：try/catch 两臂都有赋值，TS 定值分析通过；带 `= null` 属死赋值
  //（no-useless-assignment 门禁红）。
  let markup: string | null
  try {
    markup = temml.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      annotate: false,
    })
  } catch {
    markup = null
  }
  if (mathMarkupCache.size >= MATH_MARKUP_CACHE_LIMIT) {
    const oldest = mathMarkupCache.keys().next().value
    if (oldest !== undefined) mathMarkupCache.delete(oldest)
  }
  mathMarkupCache.set(key, markup)
  return markup
}
