/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { useReplayPostureStore } from '../src/components/chat/replayPostureStore.ts'

// W4-02（姿态二拍板）：历史回放以「只读姿态」直接进 agent sheet——
// 无 send/attach/cancel side effect（ControlCenter/输入面不渲染），load 复用 ChatView
// 现成 lifecycle（listener 先于 load 挂接），首次交互（点击占位条 clear 姿态）转 live。

// 1. 姿态 store：一次性进入手势（enter/clear 纯行为，node 直测）
{
  const store = useReplayPostureStore.getState()
  assert.equal(store.sessionId, null, '初始无姿态')
  store.enter('s1')
  assert.equal(useReplayPostureStore.getState().sessionId, 's1', 'enter 记录会话')
  useReplayPostureStore.getState().clear()
  assert.equal(useReplayPostureStore.getState().sessionId, null, 'clear 清除姿态')
}

// 2. AgentSheetView：姿态中不渲染 ControlCenter（InputBar/send/attach 宿主）→ 无发送路径；
//    渲染「只读回放」占位条；点击占位条 clear 姿态转 live；离开会话自动清姿态
{
  const sheet = readFileSync(new URL('../src/sheets/AgentSheetView.tsx', import.meta.url), 'utf8')
  assert.match(sheet, /useReplayPostureStore\(s => s\.sessionId\)/, '必须读姿态 store')
  assert.match(sheet, /isReplay = ctx\.activeSession !== null && postureSession === ctx\.activeSession/, '姿态只对进入时的会话生效')
  assert.match(sheet, /isReplay \? \(/, '姿态分支必须存在')
  assert.match(sheet, /replay-continue-bar/, '姿态中必须渲染占位条')
  assert.match(sheet, /只读回放/, '占位条必须标注只读回放')
  assert.match(sheet, /onClick=\{\(\) => useReplayPostureStore\.getState\(\)\.clear\(\)\}/, '点击占位条必须清姿态转 live')
  assert.match(sheet, /<ControlCenter sessionId=\{ctx\.activeSession\} \/>/, '非姿态必须渲染 ControlCenter')
  const postureBranch = sheet.slice(sheet.indexOf('isReplay ? ('), sheet.indexOf(') : ('))
  assert.equal(postureBranch.includes('ControlCenter'), false, '姿态分支不得含 ControlCenter（无 send/attach/cancel）')
  assert.equal(postureBranch.includes('InputBar'), false, '姿态分支不得含 InputBar')
  assert.match(sheet, /postureSession !== null && postureSession !== ctx\.activeSession/, '离开该会话必须清姿态')
}

// 3. HistorySheetView：行有回放入口 → 复用 resume 事务找/建 identity 行 → enter 姿态 →
//    selectSession + openSheet agent；无 periId 不得回放
{
  const view = readFileSync(new URL('../src/sheets/history/HistorySheetView.tsx', import.meta.url), 'utf8')
  const txn = readFileSync(new URL('../src/application/transactions/resumePersistedSessionTransaction.ts', import.meta.url), 'utf8')
  assert.match(view, /回放/, '行必须有回放入口')
  assert.match(view, /resumePersistedSessionTransaction\(/, '必须复用 resume 事务（FE-AUD-010 找/建收敛）')
  assert.match(txn, /session\.source === source/, '事务内按 source/periId 找 identity 行')
  assert.match(view, /useReplayPostureStore\.getState\(\)\.enter\(result\.value\)/, '回放必须进入姿态')
  assert.match(view, /ctx\.selectSession\(result\.value\)/, '必须选会话')
  assert.match(view, /ctx\.openSheet\(\{ kind: 'agent'/, '必须开 agent sheet')
  assert.match(view, /disabled=\{!entry\.periId\}/, '无 periId 不得回放')
}

// 4. ChatView props 面未扩大（方案 B 否决：未复用 ChatView readonly props）——
//    回放 load 复用现成 lifecycle（controller/listener 先于 load 挂接）
{
  const chat = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
  assert.match(chat, /interface Props \{ sessionId: string \| null \}/, 'ChatView props 不得新增（方案 B 否决）')
  assert.match(chat, /function ChatView\(\{ sessionId \}: Props\)/, 'ChatView 签名不得扩大')
  const lifecycle = readFileSync(new URL('../src/components/chat/useSessionLifecycle.ts', import.meta.url), 'utf8')
  const attachIdx = lifecycle.indexOf('attachChatEventController(')
  const loadIdx = lifecycle.indexOf("load_persisted_session'")
  assert.ok(attachIdx !== -1 && loadIdx !== -1 && attachIdx < loadIdx, 'controller/listener 必须先于 load 挂接（回放 load 前 listener 就绪）')
}

console.log('history replay 守卫通过')
