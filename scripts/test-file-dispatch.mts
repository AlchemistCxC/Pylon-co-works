import { strict as assert } from 'node:assert'
import { DISPATCH_THRESHOLD_LINES, buildDispatchMessage, extractLines, fenceFor } from '../src/domains/fileDispatch/dispatchMessage.ts'
import { changedLineNumbers } from '../src/domains/fileDispatch/fileDiff.ts'

// W2-07：发令消息纯函数——T=200 边界、整文件/选区/md/truncated 四规则、围栏升级、行级 changed sets

// 1. T=200 边界：199/200 内联，201 长形态
{
  const shortContent = Array.from({ length: 199 }, (_, i) => `line${i}`).join('\n')
  const m199 = buildDispatchMessage({ filePath: 'src/a.ts', selection: null, instruction: '改一下', content: shortContent, truncated: false })
  assert.match(m199, /内容如下：/, '199 行内联全文')
  assert.match(m199, /line0/, '内联包含内容')
  const at200 = buildDispatchMessage({ filePath: 'src/a.ts', selection: null, instruction: '改一下', content: Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n'), truncated: false })
  assert.match(at200, /内容如下：/, '200 行（含边界）内联')
  const longContent = Array.from({ length: 201 }, (_, i) => `line${i}`).join('\n')
  const m201 = buildDispatchMessage({ filePath: 'src/a.ts', selection: null, instruction: '改一下', content: longContent, truncated: false })
  assert.equal(m201.includes('line0'), false, '201 行长形态不内联')
  assert.match(m201, /文件路径为src\/a\.ts\n\n改一下/, '长形态只给路径')
  assert.equal(DISPATCH_THRESHOLD_LINES, 200)
}

// 2. 整文件短：模板精确
{
  const m = buildDispatchMessage({ filePath: 'src/a.ts', selection: null, instruction: '重构', content: 'const a = 1', truncated: false })
  assert.equal(m, '文件路径为src/a.ts，内容如下：\n```\nconst a = 1\n```\n\n重构')
}

// 3. 选区：单行/多行行号 + 选区文本提取
{
  const content = 'l1\nl2\nl3\nl4\nl5'
  const single = buildDispatchMessage({ filePath: 'src/a.ts', selection: { startLine: 2, endLine: 2 }, instruction: '改', content, truncated: false })
  assert.match(single, /行号为2，选中内容如下：/, '单行行号')
  assert.match(single, /\n```\nl2\n```\n/, '选区文本为单行')
  const multi = buildDispatchMessage({ filePath: 'src/a.ts', selection: { startLine: 2, endLine: 4 }, instruction: '改', content, truncated: false })
  assert.match(multi, /行号为2-4，选中内容如下：/, '多行行号')
  assert.match(multi, /\n```\nl2\nl3\nl4\n```\n/, '多行选区提取（含端点）')
  assert.deepEqual(extractLines(content, 2, 4), 'l2\nl3\nl4')
}

// 4. 长选区：只给行号不给内容
{
  const longContent = Array.from({ length: 250 }, (_, i) => `l${i}`).join('\n')
  const m = buildDispatchMessage({ filePath: 'src/a.ts', selection: { startLine: 1, endLine: 201 }, instruction: '改', content: longContent, truncated: false })
  assert.equal(m.includes('```'), false, '长选区不内联')
  assert.match(m, /文件路径为src\/a\.ts，行号为1-201\n\n改/, '长选区只给路径+行号')
}

// 5. 围栏升级：内容含 ``` 升级；最长连续反引号 + 1
{
  const content = '```ts\nconst a = 1\n```'
  const m = buildDispatchMessage({ filePath: 'src/a.ts', selection: null, instruction: '改', content, truncated: false })
  assert.match(m, /\n````\n```ts\nconst a = 1\n```\n````\n/, '三反引号内容 → 四反引号围栏')
  assert.equal(fenceFor('a`b``c'), '```', '最长连续 2 + 1 = 3，但基础 3 保底')
  assert.equal(fenceFor('no backtick'), '```', '无反引号基础 3 围栏')
  assert.equal(fenceFor('````'), '`````', '四反引号 → 五反引号')
}

// 6. markdown：恒内联全文（含超过 T 的长 md）
{
  const longMd = Array.from({ length: 300 }, (_, i) => `paragraph ${i}`).join('\n\n')
  const m = buildDispatchMessage({ filePath: 'README.md', selection: null, instruction: '改', content: longMd, truncated: false })
  assert.match(m, /内容如下：/, 'md 恒内联')
  assert.match(m, /paragraph 0/, '长 md 全文内联')
}

// 7. truncated：强制长形态（不能被 md 特例覆盖）
{
  const md = buildDispatchMessage({ filePath: 'README.md', selection: null, instruction: '改', content: 'short', truncated: true })
  assert.equal(md.includes('```'), false, 'truncated 不内联')
  assert.match(md, /文件路径为README\.md\n\n改/, 'truncated 走长形态')
  const plain = buildDispatchMessage({ filePath: 'a.ts', selection: null, instruction: '改', content: 'short', truncated: true })
  assert.equal(plain.includes('short'), false, 'truncated 短内容也强制长形态')
}

// 8. 行级 changed sets：added/modified 行号（new 1-based）；纯 removed 跳过
{
  assert.deepEqual(changedLineNumbers('a\nb\nc', 'a\nB\nc\nd'), [2, 4], 'modified + added 行号')
  assert.deepEqual(changedLineNumbers('a\nb\nc', 'a\nb\nc'), [], '无变更')
  assert.deepEqual(changedLineNumbers('a\nb\nc\nd', 'a\nb\nc'), [], '纯 removed 行在 new 中不存在则跳过')
  assert.deepEqual(changedLineNumbers('', 'x\ny'), [1, 2], '整文件新增')
}

console.log('file dispatch 发令消息守卫通过')
