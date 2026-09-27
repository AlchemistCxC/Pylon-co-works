/**
 * CWD-03 裁决消化（CR-602）：前端 isAbsolutePath 与后端 validate_absolute_path
 * （Rust std::path::is_absolute）路径校验口径一致性测试。
 *
 * 分歧根因：Windows 上裸 '/' 前缀路径仅 has_root 无盘符 prefix → is_relative=true
 * → 后端拒绝；修复前前端无条件放行 → 交互困惑（CR-602）。
 * 修复：isAbsolutePath 按平台分支——Windows 拒绝 '/'（与后端一致），Unix 接受。
 * 本测试显式注入 isWindows 参数，确定性覆盖两端平台分支。
 */
import { describe, expect, it } from 'vitest'
import { isAbsolutePath } from '../workspaceEntities'

describe('isAbsolutePath 前后端口径一致性（CR-602）', () => {
  describe('Windows 语义（= 后端 Rust Path::is_absolute 在 Windows）', () => {
    it('盘符 + 反斜杠/正斜杠分隔符为绝对路径', () => {
      expect(isAbsolutePath('C:\\work\\ws-a', true)).toBe(true)
      expect(isAbsolutePath('C:/work/ws-a', true)).toBe(true)
      expect(isAbsolutePath('c:\\', true)).toBe(true)
    })

    it('UNC 前缀为绝对路径', () => {
      expect(isAbsolutePath('\\\\server\\share', true)).toBe(true)
    })

    it('裸 / 前缀仅 has_root 无盘符 prefix → 非绝对（与后端同判拒绝）', () => {
      expect(isAbsolutePath('/foo', true)).toBe(false)
      expect(isAbsolutePath('/', true)).toBe(false)
    })
  })

  describe('Unix 语义（= 后端 Rust Path::is_absolute 在 Unix）', () => {
    it('裸 / 前缀为绝对路径', () => {
      expect(isAbsolutePath('/foo', false)).toBe(true)
      expect(isAbsolutePath('/', false)).toBe(true)
    })

    it('盘符路径判定不依赖平台分支（Windows/Unix 前缀均可的契约）', () => {
      expect(isAbsolutePath('C:/work', false)).toBe(true)
    })
  })

  it('空/纯空白输入拒绝', () => {
    expect(isAbsolutePath('', false)).toBe(false)
    expect(isAbsolutePath('   ', true)).toBe(false)
  })
})
