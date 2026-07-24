import { useState } from 'react'
import './PrismSheet.css'

type Tab = 'bots'|'scenarios'|'worldbook'|'blocks'|'debug'|'system'
const NAV: {key:Tab;label:string}[] = [
  {key:'bots',label:'Bots'},{key:'scenarios',label:'场景'},
  {key:'worldbook',label:'World Book'},{key:'blocks',label:'Blocks'},
  {key:'debug',label:'调试'},{key:'system',label:'系统'},
]

export default function PrismSheet() {
  const [tab,setTab] = useState<Tab>('bots')
  return <div className="prism-sheet">
    <nav className="ps-nav">{NAV.map(n=><button key={n.key} className={`ps-nav-btn ${tab===n.key?'active':''}`} onClick={()=>setTab(n.key)}>{n.label}</button>)}</nav>
    <div className="ps-body">
      {tab==='bots'&&<BotsTab/>}{tab==='scenarios'&&<ScenariosTab/>}
      {tab==='worldbook'&&<WorldBookTab/>}{tab==='blocks'&&<BlocksTab/>}
      {tab==='debug'&&<DebugTab/>}{tab==='system'&&<SystemTab/>}
    </div>
  </div>
}

// ═══════════════════════════════════════════════════════════
//  Bots
// ═══════════════════════════════════════════════════════════
function BotsTab() {
  const bots = [{id:'1904033235',name:'Riccati',status:'online'},{id:'1904034314',name:'l-m',status:'online'}]
  return <div className="ps-tab"><h3>QQ Bot</h3>
    <div className="ps-card-list">{bots.map(b=><div key={b.id} className="ps-card">
      <div className="ps-card-head"><span className={`ps-status ${b.status}`}/><strong>{b.name}</strong><span className="ps-mono">{b.id}</span></div>
      <div className="ps-card-actions"><button className="ps-btn">断开</button><button className="ps-btn">重连</button><button className="ps-btn primary">测试</button></div>
    </div>)}</div>
  </div>
}

// ═══════════════════════════════════════════════════════════
//  Scenarios — dashboard renderScenario + renderScenarioDetail
// ═══════════════════════════════════════════════════════════
function ScenariosTab() {
  const [sel,setSel] = useState('TRPG 战役')
  const scenarios = ['TRPG 战役','默认','技术文档']
  const blocks = [
    {id:'rolecard',header:'角色卡',data:{type:'gate',source:'TRPG 战役'},enabled:true},
    {id:'setting',header:'场景设定',data:{type:'file',path:'world-info/locations.json',file_format:'json'},enabled:true},
    {id:'npc_rules',header:'NPC对话',data:{type:'text',content:'NPC 保持角色性格一致'},enabled:true},
  ]
  return <div className="ps-tab"><h3>场景管理</h3><div className="ps-split">
    {/* Left: scenario list */}
    <div className="ps-list" style={{width:180}}>
      <div className="ps-list-title">场景列表</div>
      {scenarios.map(s=><div key={s} className={`ps-list-item ${sel===s?'active':''}`} onClick={()=>setSel(s)}>{s.toUpperCase()}</div>)}
      <div className="ps-row mt" style={{gap:4}}><button className="ps-btn sm">+ 新建</button><button className="ps-btn sm">↥ 导入</button><button className="ps-btn sm">↧ 导出</button></div>
    </div>
    {/* Right: scenario detail + block sequence */}
    <div className="ps-detail">
      <div className="ps-card">
        <div className="ps-card-head" style={{justifyContent:'space-between'}}>
          <span><strong>{sel.toUpperCase()}</strong> — TRPG 战役场景</span>
          <button className="ps-btn sm danger">删除</button>
        </div>
        <div style={{fontSize:12,color:'var(--text-dim)',marginTop:4}}>源: TRPG 战役, 默认 · 风格: default · allow_additional: true</div>
      </div>
      <div className="ps-card mt">
        <div className="ps-card-title">Block 序列 — 从 <span style={{color:'var(--accent)',cursor:'pointer'}}>块工作站</span> 选取</div>
        <div className="ps-block-list">
          {blocks.map((b,i)=><div key={b.id} className="ps-block-row">
            <span style={{fontWeight:600,width:20,fontSize:13}}>{i+1}</span>
            <span className="ps-block-type-badge">{b.data.type}</span>
            <span style={{fontWeight:600,fontSize:13}}>{b.id}</span>
            {b.header&&<span style={{color:'var(--accent)',fontSize:12}}>[{b.header}]</span>}
            <span style={{flex:1}}/>
            <span className={`ps-toggle ${b.enabled?'on':'off'}`}/>
            <button className="ps-btn sm danger">移除</button>
          </div>)}
        </div>
        <button className="ps-btn sm mt">+ 从库添加 Block</button>
      </div>
    </div>
  </div></div>
}

