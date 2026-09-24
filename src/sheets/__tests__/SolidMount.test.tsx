// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import SolidMount from '../SolidMount'

// #279：React→Solid 通用薄桥的机制契约——挂载工厂拿到真实容器、dispose 对称回收
// （StrictMode 双执行下无残留）、容器 display:contents 不参与布局。

describe('SolidMount', () => {
  it('挂载工厂拿到容器并执行，卸载时 dispose 对称回收', () => {
    const disposals: string[] = []
    function Host({ text }: { text: string }) {
      return (
        <SolidMount
          mount={container => {
            const mark = document.createElement('p')
            mark.dataset.solid = text
            container.appendChild(mark)
            return () => {
              disposals.push(text)
              mark.remove()
            }
          }}
        />
      )
    }
    const view = render(<Host text="alpha" />)
    const mark = document.querySelector('[data-solid="alpha"]')
    expect(mark).toBeTruthy()
    // 容器不参与布局（display:contents），Solid 子树是 React 父布局的直接布局子项
    expect(mark!.parentElement!.style.display).toBe('contents')
    view.unmount()
    expect(disposals).toEqual(['alpha'])
    expect(document.querySelector('[data-solid="alpha"]')).toBeNull()
  })

  it('props 按挂载捕获：后续 React 重渲染不重挂 Solid 子树', () => {
    let mounts = 0
    function Host(_: { label: string }) {
      return <SolidMount mount={() => { mounts += 1; return () => {} }} />
    }
    const view = render(<Host label="a" />)
    view.rerender(<Host label="b" />)
    expect(mounts).toBe(1)
  })
})
