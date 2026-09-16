#!/usr/bin/env node
// 进程插件 JSON-RPC echo 示例（service 侧）。
// 协议：stdin/stdout 上的换行分隔 JSON-RPC；方法集 echo / delay / $/cancelRequest /
// shutdown。#106 P1：示例服务从 Python 改写为 Node——测试与示例运行不再依赖宿主
// Python 解释器（Node 为 Pylon 开发环境的既有依赖）。
import { createInterface } from "node:readline";

const cancelled = new Set();

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function delayed(requestId, seconds) {
  setTimeout(() => {
    if (!cancelled.has(String(requestId))) {
      send({ jsonrpc: "2.0", id: requestId, result: { completed: true } });
    }
  }, seconds * 1000);
}

const readline = createInterface({ input: process.stdin });
readline.on("line", (raw) => {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const { method, params, id } = message;

  if (method === "$/cancelRequest") {
    cancelled.add(String((params ?? {}).id));
  } else if (method === "shutdown") {
    process.exit(0);
  } else if (method === "echo") {
    send({ jsonrpc: "2.0", id, result: params ?? null });
  } else if (method === "delay") {
    delayed(id, Number((params ?? {}).seconds ?? 1));
  } else {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  }
});
