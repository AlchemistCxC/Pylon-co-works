import { useEffect, useRef } from 'react'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/**
 * 把区块头动作的处理逻辑交给宿主。
 *
 * 宿主渲染区块头（标题 + 折叠钮 + `headerActions`），但动作语义属于贡献——
 * 「新建工作区」要弹目录选择器、「定时」要开编辑弹窗，这些只有贡献自己知道。
 * 于是约定：贡献在挂载期注册处理器，卸载时注销；宿主点击头部按钮时调用它。
 *
 * 用 ref 持有最新处理器，避免处理器因闭包变化而要求重新注册（那会在每次渲染
 * 卸载/重装注册，出现「点了没反应」的窗口）。
 */
export function useBlockActionHandler(
  props: Pick<AgentSidebarContributionProps, 'registerBlockActionHandler'>,
  handler: (actionId: string) => void,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const register = props.registerBlockActionHandler
  useEffect(() => {
    register((actionId: string) => handlerRef.current(actionId))
    return () => register(null)
  }, [register])
}
