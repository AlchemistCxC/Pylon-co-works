import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)) })

async function namingFindings(code: string) {
  const [result] = await eslint.lintText(code, { filePath: 'src/naming-policy-probe.ts' })
  return result.messages.filter(message => message.ruleId === '@typescript-eslint/naming-convention')
}

describe('binding naming contract', () => {
  it('rejects internal snake_case variables and ordinary parameters', async () => {
    const findings = await namingFindings('export const invalid_binding = 1; export function read(invalid_param: number) { return invalid_param; }')
    expect(findings).toHaveLength(2)
    expect(findings.every(finding => finding.severity === 2)).toBe(true)
  })

  it('preserves wire properties and destructured keys in variables and parameters', async () => {
    expect(await namingFindings(`
      const response = { session_id: 'remote' };
      export const { session_id } = response;
      export function readWire({ agent_id }: { agent_id: string }) { return agent_id; }
    `)).toEqual([])
  })

  it('still checks explicitly renamed wire bindings', async () => {
    const findings = await namingFindings(`
      export function readWire({ session_id: wrong_alias }: { session_id: string }) { return wrong_alias; }
    `)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('wrong_alias')
  })
})
