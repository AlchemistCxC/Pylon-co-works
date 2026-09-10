// Deterministic ACP fixture. It never executes tools or calls a model provider.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
let counter = 0;
const pending = new Map();
const sessions = new Set();
const log = value => { if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify(value) + '\n'); };
const send = value => { log({direction:'out', ...value}); process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\n'); };
const update = (sessionId, update) => send({method:'session/update',params:{sessionId,update}});
const finish = (id, sessionId, text) => {
  update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
  send({id,result:{stopReason:'end_turn'}});
};
for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
  let msg; try { msg=JSON.parse(line); } catch { continue; }
  log({direction:'in',...msg});
  const {id,method,params={}}=msg;
  if (!method && pending.has(id)) {
    const item=pending.get(id); pending.delete(id);
    update(item.sessionId,{sessionUpdate:'tool_call_update',toolCallId:item.toolId,status:'completed',content:[]});
    finish(item.id,item.sessionId,`\n权限结果：${JSON.stringify(msg.result)}。\n\n**UI 验证完成**：此为确定性测试响应，没有执行外部工具。`);
    continue;
  }
  if (method==='initialize') send({id,result:{protocolVersion:1,agentInfo:{name:'Tactical UI Verification Fixture',version:'1.0.0'},agentCapabilities:{loadSession:true,promptCapabilities:{image:false,audio:false,embeddedContext:false},mcpCapabilities:{http:false,sse:false}}}});
  else if (method==='session/new') {const sessionId=`tactical-fixture-${++counter}`;sessions.add(sessionId);send({id,result:{sessionId}});}
  else if (method==='session/load') {sessions.add(params.sessionId);update(params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'已恢复验证会话。'}});send({id,result:{}});}
  else if (method==='session/prompt') {
    if (!sessions.has(params.sessionId)) { send({id,error:{code:-32001,message:'Unknown fixture session: expected session/new or session/load before prompt'}}); continue; }
    const text=(params.prompt||[]).filter(x=>x.type==='text').map(x=>x.text).join(' ');
    if (text.includes('permission')) {
      const toolId=`fixture-read-${counter}`, requestId=`permission-${id}`;
      update(params.sessionId,{sessionUpdate:'tool_call',toolCallId:toolId,title:'只读界面验证（不会访问文件）',kind:'read',status:'pending',content:[],locations:[],rawInput:{path:'fixture://read-only'}});
      pending.set(requestId,{id,sessionId:params.sessionId,toolId});
      send({id:requestId,method:'session/request_permission',params:{sessionId:params.sessionId,toolCall:{toolCallId:toolId,title:'只读界面验证',kind:'read',status:'pending',rawInput:{path:'fixture://read-only'}},options:[{optionId:'allow-once',name:'允许本次',kind:'allow_once'},{optionId:'reject-once',name:'拒绝本次',kind:'reject_once'}]}});
    } else if(text.includes('wait-for-cancel')) pending.set(`wait-${params.sessionId}`,{id,sessionId:params.sessionId});
    else finish(id,params.sessionId,'## 蓝调战术 · 验证响应\n\n已收到消息，ACP 往返正常。\n\n- 会话身份保持\n- 中文与 Markdown 可读\n\n```ts\nconst result = "verified";\n```\n\n这是确定性测试 Agent，不是真实模型回答。');
  } else if(method==='session/cancel') {const key=`wait-${params.sessionId}`,item=pending.get(key);if(item){pending.delete(key);send({id:item.id,result:{stopReason:'cancelled'}});}if(id!==undefined)send({id,result:{}});}
  else if(method==='session/close'||method==='session/set_model'||method==='session/set_config_option'||method==='session/set_mode') {if(id!==undefined)send({id,result:{}});}
  else if(id!==undefined) send({id,error:{code:-32601,message:`Fixture does not implement ${method}`}});
}
