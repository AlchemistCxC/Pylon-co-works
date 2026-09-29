/**
 * htmlSanitizer 安全测试（报告 8.8）：script/event handler/javascript URL/SVG
 * payload 不穿透边界；style/class/属性逃逸被拒绝。
 */
import { describe, expect, it } from 'vitest'
import { sanitizeHtml } from '../htmlSanitizer'

describe('htmlSanitizer 安全边界（报告 8.8）', () => {
  it('script/style 标签及其内容整体剥离', () => {
    const out = sanitizeHtml('before<script>alert(1)</script>after<style>body{display:none}</style>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('<style')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('on* 事件属性剥离', () => {
    const out = sanitizeHtml('<div onmouseover="alert(1)" onclick="x()">x</div>')
    expect(out).not.toContain('onmouseover')
    expect(out).not.toContain('onclick')
    expect(out).toContain('x')
  })

  it('javascript: URL 与 data: 伪协议不保留', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">link</a><img src="data:text/html,<script>alert(1)</script>">')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:')
    expect(out).not.toContain('alert')
  })

  it('SVG payload（onload）不穿透', () => {
    const out = sanitizeHtml('<svg onload="alert(1)"><circle r="5"/></svg>')
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('onload')
    expect(out).not.toContain('alert')
  })

  it('style 拒绝 url()/expression/javascript', () => {
    const out = sanitizeHtml('<span style="background-image:url(javascript:alert(1))">x</span>')
    expect(out).not.toContain('url(')
    expect(out).not.toContain('expression')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('x')
  })

  it('属性值引号逃逸被转义（&quot; → &amp;quot;，不闭合属性边界）', () => {
    const out = sanitizeHtml('<span title="&quot; onmouseover=&quot;x()">t</span>')
    // 引号被转义：&quot; 变 &amp;quot;，onmouseover 只是 title 值内文本，不成为真实属性
    expect(out).toContain('&amp;quot;')
    expect(out).not.toContain(' onmouseover="')
    expect(out).not.toContain(' onmouseover=\'')
  })
})
