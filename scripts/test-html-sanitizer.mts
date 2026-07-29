import assert from 'node:assert/strict'
import { sanitizeHtml } from '../src/components/chat/htmlSanitizer.ts'

const sanitized = sanitizeHtml(
  '<div class="term-root unknown" title="safe" onclick="alert(1)" style="color:red">'
  + '<span class="pl-k pl-syntax unknown">if</span>'
  + '<span class="term-match" aria-hidden="true" role="note">text</span>'
  + '<script>alert(1)</script><style>body{display:none}</style>'
  + '<iframe src="https://evil.example"></iframe><object data="x"></object>'
  + '<a href="javascript:alert(1)">bad link</a>'
  + '<span href="data:text/html,<script>alert(1)</script>" src="javascript:x" onmouseover="x()">safe</span>'
  + '</div>',
)

assert.equal(
  sanitized,
  '<div class="term-root" title="safe"><span class="pl-k pl-syntax">if</span>'
    + '<span class="term-match" aria-hidden="true" role="note">text</span>'
    + 'bad link<span>safe</span></div>',
)
assert.ok(!sanitized.includes('<script'))
assert.ok(!sanitized.includes('<style'))
assert.ok(!sanitized.includes('<iframe'))
assert.ok(!sanitized.includes('<object'))
assert.ok(!sanitized.includes('onclick'))
assert.ok(!sanitized.includes('onmouseover'))
assert.ok(!sanitized.includes('style='))
assert.ok(!sanitized.includes('href='))
assert.ok(!sanitized.includes('src='))

assert.equal(
  sanitizeHtml('<pre><code class="pl-c1 term-active unknown">&lt;safe&gt; & raw</code><br/></pre>'),
  '<pre><code class="pl-c1 term-active">&lt;safe&gt; &amp; raw</code><br></pre>',
)
assert.equal(sanitizeHtml('<div>5 &lt; 6 &amp; 7 &gt; 3</div>'), '<div>5 &lt; 6 &amp; 7 &gt; 3</div>')
assert.equal(sanitizeHtml('<span title="a &quot;quoted&quot; value">ok</span>'), '<span title="a &amp;quot;quoted&amp;quot; value">ok</span>')
assert.equal(sanitizeHtml('<div><span>unclosed'), '<div><span>unclosed</span></div>')

console.log('html sanitizer tests passed')
