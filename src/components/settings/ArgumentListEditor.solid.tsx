/** @jsxImportSource solid-js */
import { Index } from 'solid-js'
import {
  appendArgument,
  moveArgument,
  removeArgument,
  updateArgument,
} from '../../domains/agent/invocationDraft.ts'

export interface ArgumentListEditorProps {
  args: readonly string[]
  label: string
  onChange: (args: string[]) => void
  disabled?: boolean
}

/**
 * ArgumentListEditor — 启动参数列表编辑器（实参增删改/上下移）。
 * #515 W1：Solid 实体（原 React 面同批退役；DOM/aria 契约逐字保持）。
 * 行键 = 原版 React `key={index}` ⇒ 用 `<Index>`（按位复用行，输入不丢焦点；
 * `<For>` 按引用判等，逐键重挂会让输入框失焦）。
 */
export default function ArgumentListEditor(props: ArgumentListEditorProps) {
  const disabled = () => props.disabled ?? false
  return (
    <div class="agent-argument-list" role="group" aria-label={`${props.label} 启动参数`}>
      <Index each={props.args}>{(argument, index) => (
        <div class="set-preset-row">
          <input
            class="set-input"
            value={argument()}
            onInput={event => props.onChange(updateArgument(props.args, index, event.currentTarget.value))}
            placeholder="单个启动参数（可为空字符串）"
            aria-label={`${props.label} 参数 ${index + 1}`}
            disabled={disabled()}
          />
          <button class="ps-btn sm" type="button" disabled={disabled() || index === 0} onClick={() => props.onChange(moveArgument(props.args, index, index - 1))} aria-label={`${props.label} 参数 ${index + 1} 上移`}>↑</button>
          <button class="ps-btn sm" type="button" disabled={disabled() || index === props.args.length - 1} onClick={() => props.onChange(moveArgument(props.args, index, index + 1))} aria-label={`${props.label} 参数 ${index + 1} 下移`}>↓</button>
          <button class="ps-btn sm" type="button" disabled={disabled()} onClick={() => props.onChange(removeArgument(props.args, index))} aria-label={`删除 ${props.label} 参数 ${index + 1}`}>删除</button>
        </div>
      )}</Index>
      <button class="ps-btn sm" type="button" disabled={disabled()} onClick={() => props.onChange(appendArgument(props.args))}>添加参数</button>
    </div>
  )
}
