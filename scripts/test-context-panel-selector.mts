/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// W2-12 右栏修复（2026-08-06，用户报选 agent 后 Maximum update depth）：
// zustand v5 useStore 的 selector 返回值即 useSyncExternalStore 快照——selector 返回
// 新引用（`?? []` 每次新数组）→ Object.is 不等 → forceStoreRerender 死循环。
// 守卫：touchedFiles 必须选整个 record（引用稳定），派生留组件体。

for (const path of ['src/components/right-panel/AgentContextPanel.tsx', 'src/components/right-panel/FileContextPanel.tsx']) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  assert.match(source, /useWorkspaceStore\(s => s\.touchedFiles\)/, `${path} 必须选整个 touchedFiles record（稳定引用）`)
  assert.equal(
    /useWorkspaceStore\([^)]*touchedFiles\[source\] \?\? \[\]/.test(source),
    false,
    `${path} selector 不得含 \`?? []\`（新引用死循环）`,
  )
  assert.equal(
    /useWorkspaceStore\([^)]*touchedFiles\[source\][^)]*\]/.test(source),
    false,
    `${path} 不得在 selector 内做数组派生`,
  )
  if (path.includes('AgentContextPanel')) {
    assert.match(source, /touchedFilesRecord\[toAgentContextKey\(touchedContext\)\]/, `${path} 派生必须留组件体（I01-W3 context key）`)
  } else {
    // FileContextPanel（FE-AUD-022 反查）：activeFile 稳定 selector + sourcesForPath 组件体派生
    assert.match(source, /useWorkspaceStore\(state => \{/, `${path} activeFile 必须经稳定 selector`)
    assert.match(source, /sourcesForPath\(touchedFilesRecord, activeFile\)/, `${path} 反查必须在组件体（sourcesForPath）`)
  }
}

console.log('context panel selector 守卫通过')
