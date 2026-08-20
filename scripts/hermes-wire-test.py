"""真实 Hermes ACP wire 验证：Pylon 参数格式握手测试。
发送 initialize → session/new → session/set_model → session/prompt → cancel。
"""
import json, subprocess, sys, time, os

proc = subprocess.Popen(
    ["hermes", "acp"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1,
)

def rpc(method, params, notif=False):
    req = {"jsonrpc": "2.0", "method": method, "params": params}
    if not notif:
        req["id"] = rpc._next_id
        rpc._next_id += 1
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    if notif:
        return None
    # read until we get the response with matching id
    while True:
        line = proc.stdout.readline()
        if not line:
            return {"error": "EOF"}
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if msg.get("id") == req["id"]:
            return msg

rpc._next_id = 1

print("== initialize ==")
resp = rpc("initialize", {
    "protocolVersion": 1,
    "clientCapabilities": {"fs": {}, "terminal": False, "auth": {}, "_meta": {"peri.tokenStats": True}},
    "clientInfo": {"name": "pylon-wire-test", "version": "0.1.0"},
})
print("result:", json.dumps(resp.get("result"), ensure_ascii=False)[:300])
agent_info = resp.get("result", {}).get("agentInfo", {})
print("agent:", agent_info.get("name"), agent_info.get("version"))

print("\n== session/new (mcpServers: []) ==")
resp = rpc("session/new", {"cwd": "/path/to/project", "mcpServers": []})
print("result:", json.dumps(resp.get("result"), ensure_ascii=False)[:300])
session_id = resp.get("result", {}).get("sessionId")
print("sessionId:", session_id)

print("\n== session/new (带 MCP stdio 配置, 官方格式) ==")
resp = rpc("session/new", {"cwd": "/path/to/project", "mcpServers": [
    {"name": "demo-mcp", "command": "demo-mcp", "args": ["--stdio"], "env": []},
    {"type": "http", "name": "web-mcp", "url": "http://127.0.0.1:3000/mcp", "headers": []},
]})
print("error:", resp.get("error"))
print("result:", json.dumps(resp.get("result"), ensure_ascii=False)[:200])
mcp_session_id = resp.get("result", {}).get("sessionId")
if mcp_session_id:
    rpc("session/close", {"sessionId": mcp_session_id})
    print("mcp session closed")

print("\n== session/set_model (Hermes 切 model 途径) ==")
resp = rpc("session/set_model", {"sessionId": session_id, "modelId": "deepseek-v4-flash"})
print("result:", json.dumps(resp.get("result"), ensure_ascii=False)[:200])
print("error:", resp.get("error"))

print("\n== session/set_config_option model=... (Pylon 旧路径, Hermes 应不生效但不报错) ==")
resp = rpc("session/set_config_option", {"sessionId": session_id, "configId": "model", "value": "deepseek-v4-pro"})
print("result:", json.dumps(resp.get("result"), ensure_ascii=False)[:200])
print("error:", resp.get("error"))

print("\n== session/set_mode ==")
resp = rpc("session/set_mode", {"sessionId": session_id, "modeId": "default"})
print("result:", json.dumps(resp.get("result"), ensure_ascii=False)[:200])

print("\n== session/prompt ==")
resp = rpc("session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": "回复 OK 两个字"}]})
print("prompt error:", resp.get("error"))
print("prompt result:", json.dumps(resp.get("result"), ensure_ascii=False)[:300])

print("\n== session/cancel (notification) ==")
rpc("session/cancel", {"sessionId": session_id}, notif=True)
print("sent")

print("\n== session/close (Hermes 未实现, 预期 -32601) ==")
resp = rpc("session/close", {"sessionId": session_id})
print("result:", json.dumps(resp.get("result"), ensure_ascii=False)[:200])
print("error:", resp.get("error"))

proc.stdin.close()
proc.wait(timeout=10)
print("\n== done ==")
