/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { DISPATCH_THRESHOLD_LINES, buildDispatchMessage, extractLines, fenceFor } from '../src/domains/fileDispatch/dispatchMessage.ts'
import { changedLineNumbers } from '../src/domains/fileDispatch/fileDiff.ts'
import { extractTouchedPath, pushTouchedFile, relativizePath, TOUCHED_FILE_LIMIT, type TouchedFile } from '../src/infrastructure/acp/touchedFiles.ts'
import { readFileSync } from 'node:fs'

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

// ── W2-09：touchedFiles 提取 + LRU + 版本戳接线 ──

// 9. extractTouchedPath：kind 优先/工具名兼容；多键兜底；绝对路径→相对 cwd；取不到 null 不误记
{
  assert.equal(extractTouchedPath({ kind: 'edit', rawInput: { path: 'src/a.ts' } }), 'src/a.ts', 'kind 优先')
  assert.equal(extractTouchedPath({ title: 'Edit', rawInput: { file_path: 'b.ts' } }), 'b.ts', '工具名回退 + file_path 键')
  assert.equal(extractTouchedPath({ title: 'Write', rawInput: { filePath: 'c.ts' } }), 'c.ts', 'filePath 键')
  assert.equal(extractTouchedPath({ title: 'write_file', rawInput: { relativePath: 'd.ts' } }), 'd.ts', 'Hermes snake_case 工具名')
  assert.equal(extractTouchedPath({ title: 'patch', rawInput: { path: 'e.ts' } }), 'e.ts')
  assert.equal(extractTouchedPath({ kind: 'read', rawInput: { path: 'a.ts' } }), null, '非 edit kind → null')
  assert.equal(extractTouchedPath({ title: 'Grep', rawInput: { path: 'a.ts' } }), null, '非 edit 工具名 → null')
  assert.equal(extractTouchedPath({ kind: 'edit', rawInput: {} }), null, '无路径 → null 不误记')
  assert.equal(extractTouchedPath({ kind: 'edit', rawInput: null }), null)
  assert.equal(extractTouchedPath({ kind: 'edit', rawInput: 'str' }), null)
  assert.equal(extractTouchedPath({ kind: 'edit', rawInput: { path: 'G:/work/src/a.ts' }, cwd: 'G:/work' }), 'src/a.ts', '绝对路径对 cwd 求相对')
  assert.equal(extractTouchedPath({ kind: 'edit', rawInput: { path: 'G:/work/src/a.ts' } }), null, '绝对路径无 cwd → null（不记录，防匹配不到）')
  assert.equal(relativizePath('src/a.ts', 'G:/work'), 'src/a.ts', '相对原样')
}

// 10. pushTouchedFile：51 条 LRU（上限 50）、同 path 去重顶替
{
  const files: TouchedFile[] = Array.from({ length: TOUCHED_FILE_LIMIT + 1 }, (_, i) => ({ source: 'local:a', path: `f${i}.ts`, toolKind: 'edit', at: i }))
  const lru = pushTouchedFile(files.slice(0, -1), files[files.length - 1])
  assert.equal(lru.length, TOUCHED_FILE_LIMIT, '51 条截断到 50')
  assert.equal(lru[lru.length - 1]?.path, 'f50.ts', '最新在后')
  const dedup = pushTouchedFile([{ source: 'local:a', path: 'x.ts', toolKind: 'edit', at: 1 }], { source: 'local:a', path: 'x.ts', toolKind: 'edit', at: 2 })
  assert.equal(dedup.length, 1, '同 path 去重顶替')
  assert.equal(dedup[0]?.at, 2)
}

// 11. 接线：controller tool_call 分支 recordTouchedFile；workspaceStore touchedFiles/touchVersions；FileTabView 300ms debounce + data-changed
{
  const controller = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')
  assert.match(controller, /extractTouchedPath\(\{ kind: upd\.kind, title: upd\.title, rawInput: upd\.rawInput, cwd: touchedSession\?\.workdir \}\)/, 'controller 必须经 extractTouchedPath')
  assert.match(controller, /recordTouchedFile\(ctx, \{ path: touchedPath/, '提取成功必须记录 touchedFile（I01-W3 context）')
  const store = readFileSync(new URL('../src/workspaceStore.ts', import.meta.url), 'utf8')
  assert.match(store, /touchedFiles: Record<AgentContextKey, TouchedFile\[\]>/, 'workspaceStore 必须持会话级 touchedFiles（I01-W3 context key）')
  assert.match(store, /touchVersions: Record<string, number>/, '必须持版本戳')
  const tabView = readFileSync(new URL('../src/sheets/file/FileTabView.tsx', import.meta.url), 'utf8')
  assert.match(tabView, /touchVersions\[touchedFileVersionKey\(context, path\)\]/, 'FileTabView 必须订阅版本戳（I01-W3 context+path 二元 key）')
  assert.match(tabView, /window\.setTimeout\(\(\) => \{/, '版本戳变化必须 debounce 重拉/探针')
  assert.match(tabView, /}, 300\)/, '必须 300ms debounce')
  assert.match(tabView, /if \(editingRef\.current \|\| contentRef\.current !== diskRef\.current\) probeDisk\(\)\s+else loadContent\(true\)/, 'I08-A-FE-02：编辑中或有未保存编辑走探针不静默覆盖，只读保持重拉')
  assert.ok(
    /data-changed=\{changedLines\.includes\(index \+ 1\)/.test(tabView)
    || /data-changed=\{changedLineSet\.has\(index \+ 1\)/.test(tabView),
    '改动行必须挂 data-changed 高亮',
  )
  assert.match(tabView, /changedLineNumbers\(previous, loaded\.text\)/, '重拉必须行级 diff')
}

console.log('file dispatch 发令消息守卫通过')
