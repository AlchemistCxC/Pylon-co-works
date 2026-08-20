import { describe, expect, it } from 'vitest'
import {
  appendArgument,
  formatInvocationForDisplay,
  moveArgument,
  removeArgument,
  updateArgument,
  validateInvocation,
} from '../invocationDraft.ts'

describe('structured agent invocation editing', () => {
  it('preserves spaced, empty, and quoted arguments without mutating the input', () => {
    const original = ['--profile', 'work space', '', 'a"b']

    expect(updateArgument(original, 1, 'new work space')).toEqual(['--profile', 'new work space', '', 'a"b'])
    expect(appendArgument(original, 'tail value')).toEqual([...original, 'tail value'])
    expect(removeArgument(original, 2)).toEqual(['--profile', 'work space', 'a"b'])
    expect(moveArgument(original, 3, 1)).toEqual(['--profile', 'a"b', 'work space', ''])
    expect(original).toEqual(['--profile', 'work space', '', 'a"b'])
  })

  it('formats an exact Windows preview without turning it into a parseable source of truth', () => {
    expect(formatInvocationForDisplay(
      'C:\\Program Files\\Agent\\agent.exe',
      ['--profile', 'work space', '', 'a"b', 'trailing\\'],
    )).toBe('"C:\\Program Files\\Agent\\agent.exe" --profile "work space" "" "a\\"b" trailing\\')
  })

  it('blocks invalid process values but keeps intentional empty arguments legal', () => {
    const validation = validateInvocation({
      executable: '',
      args: ['', `bad\0argument`, 'x'.repeat(4097)],
    })

    expect(validation.ok).toBe(false)
    expect(validation.issues.map(issue => issue.code)).toEqual([
      'executable_empty',
      'argument_empty',
      'argument_nul',
      'argument_too_long',
    ])
    expect(validation.issues.find(issue => issue.code === 'argument_empty')?.severity).toBe('warning')
  })
})
