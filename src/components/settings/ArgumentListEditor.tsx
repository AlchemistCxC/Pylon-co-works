import {
  appendArgument,
  moveArgument,
  removeArgument,
  updateArgument,
} from '../../domains/agent/invocationDraft.ts'

interface ArgumentListEditorProps {
  args: readonly string[]
  label: string
  onChange: (args: string[]) => void
  disabled?: boolean
}

export default function ArgumentListEditor({ args, label, onChange, disabled = false }: ArgumentListEditorProps) {
  return (
    <div className="agent-argument-list" role="group" aria-label={`${label} 启动参数`}>
      {args.map((argument, index) => (
        <div className="set-preset-row" key={index}>
          <input
            className="set-input"
            value={argument}
            onChange={event => onChange(updateArgument(args, index, event.target.value))}
            placeholder="单个启动参数（可为空字符串）"
            aria-label={`${label} 参数 ${index + 1}`}
            disabled={disabled}
          />
          <button className="ps-btn sm" type="button" disabled={disabled || index === 0} onClick={() => onChange(moveArgument(args, index, index - 1))} aria-label={`${label} 参数 ${index + 1} 上移`}>↑</button>
          <button className="ps-btn sm" type="button" disabled={disabled || index === args.length - 1} onClick={() => onChange(moveArgument(args, index, index + 1))} aria-label={`${label} 参数 ${index + 1} 下移`}>↓</button>
          <button className="ps-btn sm" type="button" disabled={disabled} onClick={() => onChange(removeArgument(args, index))} aria-label={`删除 ${label} 参数 ${index + 1}`}>删除</button>
        </div>
      ))}
      <button className="ps-btn sm" type="button" disabled={disabled} onClick={() => onChange(appendArgument(args))}>添加参数</button>
    </div>
  )
}
