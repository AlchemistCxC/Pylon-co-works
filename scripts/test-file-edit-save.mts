/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 * I08-A-FE-02 行为级证据：src/sheets/file/__tests__/FileViewHost.save.test.tsx +
 * FileTabView.edit.test.tsx + workspaceWrite.test.ts + workingDiff.test.ts。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// I08-A-FE-02：真实编辑/save/working-diff 垂直切片的结构接线

// 1. 后端命令：write_workspace_text 带 expected_baseline/force 冲突语义；错误码 conflict/too_large
{
  const cmds = readFileSync(new URL('../src-tauri/src/workspace_cmds.rs', import.meta.url), 'utf8')
  assert.match(cmds, /write_workspace_text/, '必须注册 write_workspace_text 命令')
  assert.match(cmds, /expected_baseline: Option<String>/, '保存必须收 expected_baseline（基线校验）')
  assert.match(cmds, /force: Option<bool>/, '保存必须收 force（覆盖保存）')
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(lib, /crate::workspace_cmds::write_workspace_text/, '命令必须注册进 invoke_handler')
  const ws = readFileSync(new URL('../src-tauri/src/workspace.rs', import.meta.url), 'utf8')
  assert.match(ws, /Conflict/, '错误必须含 conflict 变体')
  assert.match(ws, /TooLarge/, '错误必须含 too_large 变体')
  assert.match(ws, /MAX_SAVE_BYTES/, '必须有大文件编辑上限常量')
}

// 2. 前端收口：saveWorkspaceText 调 write_workspace_text；conflict/too_large 本地分类
{
  const write = readFileSync(new URL('../src/sheets/file/workspaceWrite.ts', import.meta.url), 'utf8')
  assert.match(write, /write_workspace_text/, '必须经 typed 调用写命令')
  assert.match(write, /expectedBaseline: input\.expectedBaseline \?\? null/, '无基线必须传 null')
  assert.match(write, /force: input\.force \?\? false/, 'force 必须带默认值')
  assert.match(write, /conflict/, '分类必须识别 conflict')
  assert.match(write, /too_large/, '分类必须识别 too_large')
}

// 3. working-diff 纯函数：基线 vs 当前全文；选区行号
{
  const diff = readFileSync(new URL('../src/sheets/file/workingDiff.ts', import.meta.url), 'utf8')
  assert.match(diff, /workingDiffLines/, '必须提供基线行级 diff')
  assert.match(diff, /workingDiffStats/, '必须提供增删统计')
  assert.match(diff, /selectionLinesFromTextarea/, '必须提供 textarea 选区行号')
}

// 4. FileTabView：编辑 textarea 受控；dirty 感知重载不静默覆盖；保存锚点推进
{
  const view = readFileSync(new URL('../src/sheets/file/FileTabView.tsx', import.meta.url), 'utf8')
  assert.match(view, /file-edit-textarea/, '编辑必须渲染 textarea')
  assert.match(view, /onContentChange\?\.\(value\)/, '编辑输入必须上报 host（不落盘）')
  assert.match(view, /onExternalChange\?\.\(\)/, '磁盘变化且用户有编辑必须上报冲突')
  assert.match(view, /saveAnchorToken/, '必须支持保存锚点推进（保存后重拉对齐）')
  assert.match(view, /setContent\(value\)/, 'textarea 受控更新自身内容')
}

// 5. FileViewHost：编辑/保存/冲突条/覆盖/重新加载/working-diff 面板
{
  const host = readFileSync(new URL('../src/sheets/file/FileViewHost.tsx', import.meta.url), 'utf8')
  assert.match(host, /编辑/, '必须提供编辑开关')
  assert.match(host, /保存/, '必须提供保存按钮')
  assert.match(host, /覆盖保存/, '冲突必须提供覆盖保存')
  assert.match(host, /重新加载/, '冲突必须提供重新加载')
  assert.match(host, /file-conflict-banner/, '冲突必须渲染冲突条')
  assert.match(host, /saveWorkspaceText\(transport, \{/, '保存必须经收口函数')
  assert.match(host, /classifySaveError\(err\)/, '保存错误必须本地分类')
  assert.match(host, /workingDiffLines\(baseline, fileContent\)/, 'working-diff 必须经纯函数')
  assert.match(host, /<DiffCard output="" payload=\{workingPayload\} \/>/, 'working-diff 必须复用 DiffCard 渲染')
  assert.match(host, /expectedBaseline: force \? null : baseline/, '普通保存带基线、覆盖保存跳过基线')
  assert.match(host, /saveAnchorToken=\{saveAnchor\}/, '保存成功必须推进 FileTabView 锚点')
}

console.log('file edit/save 守卫通过')
