import { useSyncExternalStore } from 'react'
import { getChatController } from './chatEventController'
import type { PlanEntry } from '../../domains/tasks/planTypes.ts'

/**
 * useChatRuntimeSnapshot — 横向订阅 hook（P1-05，D23）。
 *
 * 经 ChatControllerHandle 的版本戳订阅指定 source：消息 append 不进入 ChatView 的
 * setState 链，横向组件独立重渲染；渲染时读 getTasks/getThinkingStart（引用稳定，
 * 任务未变化时消费方可 memo）。
 */

export interface ChatHorizontalSnapshot {
  version: number
  tasks: PlanEntry[]
  thinkingStart: number | undefined
}

export function useChatRuntimeSnapshot(source: string | null): ChatHorizontalSnapshot {
  const version = useSyncExternalStore(
    callback => {
      const handle = getChatController()
      if (!source || !handle) return () => {}
      return handle.subscribe(source, callback)
    },
    () => {
      const handle = getChatController()
      return source && handle ? handle.getSnapshot(source) : 0
    },
  )
  const handle = getChatController()
  return {
    version,
    tasks: source && handle ? handle.getTasks(source) : [],
    thinkingStart: source && handle ? handle.getThinkingStart(source) : undefined,
  }
}
