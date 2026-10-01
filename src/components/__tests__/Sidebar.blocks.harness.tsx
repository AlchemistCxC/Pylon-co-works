import { useEffect } from 'react'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/**
 * Sidebar.blocks.solid.test 的贡献体探针（React 面）。
 *
 * 测试文件本体是 .solid.test.tsx（solid 编译面）——其 JSX 编译为 Solid 组件，不能当
 * first-party-react 贡献体喂给 React 岛；真正的 React 组件必须住在本文件（React 编译面），
 * 与生产里「注册表贡献组件是 React 面」的边界一致。
 */

/** 具名内容探针：渲染 `<div data-testid="body-{name}">{name} 内容</div>`。
 * 返回类型不显式标注——本文件在双 tsconfig 下会被两个程序各自检查，显式 ReactElement
 * 标注在 solid 程序里与其 JSX 命名空间冲突（register 处已有整体收窄 as）。 */
export function makeBody(name: string) {
  const Body = () => <div data-testid={`body-${name}`}>{name} 内容</div>
  return Body
}

let receivedAction: string | null = null

/** 读取最近一次回派的动作 id（beforeEach 重置）。 */
export function takeReceivedAction(): string | null {
  return receivedAction
}

export function resetReceivedAction(): void {
  receivedAction = null
}

/** 动作注册探针：useBlockActionHandler（已随批退役）的等价内联——挂载注册、卸载注销。 */
export function ActionProbe({ registerBlockActionHandler }: Pick<AgentSidebarContributionProps, 'registerBlockActionHandler'>) {
  useEffect(() => {
    registerBlockActionHandler(actionId => { receivedAction = actionId })
    return () => registerBlockActionHandler(null)
  }, [registerBlockActionHandler])
  return <div data-testid="body-probe">probe 内容</div>
}
