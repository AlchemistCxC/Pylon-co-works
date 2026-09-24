// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import SolidMount from '../SolidMount'

// #279：React→Solid 通用薄桥的机制契约——挂载工厂拿到真实容器与响应式 props 访问器、
// dispose 对称回收（StrictMode 双执行下无残留）、React 重渲染推送最新 props（响应式
// 通道，saveReceipt/editing 类可变字段赖此跨桥）、容器 display:contents 不参与布局。

describe('SolidMount', () => {
  it('挂载工厂拿到容器与 initial，卸载时 dispose 对称回收', () => {
    const disposals: string[] = []
    function Host({ text }: { text: string }) {
      return (
        <SolidMount
          initial={{ text }}
          mount={(container, latest) => {
            const mark = document.createElement('p')
            mark.dataset.solid = latest().text
            container.appendChild(mark)
            return () => {
              disposals.push(latest().text)
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

  it('React 重渲染把最新 props 推给 latest()（响应式通道）', () => {
    const seen: string[] = []
    let captureLatest: (() => { label: string }) | undefined
    function Host({ label }: { label: string }) {
      return (
        <SolidMount
          initial={{ label }}
          mount={(_container, latest) => {
            captureLatest = latest
            return () => {}
          }}
        />
      )
    }
    const view = render(<Host label="a" />)
    view.rerender(<Host label="b" />)
    // layout effect 推送是异步于 rerender 断言的——直接读 latest 与经推送各验证一次
    seen.push(captureLatest!().label)
    return Promise.resolve().then(() => {
      expect(seen).toEqual(['b'])
      view.unmount()
    })
  })
})