// ═══════════════════════════════════════════════════════════
//  World Book — dashboard renderEntries
// ═══════════════════════════════════════════════════════════
function WorldBookTab() {
  const allSources = [{name:'TRPG 战役',shared:false},{name:'默认',shared:false},{name:'_shared/通用规则',shared:true}]
  const [selSrc,setSelSrc] = useState('TRPG 战役')
  const [search,setSearch] = useState('')
  const [sort,setSort] = useState('order')
  const entries = [
    {uid:'1',key:'酒馆',comment:'场所-主场景',content:'一座昏暗的酒馆...',order:1},
    {uid:'2',key:'城主',comment:'NPC-酒馆老板',content:'白发老者，酒馆老板',order:2},
    {uid:'3',key:'冒险者公会',comment:'场所-组织',content:'城中的冒险者聚集地',order:3},
  ]
  return <div className="ps-tab"><h3>条目编辑器</h3><div className="ps-split3" style={{alignItems:'stretch'}}>
    {/* Left: source tree by scenario */}
    <div className="ps-list" style={{width:200}}>
      <div className="ps-list-title">知识源</div>
      <details open><summary style={{fontWeight:600,fontSize:12,color:'var(--accent)',cursor:'pointer',padding:'3px 0'}}>◐ 共享源</summary>
        {allSources.filter(s=>s.shared).map(s=><div key={s.name} className={`ps-list-item sm ${selSrc===s.name?'active':''}`} onClick={()=>setSelSrc(s.name)}>{s.name.replace('_shared/','')}</div>)}
      </details>
      <details open><summary style={{fontWeight:600,fontSize:12,cursor:'pointer',padding:'3px 0'}}>TRPG 战役 ●</summary>
        {allSources.filter(s=>!s.shared).map(s=><div key={s.name} className={`ps-list-item sm ${selSrc===s.name?'active':''}`} onClick={()=>setSelSrc(s.name)}>{s.name}</div>)}
      </details>
      <div style={{marginTop:8,fontSize:10,color:'var(--text-dim)'}}>当前: TRPG 战役</div>
    </div>
    {/* Right: entries table */}
    <div style={{flex:1,display:'flex',flexDirection:'column'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <span style={{fontWeight:600,fontSize:13}}>{selSrc}</span>
        <button className="ps-btn sm primary">+ 新增条目</button>
      </div>
      <div style={{display:'flex',gap:6,marginBottom:8}}>
        <input className="ps-input" style={{flex:1}} placeholder="搜索 uid / 备注 / 关键词..." value={search} onChange={e=>setSearch(e.target.value)}/>
        {['order','uid','comment'].map(s=><button key={s} className={`ps-btn sm ${sort===s?'primary':''}`} onClick={()=>setSort(s)} style={{fontSize:11}}>{s}</button>)}
      </div>
      <div style={{flex:1,overflowY:'auto'}}>
        <table className="ps-table">
          <thead><tr><th>#</th><th>UID</th><th>Key</th><th>Comment</th><th style={{width:120}}>操作</th></tr></thead>
          <tbody>
            {entries.map((e,i)=><tr key={e.uid}>
              <td style={{color:'var(--text-dim)'}}>{e.order||i+1}</td>
              <td style={{fontFamily:'var(--mono)',fontSize:12}}>{e.uid}</td>
              <td>{e.key}</td>
              <td style={{color:'var(--text-dim)',fontSize:12}}>{e.comment}</td>
              <td><div style={{display:'flex',gap:4}}><button className="ps-btn sm">编辑</button><button className="ps-btn sm">复制</button><button className="ps-btn sm danger">删除</button></div></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </div></div>
}

// ═══════════════════════════════════════════════════════════
//  Blocks — dashboard renderBlocks
// ═══════════════════════════════════════════════════════════
function BlocksTab() {
  const BTYPES = [
    {id:'gate',label:'Gate — 世界书匹配',hint:'从 world-info/*.json 按关键词匹配',fields:[{k:'source',l:'源目录',v:'world-info'}]},
    {id:'json',label:'Json — 读 JSON 文件',hint:'读 state/world.json',fields:[{k:'path',l:'路径',v:'state/world.json'},{k:'fields',l:'字段(逗号分隔)',v:''}]},
    {id:'jsonl',label:'Jsonl — 尾读 JSONL',hint:'读 history/turns.jsonl',fields:[{k:'path',l:'路径',v:'history/turns.jsonl'},{k:'tail',l:'尾读行数',v:'5'},{k:'field',l:'提取字段',v:'summary'}]},
    {id:'file',label:'File — 读文本文件',hint:'读 .md/.txt 等',fields:[{k:'path',l:'路径',v:'rules/default.md'}]},
    {id:'text',label:'Text — 硬编码文本',hint:'固定文本块',fields:[{k:'content',l:'内容',v:''}]},
    {id:'script',label:'Script — 执行脚本',hint:'调用外部脚本',fields:[{k:'command',l:'命令',v:''},{k:'args',l:'参数',v:''},{k:'timeout',l:'超时(秒)',v:'30'}]},
    {id:'external',label:'HTTP — 外部请求',hint:'调外部 API',fields:[{k:'url',l:'URL',v:'https://'},{k:'method',l:'方法',v:'GET'},{k:'timeout',l:'超时(秒)',v:'30'}]},
  ]
  const blocks = [
    {id:'rolecard',header:'角色卡',data:{type:'gate',source:'TRPG 战役'}},
    {id:'setting',header:'场景设定',data:{type:'file',path:'world-info/locations.json',file_format:'json',fields:['描述']}},
    {id:'npc_rule',header:'NPC对话',data:{type:'text',content:'NPC 保持角色性格一致'}},
    {id:'weather',header:'天气',data:{type:'file',path:'data/weather.txt',file_format:'plain',tail:1}},
    {id:'api_check',header:'状态检查',data:{type:'external',url:'http://localhost:9337/health',method:'GET'}},
  ]

  function summary(b:typeof blocks[0]):string {
    const d=b.data; switch(d.type){
      case 'gate':return '源: '+(d.source||'world-info')
      case 'json':case 'jsonl':return '路径: '+(d.path||'—')+(d.tail?' · 尾'+d.tail+'行':'')
      case 'file':return '路径: '+(d.path||'—')+' · '+(d.file_format||'plain')
      case 'text':return '内容: '+((d.content||'').slice(0,30)||'—')
      case 'script':return '命令: '+(d.command||'—')
      case 'external':return (d.method||'GET')+' '+(d.url||'—')
      default:return ''
    }
  }

  return <div className="ps-tab"><h3>Block 工作站</h3><div className="ps-split3" style={{alignItems:'flex-start'}}>
    {/* Left: type shortcuts */}
    <div style={{width:170,background:'var(--bg-panel)',borderRadius:8,padding:12,border:'1px solid var(--border)'}}>
      <div className="ps-list-title">积木工厂 — 新建 Block</div>
      {BTYPES.map(t=><div key={t.id} className="ps-list-item sm" style={{padding:'8px 10px',cursor:'pointer'}}>
        <strong>+ {t.id}</strong><br/><span style={{fontSize:10,color:'var(--text-dim)'}}>{t.hint}</span></div>)}
    </div>
    {/* Right: block grid */}
    <div style={{flex:1}}>
      <div style={{fontSize:12,color:'var(--text-dim)',marginBottom:10}}>共 {blocks.length} 个 Block · 场景页引用</div>
      <div className="ps-block-list">
        {blocks.map((b,i)=><div key={b.id} className="ps-block-row">
          <span style={{color:'var(--text-dim)',fontSize:10}}>⋮⋮</span>
          <span style={{fontWeight:600,width:24,fontSize:13}}>#{i+1}</span>
          <span className="ps-block-type-badge">{b.data.type}</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13}}>{b.id}{b.header&&<span style={{color:'var(--accent)',marginLeft:4}}>[{b.header}]</span>}</div>
            <div style={{fontSize:11,color:'var(--text-dim)',marginTop:2}}>{summary(b)}</div>
          </div>
          <div className="ps-block-actions"><button className="ps-btn sm">编辑</button><button className="ps-btn sm">复制</button><button className="ps-btn sm danger">删除</button></div>
        </div>)}
      </div>
    </div>
  </div></div>
}

// ═══════════════════════════════════════════════════════════
//  Debug + System (unchanged)
// ═══════════════════════════════════════════════════════════
function DebugTab() {
  const [input,setInput] = useState('')
  const [result,setResult] = useState('')
  return <div className="ps-tab"><h3>注入调试</h3>
    <div className="ps-field"><label>测试消息 (POST /inject)</label><textarea className="ps-textarea" rows={3} value={input} onChange={e=>setInput(e.target.value)}/></div>
    <button className="ps-btn primary mt" onClick={()=>setResult('>> Gate 命中: 酒馆 (0.85), 城主 (0.72)\n>> 注入 blocks: 角色卡, 场景设定\n>> Total: 790 tokens')}>测试</button>
    {result&&<pre className="ps-pre mt">{result}</pre>}
  </div>
}

function SystemTab() {
  return <div className="ps-tab"><h3>系统</h3>
    <div className="ps-split">
      <div className="ps-detail">
        <div className="ps-section-title">LLM (prismo/config.yaml)</div>
        <div className="ps-field"><label>api_type</label><select className="ps-select"><option>auto</option><option>ollama</option><option>openai</option></select></div>
        <div className="ps-field"><label>endpoint</label><input className="ps-input" defaultValue="https://api.deepseek.com"/></div>
        <div className="ps-field"><label>model</label><input className="ps-input" defaultValue="deepseek-v4-flash"/></div>
        <button className="ps-btn primary mt">保存</button><button className="ps-btn sm mt ml">测试 (/api/llm/test)</button>
      </div>
      <div className="ps-detail">
        <div className="ps-section-title">Gate 全局</div>
        <div className="ps-field"><label>user_name</label><input className="ps-input" defaultValue="宫木云"/></div>
        <div className="ps-section-title mt">别名</div>
        <textarea className="ps-textarea" rows={4} defaultValue="vein: vein-protocol"/>
        <button className="ps-btn primary mt">保存</button>
      </div>
    </div>
  </div>
}
