/** @jsxImportSource solid-js */
import { onCleanup, onMount } from 'solid-js'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/**
 * Sidebar.blocks.solid.test 的贡献体探针。
 *
 * #515 岛退役：注册表贡献组件是 **Solid 组件**（宿主直连渲染）——探针同为 Solid
 * 组件，本文件随组件翻转改为 .solid.tsx 编译面（原 React 探针与 React 岛同批退役）。
 */

/** 具名内容探针：渲染 `<div data-testid="body-{name}">{name} 内容</div>`。
 * 返回类型不显式标注——显式 JSX.Element 标注在双程序各自检查下易漂移（register
 * 处已有整体收窄 as）。 */
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

/** 动作注册探针（已随批退役的 useBlockActionHandler 的等价内联）——挂载注册、卸载注销。 */
export function ActionProbe(props: Pick<AgentSidebarContributionProps, 'registerBlockActionHandler'>) {
  onMount(() => {
    props.registerBlockActionHandler(actionId => { receivedAction = actionId })
    onCleanup(() => props.registerBlockActionHandler(null))
  })
  return <div data-testid="body-probe">probe 内容</div>
}
