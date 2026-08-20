import json
import sys
import threading
import time

cancelled = set()
write_lock = threading.Lock()


def send(value):
    with write_lock:
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def delayed(request_id, seconds):
    time.sleep(seconds)
    if str(request_id) not in cancelled:
        send({"jsonrpc": "2.0", "id": request_id, "result": {"completed": True}})


for raw in sys.stdin:
    message = json.loads(raw)
    method = message.get("method")
    params = message.get("params")
    request_id = message.get("id")

    if method == "$/cancelRequest":
        cancelled.add(str((params or {}).get("id")))
    elif method == "shutdown":
        break
    elif method == "echo":
        send({"jsonrpc": "2.0", "id": request_id, "result": params})
    elif method == "delay":
        threading.Thread(
            target=delayed,
            args=(request_id, float((params or {}).get("seconds", 1))),
            daemon=True,
        ).start()
    else:
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": "Method not found"},
        })
