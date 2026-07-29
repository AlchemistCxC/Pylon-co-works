import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')

assert.match(source, /const outputHtml = useMemo\(\(\) => \{[\s\S]*?sanitizeHtml\(new Anser\(\)\.ansiToHtml\(Anser\.escapeForHtml\(output\)\)\)/, 'Anser HTML 必须经过 sanitizeHtml')
assert.match(source, /Anser\.escapeForHtml\(output\)/, 'Anser.escapeForHtml 必须保留为第一道输入转义')
assert.match(source, /name === 'Bash' && outputHtml[\s\S]*?dangerouslySetInnerHTML=\{\{ __html: outputHtml \}\}/, 'Bash 输出必须使用已清洗的 outputHtml sink')
assert.match(source, /: <pre><code>\{output\}<\/code><\/pre>/, '非 Bash 输出必须继续使用 React 文本节点')

console.log('ChatView Anser sanitizer sink 回归测试通过')
