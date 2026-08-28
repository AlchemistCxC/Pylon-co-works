import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1')
  return readFileSync(pathname, 'utf8')
}

describe('B-02 command suggestion keyboard semantics', () => {
  it('uses native button suggestions while preserving cmd-item styling hooks', () => {
    const inputBar = source('../InputBar.tsx')
    expect(inputBar).toContain('<button type="button" key={c.cmd} className={`cmd-item')
    expect(inputBar).toContain('aria-label={`${c.cmd}${c.args}: ${c.info}`}')
    expect(inputBar).not.toMatch(/<div[^>]+className=\{`cmd-item/)
  })
})
