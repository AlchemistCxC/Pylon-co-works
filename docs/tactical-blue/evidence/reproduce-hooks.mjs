import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';

const root = resolve(process.argv[2] || '.');
const report = [];
for (const ref of ['3127ee4336b30c3f349fd7fe6cb2b69923c4ef3e', '39cad2925c59129d82aa217b6039a0b48d26a12d']) {
  const source = path => execFileSync('git', ['show', `${ref}:${path}`], {cwd:root, encoding:'utf8'});
  const hookTypes = source('src/plugin-runtime/hooks/hookTypes.ts');
  const vocabulary = Function(stripTypeScriptTypes(hookTypes.slice(0,hookTypes.indexOf('export type')).replace('export const','const'))+';return HOOK_NAMES')();
  const production = source('src/infrastructure/hooks/hookBridgeDispatcher.ts');
  const script = stripTypeScriptTypes(production.replace(/^import .*\r?\n/gm,'').replace(/export function/g,'function'));
  const listeners = new Map(), responses = [], calls = [], warnings = [];
  const session = {id:'local-session',source:'profile:local-session',periId:'remote-acp-session',hooks:['test.permission-plugin']};
  const install = Function('invoke','listen','IS_TAURI','useIdentityStore','getHookRuntime','HOOK_NAMES','console',script+';return installPylonHookBridge')(
    async (command,args) => {if(command==='pylon_hook_respond') responses.push(args)},
    async (event,handler) => {listeners.set(event,handler);return()=>listeners.delete(event)},
    true,{getState:()=>({sessions:[session]})},
    ()=>({registry:{getSnapshot:()=>({entries:vocabulary.map(hookName=>({value:{hookName}}))}),subscribe:()=>()=>{}},invoke:async(hook,event)=>{calls.push(hook);return {action:'continue',event,executed:1,skipped:0}}}),
    vocabulary,{warn:text=>warnings.push(text),error:text=>warnings.push(String(text))});
  const dispose = await install();
  for (const [hook,sessionId] of [['message.user.beforeSend',session.id],['permission.request',session.id],['permission.request',session.periId]]) {
    calls.length=0;responses.length=0;warnings.length=0;
    listeners.get('pylon:hook-request')({payload:{requestId:'test-'+report.length,hook,sessionId,payload:{test:true},timeoutMs:3000}});
    await new Promise(setImmediate);
    report.push({ref,hook,sessionId,handlerCalls:calls.length,response:responses[0],warnings:[...warnings]});
    assert.equal(responses.length,1,'actual bridge must respond exactly once');
  }
  dispose();
}
assert.equal(report[0].handlerCalls,1,'control: existing beforeSend works');
assert.equal(report[1].handlerCalls,0,'main rejects permission vocabulary');
assert.equal(report[4].handlerCalls,1,'PR fixes vocabulary for a local id');
assert.equal(report[5].handlerCalls,0,'PR still fails to resolve a remote ACP id');
writeFileSync(resolve(root, 'hook-runtime-reproduction.json'),JSON.stringify({method:'Execute actual production TypeScript after type stripping; mock only Tauri IPC, identity and HookRuntime. Not a native ACP end-to-end test.',results:report},null,2));
console.log(JSON.stringify(report.map(({ref,hook,sessionId,handlerCalls})=>({ref,hook,sessionId,handlerCalls})),null,2));
