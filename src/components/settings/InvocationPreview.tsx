import { describeInvocation } from '../../domains/agent/invocationDraft.ts'

/** 草稿启动命令预览（实际启动串 + 校验 issue 行；编辑/候选/新建三处共用）。 */
export default function InvocationPreview({ executable, args, effectiveArgs = args }: {
  executable: string
  args: string[]
  effectiveArgs?: string[]
}) {
  const invocation = describeInvocation({ executable, args }, effectiveArgs)
  return (
    <div className="agent-invocation-preview">
      <div className="set-hint">实际启动：<code>{invocation.display}</code></div>
      {invocation.validation.issues.map(issue => (
        <div className="set-hint" role={issue.severity === 'error' ? 'alert' : 'note'} key={`${issue.code}:${issue.argumentIndex ?? 'exe'}`}>
          {issue.severity === 'error' ? '错误' : '提示'}：{issue.message}
        </div>
      ))}
    </div>
  )
}
