import { describe, expect, it } from 'vitest'
import {
  analyzeRust,
  analyzeTsLike,
  attrExcludesFromProduction,
  classifyPath,
  CRATES_FALLBACK,
  displayWidth,
  formatNumber,
  isTestPathRust,
  isTestPathTs,
  parseWorkspaceCrates,
  rustParentCandidates,
} from './code-stats.mts'

/** 去掉模板字符串首行的换行与末尾换行产生的空元素，得到与词法器一致的物理行。 */
const linesOf = (src: string) => {
  const lines = src.replace(/^\n/, '').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

describe('cfg() 生产侧求值（issue #231）', () => {
  it('cfg(test) 及其任意组合均视为 test-only', () => {
    expect(attrExcludesFromProduction('cfg(test)')).toBe(true)
    expect(attrExcludesFromProduction('cfg(any(test, feature = "test-agent"))')).toBe(true)
    expect(attrExcludesFromProduction('cfg(all(test, feature = "test-agent"))')).toBe(true)
    expect(attrExcludesFromProduction('cfg(any(feature = "test-agent", test))')).toBe(true)
  })
  it('not(test)、cfg_attr 与非测试 feature 都不是测试门禁；test-agent feature 是', () => {
    expect(attrExcludesFromProduction('cfg(not(test))')).toBe(false)
    expect(attrExcludesFromProduction('cfg(feature = "test-agent")')).toBe(true)
    expect(attrExcludesFromProduction('cfg(feature = "portable")')).toBe(false)
    expect(attrExcludesFromProduction('cfg_attr(test, derive(Debug))')).toBe(false)
    expect(attrExcludesFromProduction('cfg(windows)')).toBe(false)
    expect(attrExcludesFromProduction('cfg(target_os = "windows")')).toBe(false)
  })
})

describe('Rust 内联测试行级拆分', () => {
  const sample = linesOf(`
fn production() {
    let s = "https://example.com // 不是注释";
}

// 普通注释
#[cfg(test)]
mod tests {
    const JSON: &str = r#"{"brace": } // 仍在字符串里"#;

    /* 嵌套 /* 块注释 */ 仍在注释 */
    #[test]
    fn t() {
        let c = 'x';
        let lt: &'static str = "y";
        assert_eq!(c, 'x');
    }
}

fn production_after() { }
`)

  it('测试区域边界精确到行，raw string 与嵌套注释不干扰', () => {
    const a = analyzeRust(sample.join('\n'))
    // 行号（0 基）：0-3 生产 fn、4 空、5 注释、6 属性、7 mod {、8 raw string、9 空、
    // 10 嵌套注释、11 #[test]、12 fn {、13-15 体、16 }、17 }、18 生产 fn
    expect(a.testRegions).toBe(1)
    expect(a.testAttrCount).toBe(1)
    expect(a.testModDecls.has('tests')).toBe(true)
    const testLines = a.isTestLine.map((t, i) => t ? i : -1).filter(i => i >= 0)
    // 门控属性行（5）本身也计入测试区域；区域收在 mod 的 `}`（16），其后空行不算
    expect(testLines).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    // 生产行未被吞
    expect(a.isTestLine[1]).toBe(false)
    expect(a.isTestLine[18]).toBe(false)
  })

  it('行分类三类完备：code+comment+blank === 物理行数', () => {
    const a = analyzeRust(sample.join('\n'))
    const total = a.lineClass.length
    const sum = a.lineClass.filter(c => c === 'code').length
      + a.lineClass.filter(c => c === 'comment').length
      + a.lineClass.filter(c => c === 'blank').length
    expect(sum).toBe(total)
    expect(total).toBe(sample.length)
    expect(a.lineClass[4]).toBe('comment')
    expect(a.lineClass[2]).toBe('code')
    expect(a.lineClass[5]).toBe('code') // 门控属性行
  })

  it('跨行常规字符串不丢行、花括号不乱区域', () => {
    const src = linesOf(`
fn a() {
    let s = "multi
line { with brace
still string";
}
#[cfg(test)]
mod tests {
    #[test]
    fn t() { }
}
`)
    const a = analyzeRust(src.join('\n'))
    expect(a.lineClass.length).toBe(src.length)
    expect(a.testRegions).toBe(1)
    const testLines = a.isTestLine.map((t, i) => t ? i : -1).filter(i => i >= 0)
    expect(testLines).toEqual([5, 6, 7, 8, 9])
  })

  it('外置声明 #[cfg(test)] mod x; 记入 testModDecls 供子文件判定', () => {
    const parent = linesOf(`
pub mod real;
#[cfg(test)]
mod tests;

#[cfg(any(test, feature = "test-agent"))]
#[doc(hidden)]
pub mod test_utils;
`).join('\n')
    const a = analyzeRust(parent)
    expect(a.testModDecls.has('tests')).toBe(true)
    expect(a.testModDecls.has('test_utils')).toBe(true)
    expect(a.testModDecls.has('real')).toBe(false)
    expect(isTestPathRust('src/session/tests.rs', a.testModDecls)).toBe(true)
    expect(isTestPathRust('src/session/real.rs', a.testModDecls)).toBe(false)
  })

  it('生命周期不是 char，字符字面量不串位', () => {
    const src = "fn f(x: &'static str) { let c = '\\''; }"
    const a = analyzeRust(src)
    expect(a.lineClass).toEqual(['code'])
  })

  it('多行字符串：空行与 \\<换行> 续行都各占一个物理行（#259 回归）', () => {
    const BS = String.fromCharCode(92)
    const LF = String.fromCharCode(10)
    // println! 续行后跟字符串内空行、再跟内容行——6 个物理行一个不许丢
    const src = [
      'fn help() {',
      '    println!("' + BS,
      '',
      '用法：',
      'step");',
      '}',
    ].join(LF)
    const a = analyzeRust(src)
    expect(a.lineClass.length).toBe(6)
    expect(a.lineClass).toEqual(['code', 'code', 'blank', 'code', 'code', 'code'])
    // 块注释内部：有内容的行是 comment，空行仍是 blank
    const cmt = ['/* 第一行', '', '第三行 */', 'fn after() { }'].join(LF)
    const b = analyzeRust(cmt)
    expect(b.lineClass.length).toBe(4)
    expect(b.lineClass[1]).toBe('blank')
    expect(b.lineClass[2]).toBe('comment')
    expect(b.lineClass[3]).toBe('code')
  })
})

describe('TS/JS 行分类', () => {
  it('模板字符串内的 // 与 ${} 嵌套不干扰分类', () => {
    const src = linesOf(`
const a = 1 // 行尾注释
/* 独立块注释 */
const tpl = \`\${x} // 不是注释 \${ {n: 1}.n }\`
const url = "http://example.com"
const re = /a\\/\\/b/ // 真注释
`)
    const cls = analyzeTsLike(src.join('\n'))
    expect(cls.length).toBe(src.length)
    expect(cls[0]).toBe('code') // 行尾注释仍是代码行
    expect(cls[1]).toBe('comment')
    expect(cls[2]).toBe('code')
    expect(cls[3]).toBe('code') // 字符串里的 // 不是注释
    expect(cls[4]).toBe('code') // 正则里的 // 不是注释（行尾注释不改变整行性质）
  })

  it('跨行模板字符串逐行都是 code', () => {
    const src = linesOf(`
const tpl = \`
line1 // not comment
line2
\`;
`)
    const cls = analyzeTsLike(src.join('\n'))
    expect(cls.length).toBe(src.length)
    expect(cls).toEqual(['code', 'code', 'code', 'code'])
  })
})

describe('测试文件判据', () => {
  it('TS 文件级判据', () => {
    expect(isTestPathTs('src/a/x.test.ts')).toBe(true)
    expect(isTestPathTs('src/a/__tests__/x.ts')).toBe(true)
    expect(isTestPathTs('src/a/__fixtures__/f.ts')).toBe(true)
    expect(isTestPathTs('src/test/resetStores.ts')).toBe(true)
    expect(isTestPathTs('src/test-utils/tauriCoreMock.ts')).toBe(true)
    expect(isTestPathTs('src/a/x.spec.tsx')).toBe(true)
    expect(isTestPathTs('src/components/sidebar/blocks/mockBlocks.tsx')).toBe(false)
    expect(isTestPathTs('src/a/component.ts')).toBe(false)
  })

  it('Rust 文件级判据（tests 目录与假 agent）', () => {
    expect(isTestPathRust('src-tauri/tests/issue53_selector_probe/mod.rs')).toBe(true)
    expect(isTestPathRust('src-tauri/src/bin/pylon-fake-agent.rs')).toBe(true)
    expect(isTestPathRust('src-tauri/src/session/prompt.rs')).toBe(false)
  })
})

describe('路径分类', () => {
  it('生产/测试/排除面按口径落位', () => {
    expect(classifyPath('src/App.tsx')).toMatchObject({ bucket: 'production', area: 'frontend' })
    expect(classifyPath('src-tauri/src/session/prompt.rs')).toMatchObject({ bucket: 'production', area: 'rust-app' })
    expect(classifyPath('src-tauri/pylon-compute/src/lib.rs')).toMatchObject({ bucket: 'production', area: 'crate:pylon-compute' })
    expect(classifyPath('src-tauri/tests/integration.rs')?.bucket).toBe('test')
    expect(classifyPath('src/sdk/index.ts')).toMatchObject({ bucket: 'sdk', area: 'sdk' })
    expect(classifyPath('src-tauri/resources/sdk/pylon-plugin-sdk.js')).toMatchObject({ bucket: 'sdk' })
    expect(classifyPath('examples/plugins/demo/lib.js')).toMatchObject({ bucket: 'examples' })
    expect(classifyPath('src-tauri/vendor/acp/lib.rs')).toMatchObject({ bucket: 'vendored' })
    expect(classifyPath('scripts/audit-maintenance.mts')).toMatchObject({ bucket: 'tooling', area: 'tooling-scripts' })
    expect(classifyPath('tools/webview2-mcp/src/main.rs')).toMatchObject({ bucket: 'tooling', area: 'tooling-tools' })
    expect(classifyPath('src-tauri/pylon-markdown/gen/syntax.rs')).toMatchObject({ bucket: 'tooling', area: 'tooling-markdown' })
    expect(classifyPath('vite.config.ts')).toMatchObject({ bucket: 'tooling', area: 'tooling-root-config' })
    expect(classifyPath('index.html')).toMatchObject({ bucket: 'production', area: 'frontend' })
    expect(classifyPath('perf-phase.tmp.ts')?.bucket).toBe('other')
  })

  it('非代码扩展名与声明文件不计入', () => {
    expect(classifyPath('Cargo.lock')).toBeNull()
    expect(classifyPath('bun.lock')).toBeNull()
    expect(classifyPath('package.json')).toBeNull()
    expect(classifyPath('docs/manual.md')).toBeNull()
    expect(classifyPath('src/vite-env.d.ts')).toBeNull()
  })

  it('Rust 父模块候选覆盖 mod.rs 与 2018 布局', () => {
    expect(rustParentCandidates('src-tauri/src/session/prompt.rs')).toContain('src-tauri/src/session/mod.rs')
    expect(rustParentCandidates('src-tauri/src/lib.rs')).toEqual([])
    expect(rustParentCandidates('src-tauri/src/bin/pylon-cli.rs')).toEqual([])
    expect(rustParentCandidates('src-tauri/pylon-core/src/agent_detection.rs')).toContain('src-tauri/pylon-core/src/lib.rs')
  })
})

describe('crate 清单随 Cargo workspace（issue #259）', () => {
  it('parseWorkspaceCrates 解析 members 数组、剔除主包 "."、保持声明顺序', () => {
    const toml = [
      '[workspace]',
      'members = [',
      '    ".",',
      '    "pylon-core",',
      '    "pylon-acp",',
      '    "pylon-session",',
      '    "pet-core",',
      ']',
      'resolver = "2"',
    ].join('\n')
    expect(parseWorkspaceCrates(toml)).toEqual(['pylon-core', 'pylon-acp', 'pylon-session', 'pet-core'])
  })
  it('无 members 段返回空数组（调用方据此退回兜底清单）', () => {
    expect(parseWorkspaceCrates('[package]\nname = "x"\n')).toEqual([])
    expect(parseWorkspaceCrates('')).toEqual([])
  })
  it('注入的 crate 清单生效——新拆 crate 落 crate:* 区域而非 rust-app 兜底', () => {
    const crates = ['pylon-acp', 'pylon-session']
    expect(classifyPath('src-tauri/pylon-acp/src/engine.rs', undefined, crates))
      .toMatchObject({ bucket: 'production', area: 'crate:pylon-acp' })
    expect(classifyPath('src-tauri/pylon-session/src/owner.rs', undefined, crates))
      .toMatchObject({ bucket: 'production', area: 'crate:pylon-session' })
    expect(classifyPath('src-tauri/src/session/prompt.rs', undefined, crates))
      .toMatchObject({ bucket: 'production', area: 'rust-app' })
  })
  it('兜底清单为 2026-09 workspace 8 成员快照（Cargo.toml 不可读时的存照）', () => {
    expect([...CRATES_FALLBACK].sort()).toEqual([
      'pet-core', 'pylon-acp', 'pylon-canonical-types', 'pylon-compute',
      'pylon-core', 'pylon-foundations', 'pylon-markdown', 'pylon-session',
    ].sort())
  })
})

describe('渲染辅助', () => {
  it('CJK 宽度感知与千分位', () => {
    expect(displayWidth('前端')).toBe(4)
    expect(displayWidth('src')).toBe(3)
    expect(formatNumber(1234567)).toBe('1,234,567')
  })
})
