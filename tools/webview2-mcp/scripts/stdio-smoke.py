#!/usr/bin/env python3
"""pylon-webview2-mcp 的 stdio 端到端冒烟。

不需要 Pylon 在运行：这里验证的是 MCP 协议层（分行帧、id 关联、通知不回包、
错误码、工具目录形状），以及「app 没起来时工具给出可操作错误」这条路径。
真实 CDP 链路的验证需要 app 带 --remote-debugging-port 启动，见 README。
"""

import json
import subprocess
import sys

# 服务器按 MCP 规范在 stdout 上写 UTF-8；Windows 上 Python 默认按本地代码页
# （这台机器是 GBK）解码，会直接炸在 UnicodeDecodeError。subprocess 的每一处
# 都显式指定 encoding/errors —— 不用 **kwargs 拆包，那样会让类型检查器无法
# 匹配 subprocess.run 的重载。
_reconfigure = getattr(sys.stdout, "reconfigure", None)
if _reconfigure is not None:
    _reconfigure(encoding="utf-8", errors="replace")

BINARY = sys.argv[1] if len(sys.argv) > 1 else "target/debug/pylon-webview2-mcp"

REQUESTS = [
    # 1. 握手：客户端给一个我们支持的版本，必须原样回。
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "smoke", "version": "0"},
        },
    },
    # 2. 通知：按 JSON-RPC 2.0 不得回包。缺了这条，客户端会把回包当成
    #    对不存在请求的响应而报错。
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    # 3. 工具目录。
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    # 4. 无参数调工具，验证「端点不可达」时的可读结果。
    {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": "webview_targets", "arguments": {}},
    },
    # 5. 缺必填参数：应当是工具级错误，不是协议级错误。
    {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {"name": "webview_evaluate", "arguments": {}},
    },
    # 6. 未知工具。
    {
        "jsonrpc": "2.0",
        "id": 5,
        "method": "tools/call",
        "params": {"name": "nope", "arguments": {}},
    },
    # 7. 未知方法 → -32601。
    {"jsonrpc": "2.0", "id": 6, "method": "no/such"},
    # 8. ping。
    {"jsonrpc": "2.0", "id": 7, "method": "ping"},
]

# 只有带 id 的请求才该有应答；再加上一行坏 JSON 触发的 -32700。
EXPECTED_RESPONSES = len([request for request in REQUESTS if "id" in request]) + 1

EXPECTED_TOOLS = {
    "webview_targets", "webview_evaluate", "webview_raw_cdp", "webview_console",
    "webview_network", "webview_network_body", "webview_websocket", "webview_dom",
    "webview_query", "webview_snapshot", "webview_screenshot", "webview_click",
    "webview_type", "webview_key", "webview_hover", "webview_scroll",
    "webview_select", "webview_wait", "webview_navigate", "tauri_invoke",
    "tauri_events", "tauri_event_catalog", "tauri_window_state", "tauri_backend_logs",
}

FAILURES = []


