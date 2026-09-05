var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/plugin-runtime/packageManifest.ts
var PYLON_PLUGIN_API_MIN = "1.0";
var PYLON_PLUGIN_API_LATEST = "1.2";
var PYLON_PLUGIN_API_SUPPORTED = [PYLON_PLUGIN_API_MIN, "1.1", PYLON_PLUGIN_API_LATEST];
var PYLON_PLUGIN_API_VERSION = PYLON_PLUGIN_API_MIN;
var PYLON_PLUGIN_MANIFEST_FILE = "pylon-plugin.json";
var PYLON_PLUGIN_CAPABILITIES = ["plugin.management"];
var PluginManifestError = class extends Error {
  constructor(field, message) {
    super(`pylon-plugin.json ${field} ${message}`);
    this.field = field;
    __publicField(this, "code", "plugin_manifest_invalid");
    this.name = "PluginManifestError";
  }
};
var ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
var VERSION_RANGE_PATTERN = /^(?:\*|\^?\d+\.\d+\.\d+)$/;
var KINDS = /* @__PURE__ */ new Set([
  "shell",
  "workspace",
  "feature",
  "hook",
  "renderer",
  "skin",
  "agent-adapter",
  "tool-provider",
  "service",
  "automation"
]);
var HOT_SWAP_MODES = /* @__PURE__ */ new Set([
  "parallel",
  "exclusive",
  "soft-remount",
  "restart-required"
]);
var API_SUPPORTED_SET = new Set(PYLON_PLUGIN_API_SUPPORTED);
var CAPABILITY_SET = new Set(PYLON_PLUGIN_CAPABILITIES);
function removedFieldsFor(api) {
  return api === PYLON_PLUGIN_API_LATEST ? ["trust", "contributes", "signature", "entry"] : ["trust", "capabilities", "contributes", "signature", "entry"];
}
function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pylon-plugin.json ${field} \u5FC5\u987B\u662F\u5BF9\u8C61`);
  }
  return value;
}
function stringMap(value, field) {
  const map = record(value, field);
  for (const [key, entry] of Object.entries(map)) {
    if (!ID_PATTERN.test(key)) {
      throw new PluginManifestError(`${field}.${key}`, "\u4F9D\u8D56 id \u5FC5\u987B\u662F\u70B9\u5206\u5C0F\u5199\u547D\u540D");
    }
    if (typeof entry !== "string") throw new Error(`pylon-plugin.json ${field}.${key} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
    if (!VERSION_RANGE_PATTERN.test(entry)) {
      throw new PluginManifestError(
        `${field}.${key}`,
        "\u53EA\u652F\u6301 exact\u3001caret \u6216 * \u7248\u672C\u8303\u56F4"
      );
    }
  }
}
function parsePylonPluginManifest(source) {
  const manifest = record(typeof source === "string" ? JSON.parse(source) : source, "root");
  for (const removed of removedFieldsFor(manifest.api)) {
    if (Object.hasOwn(manifest, removed)) {
      throw new Error(`pylon-plugin.json \u5B57\u6BB5 ${removed} \u5DF2\u4ECE API 1.0 \u5220\u9664`);
    }
  }
  if (manifest.schema !== 1) throw new Error("pylon-plugin.json schema \u5FC5\u987B\u4E3A 1");
  if (typeof manifest.id !== "string" || !ID_PATTERN.test(manifest.id)) {
    throw new Error("pylon-plugin.json id \u5FC5\u987B\u662F\u70B9\u5206\u5C0F\u5199\u547D\u540D");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new Error("pylon-plugin.json \u7F3A\u5C11 name");
  if (typeof manifest.version !== "string" || !manifest.version.trim()) throw new Error("pylon-plugin.json \u7F3A\u5C11 version");
  if (typeof manifest.api !== "string" || !API_SUPPORTED_SET.has(manifest.api)) {
    throw new Error(
      `pylon-plugin.json api \u4EC5\u652F\u6301 ${PYLON_PLUGIN_API_SUPPORTED.join("/")}\uFF08\u66F4\u9AD8\u7248\u672C\u9700\u5347\u7EA7\u5BBF\u4E3B\uFF09`
    );
  }
  if (manifest.api === PYLON_PLUGIN_API_LATEST && manifest.capabilities !== void 0) {
    if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some((value) => typeof value !== "string" || !value.trim())) {
      throw new PluginManifestError("capabilities", "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
    }
    const seen = /* @__PURE__ */ new Set();
    manifest.capabilities.forEach((capability, index) => {
      if (!CAPABILITY_SET.has(capability)) {
        throw new PluginManifestError(
          `capabilities.${index}`,
          `\u672A\u77E5 capability\uFF08\u5C01\u95ED\u8BCD\u8868\uFF1A${PYLON_PLUGIN_CAPABILITIES.join("/")}\uFF09`
        );
      }
      if (seen.has(capability)) {
        throw new PluginManifestError(`capabilities.${index}`, "capability \u91CD\u590D\u58F0\u660E");
      }
      seen.add(capability);
    });
  }
  if (typeof manifest.kind !== "string" || !KINDS.has(manifest.kind)) throw new Error("pylon-plugin.json kind \u65E0\u6548");
  const web = record(manifest.web, "web");
  if (typeof web.entry !== "string" || !web.entry.trim()) throw new Error("pylon-plugin.json \u7F3A\u5C11 web.entry");
  if (web.styles !== void 0 && (!Array.isArray(web.styles) || web.styles.some((value) => typeof value !== "string"))) {
    throw new Error("pylon-plugin.json web.styles \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
  }
  if (manifest.dependencies !== void 0) stringMap(manifest.dependencies, "dependencies");
  if (manifest.optionalDependencies !== void 0) stringMap(manifest.optionalDependencies, "optionalDependencies");
  if (manifest.conflicts !== void 0 && (!Array.isArray(manifest.conflicts) || manifest.conflicts.some((value) => typeof value !== "string"))) {
    throw new Error("pylon-plugin.json conflicts \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
  }
  if (Array.isArray(manifest.conflicts)) {
    manifest.conflicts.forEach((conflict, index) => {
      if (typeof conflict !== "string" || !ID_PATTERN.test(conflict)) {
        throw new PluginManifestError(`conflicts.${index}`, "\u5FC5\u987B\u662F\u5408\u6CD5\u63D2\u4EF6 id");
      }
      if (conflict === manifest.id) {
        throw new PluginManifestError(`conflicts.${index}`, "\u4E0D\u80FD\u4E0E\u63D2\u4EF6\u81EA\u8EAB\u51B2\u7A81");
      }
    });
  }
  if (manifest.activation !== void 0) {
    const activation = record(manifest.activation, "activation");
    const events = activation.events;
    if (!Array.isArray(events) || events.length === 0 || events.some((event) => typeof event !== "string" || !event.trim()) || new Set(events).size !== events.length) {
      throw new PluginManifestError(
        "activation.events",
        "\u5FC5\u987B\u662F\u975E\u7A7A\u4E14\u4E0D\u91CD\u590D\u7684\u5B57\u7B26\u4E32\u6570\u7EC4"
      );
    }
  }
  if (manifest.hotSwap !== void 0) {
    const hotSwap = record(manifest.hotSwap, "hotSwap");
    if (!HOT_SWAP_MODES.has(hotSwap.mode)) throw new Error("pylon-plugin.json hotSwap.mode \u65E0\u6548");
    if (hotSwap.drainTimeoutMs !== void 0 && (!Number.isFinite(hotSwap.drainTimeoutMs) || Number(hotSwap.drainTimeoutMs) <= 0)) {
      throw new Error("pylon-plugin.json hotSwap.drainTimeoutMs \u5FC5\u987B\u662F\u6B63\u6570");
    }
  }
  if (manifest.reactVersion !== void 0 && typeof manifest.reactVersion !== "string") {
    throw new Error("pylon-plugin.json reactVersion \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  }
  return manifest;
}

// src/plugin-runtime/settings/settingsTargetGrammar.ts
var NAMESPACES = /* @__PURE__ */ new Set(["theme", "kind", "slot", "suite", "plugin-page", "context-panel"]);
function validateSettingsTarget(target) {
  if (!target || !NAMESPACES.has(target.namespace)) throw new Error("Settings target namespace \u975E\u6CD5");
  if (!target.ownerId.trim()) throw new Error("Settings target ownerId \u4E0D\u80FD\u4E3A\u7A7A");
  if (!target.fieldKey.trim()) throw new Error("Settings target fieldKey \u4E0D\u80FD\u4E3A\u7A7A");
  if (target.ownerPluginId !== void 0 && !target.ownerPluginId.trim()) throw new Error("Settings target ownerPluginId \u4E0D\u80FD\u4E3A\u7A7A");
  return Object.freeze({ ...target });
}
function stringifySettingsTarget(target) {
  const normalized = validateSettingsTarget(target);
  const encode = (value) => encodeURIComponent(value).replaceAll(".", "%2E");
  if (normalized.namespace === "theme" && normalized.ownerId === "theme") {
    return ["theme", encode(normalized.fieldKey)].join(".");
  }
  const parts = [normalized.namespace];
  if (normalized.ownerPluginId !== void 0) parts.push(encode(normalized.ownerPluginId));
  parts.push(encode(normalized.ownerId), encode(normalized.fieldKey));
  return parts.join(".");
}
function parseSettingsTarget(value) {
  if (typeof value !== "string" || !value.trim()) return void 0;
  const parts = value.split(".");
  const namespace = parts[0];
  if (!NAMESPACES.has(namespace)) return void 0;
  try {
    if (namespace === "theme" && parts.length === 2) {
      const fieldKey2 = decodeURIComponent(parts[1]);
      return fieldKey2 ? validateSettingsTarget({ namespace, ownerId: "theme", fieldKey: fieldKey2 }) : void 0;
    }
    if (parts.length !== 3 && parts.length !== 4) return void 0;
    const decode = (part) => decodeURIComponent(part);
    const ownerPluginId = parts.length === 4 ? decode(parts[1]) : void 0;
    const ownerPart = parts.length === 4 ? parts[2] : parts[1];
    const fieldPart = parts.length === 4 ? parts[3] : parts[2];
    const ownerId = decode(ownerPart);
    const fieldKey = decode(fieldPart);
    if (!ownerId || !fieldKey || ownerId === "theme" && namespace === "theme") return void 0;
    return validateSettingsTarget({ namespace, ownerId, fieldKey, ...ownerPluginId ? { ownerPluginId } : {} });
  } catch {
    return void 0;
  }
}

// src/domains/theme/visualSemantics.ts
var VISUAL_SEMANTIC_ROLE_TOKENS = Object.freeze({
  "surface.canvas": "--surface-canvas",
  "surface.panel": "--surface-panel",
  "surface.raised": "--surface-raised",
  "content.text": "--content-text",
  "content.muted": "--content-muted",
  "stroke.default": "--stroke-default",
  accent: "--accent",
  "state.success": "--state-success",
  "state.warning": "--state-warning",
  "state.danger": "--state-danger",
  "state.focusRing": "--state-focus-ring",
  "connector.default": "--connector-default"
});
var VISUAL_SEMANTIC_TOKENS = Object.freeze({
  surface: Object.freeze({
    canvas: VISUAL_SEMANTIC_ROLE_TOKENS["surface.canvas"],
    panel: VISUAL_SEMANTIC_ROLE_TOKENS["surface.panel"],
    raised: VISUAL_SEMANTIC_ROLE_TOKENS["surface.raised"],
    overlay: "--surface-overlay",
    sunken: "--surface-sunken",
    glass: "--surface-glass"
  }),
  content: Object.freeze({
    text: VISUAL_SEMANTIC_ROLE_TOKENS["content.text"],
    muted: VISUAL_SEMANTIC_ROLE_TOKENS["content.muted"]
  }),
  state: Object.freeze({
    hover: "--state-hover-bg",
    selected: "--state-selected-bg",
    selectedStroke: "--state-selected-stroke",
    disabledOpacity: "--state-disabled-opacity",
    focusRing: VISUAL_SEMANTIC_ROLE_TOKENS["state.focusRing"],
    success: VISUAL_SEMANTIC_ROLE_TOKENS["state.success"],
    warning: VISUAL_SEMANTIC_ROLE_TOKENS["state.warning"],
    danger: VISUAL_SEMANTIC_ROLE_TOKENS["state.danger"],
    dangerSurface: "--state-danger-surface",
    warningSurface: "--state-warning-surface",
    successSurface: "--state-success-surface"
  }),
  stroke: Object.freeze({ subtle: "--stroke-subtle", default: VISUAL_SEMANTIC_ROLE_TOKENS["stroke.default"], strong: "--stroke-strong" }),
  accent: VISUAL_SEMANTIC_ROLE_TOKENS.accent,
  connector: Object.freeze({ default: VISUAL_SEMANTIC_ROLE_TOKENS["connector.default"] }),
  shadow: Object.freeze({ soft: "--shadow-soft", raised: "--shadow-raised", float: "--shadow-float" }),
  radius: Object.freeze({ none: "--ui-radius-none", xs: "--ui-radius-xs", sm: "--ui-radius-sm", md: "--ui-radius-md", lg: "--ui-radius-lg", pill: "--ui-radius-pill" }),
  motion: Object.freeze({ fast: "--motion-fast", standard: "--motion-standard", slow: "--motion-slow", easing: "--ease-standard", emphasized: "--ease-emphasized" }),
  type: Object.freeze({
    interface: Object.freeze({ font: "--type-interface-font", xs: "--type-interface-xs", sm: "--type-interface-sm", md: "--type-interface-md", lg: "--type-interface-lg", lineHeight: "--type-interface-line-height" }),
    content: Object.freeze({ font: "--type-content-font", xs: "--type-content-xs", sm: "--type-content-sm", md: "--type-content-md", lg: "--type-content-lg", lineHeight: "--type-content-line-height" }),
    code: Object.freeze({ font: "--type-code-font", xs: "--type-code-xs", sm: "--type-code-sm", md: "--type-code-md", lg: "--type-code-lg", lineHeight: "--type-code-line-height" })
  })
});

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

// src/sdk/index.ts
function definePlugin(module) {
  if (!module || typeof module.activate !== "function") {
    throw new Error("API 1.0 \u63D2\u4EF6\u5165\u53E3\u5FC5\u987B\u5BFC\u51FA activate");
  }
  for (const name of ["prepare", "suspend", "resume", "deactivate"]) {
    if (module[name] !== void 0 && typeof module[name] !== "function") {
      throw new Error(`\u63D2\u4EF6\u751F\u547D\u5468\u671F ${name} \u5FC5\u987B\u662F\u51FD\u6570`);
    }
  }
  return Object.freeze({ ...module });
}
function validatePluginManifest(value) {
  return parsePylonPluginManifest(value);
}
function createPluginLogger(pluginId) {
  const prefix = `%c[${pluginId}]`;
  const style = "color:#e2a24a;font-weight:700";
  return {
    info: (...args) => console.info(prefix, style, ...args),
    warn: (...args) => console.warn(prefix, style, ...args),
    error: (...args) => console.error(prefix, style, ...args)
  };
}
function createSettingsSurface(definition) {
  return {
    id: definition.id,
    mount(container, bridge) {
      let values = {};
      let disposed = false;
      const submit = (key, value) => {
        values = { ...values, [key]: value };
        bridge.emit("settings:set", { key, value });
        definition.onChange?.(key, value, values);
      };
      const controlFor = (field) => {
        const current = values[field.key];
        if (field.type === "toggle") {
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = current === true;
          box.addEventListener("change", () => submit(field.key, box.checked));
          return box;
        }
        if (field.type === "select") {
          const select = document.createElement("select");
          for (const option of field.options) {
            const el = document.createElement("option");
            el.value = option.value;
            el.textContent = option.label;
            select.append(el);
          }
          select.value = typeof current === "string" ? current : field.options[0]?.value ?? "";
          select.addEventListener("change", () => submit(field.key, select.value));
          return select;
        }
        if (field.type === "number") {
          const num = document.createElement("input");
          num.type = "number";
          if (typeof current === "number") num.value = String(current);
          if (field.min !== void 0) num.min = String(field.min);
          if (field.max !== void 0) num.max = String(field.max);
          if (field.step !== void 0) num.step = String(field.step);
          num.addEventListener("change", () => {
            const parsed = Number(num.value);
            if (Number.isFinite(parsed)) submit(field.key, parsed);
          });
          return num;
        }
        const text = document.createElement(field.multiline ? "textarea" : "input");
        if (text instanceof HTMLInputElement) text.type = "text";
        if (field.placeholder) text.placeholder = field.placeholder;
        text.value = typeof current === "string" ? current : "";
        text.addEventListener("input", () => {
          values = { ...values, [field.key]: text.value };
        });
        text.addEventListener("change", () => submit(field.key, text.value));
        return text;
      };
      const render = () => {
        if (disposed) return;
        container.replaceChildren();
        const root = document.createElement("div");
        root.className = "plugin-sdk-settings";
        if (definition.description) {
          const head = document.createElement("p");
          head.className = "plugin-sdk-settings__description";
          head.textContent = definition.description;
          root.append(head);
        }
        for (const field of definition.fields) {
          const label = document.createElement("label");
          label.className = "plugin-sdk-settings__field";
          const name = document.createElement("span");
          name.className = "plugin-sdk-settings__label";
          name.textContent = field.label;
          const control = controlFor(field);
          label.append(name, control);
          if (field.hint) {
            const hint = document.createElement("span");
            hint.className = "plugin-sdk-settings__hint";
            hint.textContent = field.hint;
            label.append(hint);
          }
          root.append(label);
        }
        container.append(root);
      };
      const offInput = bridge.on("host:input", (detail) => {
        const input = detail;
        if (input && input.values && typeof input.values === "object") {
          values = { ...input.values };
          render();
        }
      });
      render();
      return () => {
        disposed = true;
        offInput();
        container.replaceChildren();
      };
    }
  };
}
export {
  PLUGIN_STORAGE_BUDGET_BYTES,
  PYLON_PLUGIN_API_LATEST,
  PYLON_PLUGIN_API_MIN,
  PYLON_PLUGIN_API_SUPPORTED,
  PYLON_PLUGIN_API_VERSION,
  PYLON_PLUGIN_CAPABILITIES,
  PYLON_PLUGIN_MANIFEST_FILE,
  PluginStorageError,
  VISUAL_SEMANTIC_ROLE_TOKENS,
  VISUAL_SEMANTIC_TOKENS,
  createPluginLogger,
  createSettingsSurface,
  definePlugin,
  parseSettingsTarget,
  stringifySettingsTarget,
  validatePluginManifest,
  validateSettingsTarget
};
