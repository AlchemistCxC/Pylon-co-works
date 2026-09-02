var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/plugin-runtime/pluginScope.ts
function normalizeDisposable(resource) {
  return typeof resource === "function" ? resource : () => resource.dispose();
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
var PluginScope = class {
  constructor(ownerKey) {
    __publicField(this, "ownerKey");
    __publicField(this, "resources", []);
    __publicField(this, "closing", false);
    __publicField(this, "disposed", false);
    __publicField(this, "resourceSequence", 0);
    __publicField(this, "disposal");
    if (!ownerKey) throw new Error("PluginScope ownerKey \u4E0D\u80FD\u4E3A\u7A7A");
    this.ownerKey = ownerKey;
  }
  get isDisposed() {
    return this.disposed;
  }
  get size() {
    return this.resources.length;
  }
  add(resource, metadata = {}) {
    if (this.closing) throw new Error(`PluginScope \u5DF2\u91CA\u653E\uFF1A${this.ownerKey}`);
    const resourceId = metadata.resourceId ?? `${this.ownerKey}:resource-${++this.resourceSequence}`;
    if (this.resources.some((record) => record.resourceId === resourceId)) {
      throw new Error(`PluginScope resourceId \u91CD\u590D\uFF1A${resourceId}`);
    }
    this.resources.push({
      resourceId,
      label: metadata.label,
      dispose: normalizeDisposable(resource)
    });
    return resource;
  }
  listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      target.removeEventListener(type, listener, options);
    };
    this.add(remove, { label: `event:${type}` });
    return remove;
  }
  setTimeout(handler, timeout, ...args) {
    const handle = globalThis.setTimeout(handler, timeout, ...args);
    this.add(() => globalThis.clearTimeout(handle), { label: "timeout" });
    return handle;
  }
  setInterval(handler, timeout, ...args) {
    const handle = globalThis.setInterval(handler, timeout, ...args);
    this.add(() => globalThis.clearInterval(handle), { label: "interval" });
    return handle;
  }
  createAbortController() {
    const controller = new AbortController();
    this.add(
      () => controller.abort(`PluginScope disposed: ${this.ownerKey}`),
      { label: "abort-controller" }
    );
    return controller;
  }
  disposeNow() {
    return this.dispose();
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.closing = true;
    const operation = this.performDispose();
    this.disposal = operation;
    void operation.finally(() => {
      if (this.disposal === operation) this.disposal = void 0;
    });
    return operation;
  }
  async performDispose() {
    let disposed = 0;
    const errors = [];
    for (const record of [...this.resources].reverse()) {
      try {
        await record.dispose();
        this.resources = this.resources.filter((item) => item.resourceId !== record.resourceId);
        disposed += 1;
      } catch (error) {
        errors.push(Object.freeze({
          resourceId: record.resourceId,
          message: messageOf(error)
        }));
      }
    }
    this.disposed = this.resources.length === 0;
    return Object.freeze({
      disposed,
      remaining: this.resources.length,
      errors: Object.freeze(errors)
    });
  }
};

// src/plugin-runtime/storage/pluginStorageContract.ts
var PLUGIN_STORAGE_BUDGET_BYTES = 1024 * 1024;
var PluginStorageError = class extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
    __publicField(this, "code", "plugin_storage_error");
    this.name = "PluginStorageError";
  }
};

// src/plugin-runtime/settings/pluginKeyValidation.ts
function validatePluginKey(key, label) {
  if (!key || key !== key.trim() || key.includes("__proto__")) {
    throw new Error(`${label} key \u975E\u6CD5\uFF1A${key}`);
  }
}