def check(condition, label, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def json_bool(value):
    """JSON 布尔 → 'true' / 'false' / 'missing'。

    之所以不写 `value is False`：一是与字面量做身份比较会被 lint 拦下，
    二是那样会把「字段缺失」和「字段是 false」判成同一件事，而这两者
    在协议断言里含义完全不同。
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    return "missing"


def parse_json(text, label):
    """解析工具返回的内容块。失败时报得比裸堆栈清楚，并返回 None 让调用方跳过。"""
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        check(False, f"{label} 返回的不是合法 JSON", f"{error}: {text[:200]}")
        return None


def run_server(payload, timeout):
    """跑一次服务器，回 (returncode, stdout, stderr)。解码一律钉成 UTF-8。"""
    completed = subprocess.run(
        [BINARY],
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    return completed.returncode, completed.stdout or "", completed.stderr or ""


def check_handshake(by_id):
    init = by_id.get(1, {}).get("result", {})
    check(init.get("protocolVersion") == "2024-11-05", "initialize 回显客户端协议版本", init.get("protocolVersion"))
    check(
        json_bool(init.get("capabilities", {}).get("tools", {}).get("listChanged")) == "false",
        "声明 tools 能力且 listChanged=false",
    )
    check(init.get("serverInfo", {}).get("name") == "pylon-webview2-mcp", "serverInfo.name 正确")
    check(
        isinstance(init.get("instructions"), str) and len(init["instructions"]) > 100,
        "initialize 带非空 instructions",
    )


def check_notifications_are_not_answered(responses):
    # JSON-RPC 2.0 规定解析错误的 id 必须是 null，所以「存在 null id 的报文」
    # 本身不等于「回了通知」。真正的违规是「null id 且带 result」。
    offenders = [r for r in responses if r.get("id") is None and "result" in r]
    check(not offenders, "通知（无 id）没有产生任何 result 回包", f"{offenders}")
    check(
        len(responses) == EXPECTED_RESPONSES,
        f"响应总数 = 带 id 的请求数(7) + 1 个解析错误",
        f"期望 {EXPECTED_RESPONSES}，实际 {len(responses)}",
    )


def check_tool_catalog(by_id):
    tools = by_id.get(2, {}).get("result", {}).get("tools", [])
    names = {tool.get("name") for tool in tools}
    check(len(tools) == 24, "tools/list 返回 24 个工具", f"实际 {len(tools)}")
    check(names == EXPECTED_TOOLS, "工具名集合与预期一致", f"差集 {names ^ EXPECTED_TOOLS}")
    check(all(tool["inputSchema"]["type"] == "object" for tool in tools), "所有工具都是 object schema")
    check(all(len(tool.get("description", "")) > 40 for tool in tools), "所有工具描述都有实质内容")


def check_unreachable_endpoint(by_id):
    """app 没起来时，webview_targets 仍须给出可操作结果（它是探针，不是失败）。"""
    result = by_id.get(3, {}).get("result", {})
    content = result.get("content", [])
    check(bool(content), "webview_targets 有返回内容")
    if not content:
        return
    body = parse_json(content[0]["text"], "webview_targets")
    if body is None:
        return
    reachable = json_bool(body.get("reachable"))
    check(reachable != "missing", "webview_targets 返回 reachable 字段")
    if reachable == "false":
        error = body.get("error", {})
        check(error.get("error") == "debug_endpoint_unreachable", "不可达时错误码正确", error.get("error"))
        hint_text = json.dumps(body.get("howToEnable", {}), ensure_ascii=False) + str(error.get("detail", ""))
        check("--remote-debugging-port" in hint_text, "不可达时给出开启调试端口的指引")
        check(json_bool(result.get("isError")) == "false", "端点不可达时 webview_targets 不算 isError")
    else:
        print("  --   注意：本机 9222 上有调试端点，走的是可达分支")


def check_missing_required_argument(by_id):
    response = by_id.get(4, {})
    check(response.get("error") is None, "缺参数不产生 JSON-RPC 错误", response.get("error"))
    result = response.get("result", {})
    check(json_bool(result.get("isError")) == "true", "缺参数时 isError=true")
    content = result.get("content", [])
    if not content:
        return
    parsed = parse_json(content[0]["text"], "webview_evaluate 错误块")
    if parsed is None:
        return
    check(parsed.get("error") == "bad_args", "错误码是 bad_args", parsed.get("error"))
    check(parsed.get("tool") == "webview_evaluate", "错误里带工具名", parsed.get("tool"))
    check(isinstance(parsed.get("hint"), str), "错误里带可操作 hint")


def main():
    payload = "\n".join(json.dumps(request, ensure_ascii=False) for request in REQUESTS) + "\n"
    # 故意混入一行坏 JSON：验证解析错误走 -32700，且不拖垮进程后续处理。
    payload += "{ this is not json\n"

    try:
        returncode, stdout, stderr = run_server(payload, timeout=60)
    except subprocess.TimeoutExpired:
        print("FAIL 服务器超时未退出（stdin 关闭后应当自行结束）")
        return 1

    if returncode != 0:
        print(f"FAIL 进程退出码 {returncode}")
        print("stderr:", stderr[-2000:])
        return 1
    print(f"  ok   进程正常退出（stderr {len(stderr.splitlines())} 行）")

    # stdout 必须每一行都是合法 JSON —— 任何一个字符的杂音都会让客户端解析失败。
    responses = []
    for index, line in enumerate(stdout.splitlines()):
        if not line.strip():
            continue
        try:
            responses.append(json.loads(line))
        except json.JSONDecodeError as error:
            check(False, "stdout 每一行都是合法 JSON", f"第 {index + 1} 行：{error}: {line[:120]}")

    by_id = {response.get("id"): response for response in responses if "id" in response}
    print(f"  --   stdout 报文 {len(responses)} 条")

    check_handshake(by_id)
    check_notifications_are_not_answered(responses)
    check_tool_catalog(by_id)
    check_unreachable_endpoint(by_id)
    check_missing_required_argument(by_id)

    result = by_id.get(5, {}).get("result", {})
    check(json_bool(result.get("isError")) == "true", "未知工具 isError=true")
    check("tools/list" in json.dumps(result, ensure_ascii=False), "未知工具错误指向 tools/list")

    check(by_id.get(6, {}).get("error", {}).get("code") == -32601, "未知方法返回 -32601", by_id.get(6, {}).get("error"))
    check(by_id.get(7, {}).get("result") == {}, "ping 返回空对象")

    parse_errors = [r for r in responses if r.get("error", {}).get("code") == -32700]
    check(len(parse_errors) == 1, "坏 JSON 产生恰好一条 -32700", f"实际 {len(parse_errors)}")
    check(bool(parse_errors) and parse_errors[0].get("id") is None, "解析错误报文 id 为 null")

    # 协议版本协商：不支持的版本回退到最新。
    try:
        _, stdout2, _ = run_server(
            json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": "1999-01-01",
                    "capabilities": {},
                    "clientInfo": {"name": "smoke", "version": "0"},
                },
            }) + "\n",
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        check(False, "版本协商进程退出", "超时")
        stdout2 = ""
    first_line = stdout2.splitlines()[0] if stdout2.splitlines() else ""
    negotiated = parse_json(first_line, "版本协商响应")
    if negotiated is not None:
        check(
            negotiated.get("result", {}).get("protocolVersion") == "2025-06-18",
            "未知协议版本回退到最新",
            negotiated.get("result", {}).get("protocolVersion"),
        )

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项：")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
