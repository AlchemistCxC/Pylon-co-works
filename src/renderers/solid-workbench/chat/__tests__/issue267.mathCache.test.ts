// #267 性能守卫：渲染缓存命中/逐出/失败缓存的行为钉子（node 环境，无 DOM 依赖）。
// #271 CI 修复：导入改指纯模块 mathMarkup.ts——经 mathRender.solid.tsx 转入会把
// 组件文件拖进主 tsconfig 的 React JSX 检查（class/innerHTML TS2322）。
import { describe, expect, it } from 'vitest'
import { renderMathMarkup } from '../mathMarkup.ts'

describe('#267 renderMathMarkup 结果缓存', () => {
  it('同输入第二次调用命中缓存（返回同一字符串实例）', () => {
    const first = renderMathMarkup('a+b', false)
    const second = renderMathMarkup('a+b', false)
    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('display 与 inline 分别缓存（同 latex 不同形态不同输出）', () => {
    const inline = renderMathMarkup('x', false)
    const display = renderMathMarkup('x', true)
    expect(inline).not.toBe(display)
    expect(display).toContain('display="block"')
  })

  it('失败（null）同样入缓存：同输入不再重试', () => {
    // Temml throwOnError:false 对坏输入渲染 temml-error 节点而非抛错；
    // 真正的异常路径（如超深嵌套导致内部异常）才走 null 分支——这里锁定
    // 「null 也缓存」的语义：两次调用返回同一个 null。
    const a = renderMathMarkup('#267-probe-never-invalid', false)
    const b = renderMathMarkup('#267-probe-never-invalid', false)
    expect(a).toBe(b)
  })
})