// src/sdk/testing.ts
function recordingApi(member, log) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== "string") return void 0;
      return (...args) => {
        log.push({ member, method: prop, args: Object.freeze([...args]) });
        return void 0;
      };
    }
  });
}
function cloneMockValue(value, field) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new PluginStorageError(
      field,
      `mock storage value must be cloneable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function mockStorage(initial = {}) {
  const values = /* @__PURE__ */ Object.create(null);
  const listeners = /* @__PURE__ */ new Set();
  let writes = 0;
  for (const [key, value] of Object.entries(initial)) {
    validatePluginKey(key, "\u63D2\u4EF6\u5B58\u50A8");
    values[key] = cloneMockValue(value, "value");
  }
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const api = {
    getValue(key) {
      validatePluginKey(key, "\u63D2\u4EF6\u5B58\u50A8");
      if (!Object.hasOwn(values, key)) return void 0;
      return cloneMockValue(values[key], "read");
    },
    setValue(key, value) {
      validatePluginKey(key, "\u63D2\u4EF6\u5B58\u50A8");
      const candidate = { ...values, [key]: cloneMockValue(value, "value") };
      const size = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
      if (size > PLUGIN_STORAGE_BUDGET_BYTES) throw new PluginStorageError("quota", "mock storage quota exceeded");
      Object.keys(values).forEach((existing) => {
        delete values[existing];
      });
      Object.assign(values, candidate);
      writes += 1;
      notify();
    },
    removeValue(key) {
      validatePluginKey(key, "\u63D2\u4EF6\u5B58\u50A8");
      if (!Object.hasOwn(values, key)) return;
      delete values[key];
      writes += 1;
      notify();
    },
    keys: () => Object.keys(values),
    clear() {
      if (Object.keys(values).length === 0) return;
      Object.keys(values).forEach((key) => {
        delete values[key];
      });
      writes += 1;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return { api, values, changeCount: () => writes };
}
function createMockContext(options = {}) {
  const pluginId = options.pluginId ?? "mock.plugin";
  const runtimeInstanceId = options.runtimeInstanceId ?? "mock-runtime-1";
  const identity = {
    pluginId,
    version: "0.0.0-mock",
    packageInstanceId: `${pluginId}#mock-package`,
    runtimeInstanceId,
    instanceId: `${pluginId}#${runtimeInstanceId}`,
    key: `${pluginId}#${runtimeInstanceId}`
  };
  const scope = new PluginScope(`mock:${pluginId}`);
  const commandBucket = [];
  const hookBucket = [];
  const surfaces = [];
  const sessionMeta = /* @__PURE__ */ new Map();
  const sessionCtx = /* @__PURE__ */ new Map();
  const turnMeta = /* @__PURE__ */ new Map();
  const turnCtx = /* @__PURE__ */ new Map();
  const turnKnown = /* @__PURE__ */ new Set();
  const settingsValues = { ...options.settingsValues ?? {} };
  const storageHarness = mockStorage(options.storageValues);
  const settingsListeners = /* @__PURE__ */ new Set();
  const recorded = [];
  let settingsWrites = 0;
  const disposable = (dispose) => ({ dispose });
  const executeCommand = async (id, args, options2) => {
    const def = commandBucket.find((entry) => entry.id === id);
    if (!def) throw new Error(`mock: \u547D\u4EE4 ${id} \u672A\u6CE8\u518C`);
    if (!def.execute) throw new Error(`mock: \u547D\u4EE4 ${id} \u4E0D\u53EF\u6267\u884C`);
    if (options2?.signal?.aborted) throw options2.signal.reason ?? new DOMException("Aborted", "AbortError");
    const execCtx = { commandId: id, args, signal: options2?.signal };
    return await def.execute(execCtx);
  };
  const commands = {
    register: (definition) => {
      commandBucket.push(definition);
      return scope.add(disposable(() => {
        const index = commandBucket.indexOf(definition);
        if (index >= 0) commandBucket.splice(index, 1);
      }));
    },
    execute: executeCommand,
    list: () => [],
    describe: () => null
  };
  const dispatchHooks = async (name, event) => {
    const defs = hookBucket.filter((entry) => entry.hookName === name).sort((left, right) => (right.definition.priority ?? 100) - (left.definition.priority ?? 100));
    let current = event;
    let executed = 0;
    for (const { definition } of defs) {
      const result = await definition.handler({
        invocationId: `mock-${name}-${executed}`,
        hookName: name,
        event: current,
        signal: new AbortController().signal
      });
      if (!result || result.action === "continue") {
        if (result && "event" in result && result.event !== void 0) current = result.event;
        executed += 1;
        continue;
      }
      if (result.action === "cancel") {
        return { action: "cancel", event: current, executed: executed + 1, skipped: 0, reason: result.reason };
      }
      if (result.action === "respond") {
        return { action: "respond", event: current, output: result.output, executed: executed + 1, skipped: 0 };
      }
      executed += 1;
    }
    return { action: "continue", event: current, executed, skipped: 0 };
  };
  const hooks = {
    register: (hookName, definition) => {
      const entry = { hookName, definition };
      hookBucket.push(entry);
      return scope.add(disposable(() => {
        const index = hookBucket.indexOf(entry);
        if (index >= 0) hookBucket.splice(index, 1);
      }));
    },
    invoke: dispatchHooks
  };
  const cloneNamespace = (value) => JSON.parse(JSON.stringify(value));
  const sessions = {
    getPluginMetadata: (sessionId) => cloneNamespace(sessionMeta.get(sessionId) ?? {}),
    setPluginMetadata: (sessionId, patch) => {
      const prev = sessionMeta.get(sessionId) ?? {};
      sessionMeta.set(sessionId, cloneNamespace({ ...prev, ...patch }));
      return true;
    },
    getPluginContext: (sessionId) => cloneNamespace(sessionCtx.get(sessionId) ?? {}),
    setPluginContext: (sessionId, patch) => {
      const prev = sessionCtx.get(sessionId) ?? {};
      sessionCtx.set(sessionId, cloneNamespace({ ...prev, ...patch }));
      return true;
    }
  };
  const turns = {
    ensure: (turn) => {
      turnKnown.add(turn.id);
      return true;
    },
    getPluginMetadata: (turnId) => cloneNamespace(turnMeta.get(turnId) ?? {}),
    setPluginMetadata: (turnId, patch) => {
      if (!turnKnown.has(turnId)) return false;
      turnMeta.set(turnId, cloneNamespace({ ...turnMeta.get(turnId) ?? {}, ...patch }));
      return true;
    },
    getPluginContext: (turnId) => cloneNamespace(turnCtx.get(turnId) ?? {}),
    setPluginContext: (turnId, patch) => {
      if (!turnKnown.has(turnId)) return false;
      turnCtx.set(turnId, cloneNamespace({ ...turnCtx.get(turnId) ?? {}, ...patch }));
      return true;
    }
  };
  const settings = {
    registerPage: () => {
    },
    registerOptions: () => {
    },
    getValue: (key) => settingsValues[key],
    setValue: (key, value) => {
      settingsValues[key] = value;
      settingsWrites += 1;
      settingsListeners.forEach((listener) => listener());
    },
    removeValue: (key) => {
      delete settingsValues[key];
      settingsWrites += 1;
      settingsListeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    }
  };
  const ui = {
    registerSurface: (surface) => {
      surfaces.push(surface);
    }
  };
  const context = {
    identity,
    scope,
    application: recordingApi("application", recorded),
    workspace: recordingApi("workspace", recorded),
    renderer: recordingApi("renderer", recorded),
    commands,
    hooks,
    sessions,
    turns,
    process: recordingApi("process", recorded),
    ui,
    services: recordingApi("services", recorded),
    sidebar: recordingApi("sidebar", recorded),
    fileWorkbench: recordingApi("fileWorkbench", recorded),
    contextPanel: recordingApi("contextPanel", recorded),
    presentation: recordingApi("presentation", recorded),
    settings,
    fonts: recordingApi("fonts", recorded),
    sessionCreation: recordingApi("sessionCreation", recorded),
    interfaceModes: recordingApi("interfaceModes", recorded),
    titlebar: recordingApi("titlebar", recorded),
    storage: storageHarness.api
  };
  const mock = context;
  Object.defineProperty(mock, "__commands", {
    value: {
      registered: commandBucket,
      execute: executeCommand
    }
  });
  Object.defineProperty(mock, "__hooks", {
    value: {
      registered: hookBucket,
      dispatch: dispatchHooks
    }
  });
  Object.defineProperty(mock, "__ui", {
    value: {
      surfaces,
      mount(surfaceId) {
        const surface = surfaces.find((entry) => entry.id === surfaceId);
        if (!surface) throw new Error(`mock: surface ${surfaceId} \u672A\u6CE8\u518C`);
        const container = document.createElement("div");
        const events = [];
        const handlers = /* @__PURE__ */ new Map();
        const bridge = {
          on(event, listener) {
            const bucket = handlers.get(event);
            if (bucket) bucket.add(listener);
            else handlers.set(event, /* @__PURE__ */ new Set([listener]));
            return () => {
              handlers.get(event)?.delete(listener);
            };
          },
          emit(event, detail) {
            events.push({ event, detail });
            handlers.get(event)?.forEach((listener) => listener(detail));
          },
          clear() {
            events.length = 0;
          }
        };
        let disposed = false;
        let unmountPromise;
        const disposeSurface = async (value) => {
          if (typeof value === "function") await value();
          else if (value && typeof value === "object") await value.unmount();
        };
        let mountResult;
        try {
          mountResult = surface.mount(container, bridge);
        } catch (error) {
          mountResult = Promise.reject(error);
        }
        const mountPromise = Promise.resolve(mountResult);
        bridge.on("settings:set", (detail) => {
          const payload = detail;
          if (typeof payload?.key === "string") settings.setValue(payload.key, payload.value);
        });
        bridge.on("settings:remove", (detail) => {
          if (typeof detail === "string") settings.removeValue(detail);
        });
        if (mountResult && typeof mountResult.then === "function") {
          void mountPromise.then(() => {
            if (disposed) return void 0;
            bridge.emit("host:input", { pluginId, pageId: surfaceId, values: settingsValues });
            return void 0;
          }).catch((error) => {
            events.push({ event: "ui:mount-error", detail: error });
          });
        } else {
          bridge.emit("host:input", { pluginId, pageId: surfaceId, values: settingsValues });
        }
        return {
          container,
          events,
          hostInput(values) {
            bridge.emit("host:input", { pluginId, pageId: surfaceId, values });
          },
          unmount() {
            if (unmountPromise) return unmountPromise;
            disposed = true;
            container.replaceChildren();
            unmountPromise = mountPromise.then((value) => disposeSurface(value)).catch((error) => {
              events.push({ event: "ui:unmount-error", detail: error });
            }).then(() => {
              handlers.clear();
            });
            return unmountPromise;
          }
        };
      }
    }
  });
  Object.defineProperty(mock, "__settings", {
    value: {
      values: settingsValues,
      changeCount: () => settingsWrites
    }
  });
  Object.defineProperty(mock, "__storage", {
    value: {
      values: storageHarness.values,
      changeCount: storageHarness.changeCount
    }
  });
  Object.defineProperty(mock, "__recorded", {
    get: () => Object.freeze([...recorded])
  });
  Object.defineProperty(mock, "__scopeDispose", { value: () => scope.dispose() });
  return mock;
}
export {
  PluginStorageError,
  createMockContext
};
