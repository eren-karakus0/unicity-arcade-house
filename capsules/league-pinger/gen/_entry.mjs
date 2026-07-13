var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/@unicity-astrid/sdk/dist/errors.js
var SysError = class _SysError extends Error {
  name = "SysError";
  /** Legacy classification: where the error originated. */
  kind;
  /** Typed WIT variant tag (e.g. "quota", "capability-denied", "timeout").
   *  `undefined` for SDK-internal errors that didn't come from the host. */
  code;
  /** Raw unpacked WIT variant payload, when present. */
  payload;
  constructor(kind, message, options) {
    super(`[${kind}${options?.code ? `:${options.code}` : ""}] ${message}`, options);
    this.kind = kind;
    this.code = options?.code;
    this.payload = options?.payload;
  }
  static host(message, cause, code, payload) {
    const opts = {};
    if (cause !== void 0)
      opts.cause = cause;
    if (code !== void 0)
      opts.code = code;
    if (payload !== void 0)
      opts.payload = payload;
    return new _SysError("HostError", message, opts);
  }
  static json(message, cause) {
    return new _SysError("JsonError", message, cause === void 0 ? void 0 : { cause });
  }
  static api(message, cause) {
    return new _SysError("ApiError", message, cause === void 0 ? void 0 : { cause });
  }
};
function callHost(label, fn) {
  try {
    return fn();
  } catch (raw) {
    if (raw instanceof SysError)
      throw raw;
    const wit = extractWitError(raw);
    if (wit !== void 0) {
      throw SysError.host(`${label}: ${wit.message}`, raw, wit.code, wit.payload);
    }
    const message = typeof raw === "string" ? raw : raw?.message ?? String(raw);
    throw SysError.host(`${label}: ${message}`, raw);
  }
}
function extractWitError(raw) {
  if (raw === null || typeof raw !== "object")
    return void 0;
  const r = raw;
  if (typeof r["tag"] !== "string")
    return void 0;
  const code = r["tag"];
  const val = r["val"];
  let message;
  if (typeof val === "string") {
    message = `${code}: ${val}`;
  } else if (val === void 0) {
    message = code;
  } else {
    message = `${code}: ${safeStringify(val)}`;
  }
  return { code, message, payload: val };
}
function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// node_modules/@unicity-astrid/sdk/dist/runtime/registry.js
var registration;
function newRegistration(ctor, description) {
  return {
    ctor,
    tools: /* @__PURE__ */ new Map(),
    interceptors: /* @__PURE__ */ new Map(),
    commands: /* @__PURE__ */ new Map(),
    installMethod: void 0,
    upgradeMethod: void 0,
    runMethod: void 0,
    description
  };
}
function registerCapsule(ctor, description) {
  if (registration !== void 0 && registration.ctor !== ctor) {
    throw new Error(`Only one @capsule class may be registered per WASM module. Already have ${registration.ctor.name}; refusing to register ${ctor.name}.`);
  }
  if (registration === void 0) {
    registration = newRegistration(ctor, description);
  } else if (description !== void 0 && registration.description === void 0) {
    registration.description = description;
  }
}
var pendingByCtor = /* @__PURE__ */ new WeakMap();
function ensureRegistration(ctor) {
  if (registration !== void 0 && registration.ctor === ctor) {
    return registration;
  }
  let pending = pendingByCtor.get(ctor);
  if (pending === void 0) {
    pending = newRegistration(ctor, void 0);
    pendingByCtor.set(ctor, pending);
  }
  return pending;
}
function adoptPending(ctor) {
  if (registration === void 0 || registration.ctor !== ctor)
    return;
  const pending = pendingByCtor.get(ctor);
  if (pending === void 0)
    return;
  for (const [name, entry] of pending.tools)
    registration.tools.set(name, entry);
  for (const [topic, entry] of pending.interceptors)
    registration.interceptors.set(topic, entry);
  for (const [name, entry] of pending.commands)
    registration.commands.set(name, entry);
  if (pending.installMethod !== void 0 && registration.installMethod === void 0) {
    registration.installMethod = pending.installMethod;
  }
  if (pending.upgradeMethod !== void 0 && registration.upgradeMethod === void 0) {
    registration.upgradeMethod = pending.upgradeMethod;
  }
  if (pending.runMethod !== void 0 && registration.runMethod === void 0) {
    registration.runMethod = pending.runMethod;
  }
  if (pending.description !== void 0 && registration.description === void 0) {
    registration.description = pending.description;
  }
  pendingByCtor.delete(ctor);
}
function recordInstall(ctor, methodName) {
  const target = ensureRegistration(ctor);
  if (target.installMethod !== void 0) {
    return;
  }
  target.installMethod = methodName;
}
function recordUpgrade(ctor, methodName) {
  const target = ensureRegistration(ctor);
  if (target.upgradeMethod !== void 0) {
    return;
  }
  target.upgradeMethod = methodName;
}
function recordRun(ctor, methodName) {
  const target = ensureRegistration(ctor);
  if (target.runMethod !== void 0) {
    return;
  }
  target.runMethod = methodName;
}
function getRegistration() {
  return registration;
}

// node_modules/@unicity-astrid/sdk/dist/capsule.js
function capsule(target, _context) {
  registerCapsule(target);
  adoptPending(target);
  return target;
}
function install(_value, context) {
  if (context.private || context.static) {
    throw new Error("@install must be applied to a public instance method.");
  }
  context.addInitializer(function() {
    const ctor = this.constructor;
    recordInstall(ctor, String(context.name));
  });
}
function upgrade(_value, context) {
  if (context.private || context.static) {
    throw new Error("@upgrade must be applied to a public instance method.");
  }
  context.addInitializer(function() {
    const ctor = this.constructor;
    recordUpgrade(ctor, String(context.name));
  });
}
function run(_value, context) {
  if (context.private || context.static) {
    throw new Error("@run must be applied to a public instance method.");
  }
  context.addInitializer(function() {
    const ctor = this.constructor;
    recordRun(ctor, String(context.name));
  });
}

// node_modules/@unicity-astrid/sdk/dist/log.js
var log_exports = {};
__export(log_exports, {
  debug: () => debug,
  error: () => error,
  info: () => info,
  trace: () => trace,
  warn: () => warn
});
import { log as hostLog } from "astrid:sys/host@1.0.0";
function trace(message) {
  hostLog("trace", format(message));
}
function debug(message) {
  hostLog("debug", format(message));
}
function info(message) {
  hostLog("info", format(message));
}
function warn(message) {
  hostLog("warn", format(message));
}
function error(message) {
  hostLog("error", format(message));
}
function format(value) {
  if (typeof value === "string")
    return value;
  if (value instanceof Error)
    return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// node_modules/@unicity-astrid/sdk/dist/kv.js
import { kvGet as hostGet, kvSet as hostSet, kvDelete as hostDelete, kvListKeys as hostListKeys, kvListKeysPage as hostListKeysPage, kvClearPrefix as hostClearPrefix, kvCas as hostCas } from "astrid:kv/host@1.0.0";
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function getBytes(key) {
  return callHost(`kv.getBytes(${quote(key)})`, () => hostGet(key));
}
function setBytes(key, value) {
  callHost(`kv.setBytes(${quote(key)})`, () => hostSet(key, value));
}
function get(key) {
  const bytes = getBytes(key);
  if (bytes === void 0 || bytes.length === 0)
    return void 0;
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (err) {
    throw SysError.json(`kv.get(${quote(key)}): ${err.message}`, err);
  }
}
function set(key, value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw SysError.json(`kv.set(${quote(key)}): ${err.message}`, err);
  }
  setBytes(key, encoder.encode(json));
}
function quote(s) {
  return `"${s.replace(/"/g, '\\"')}"`;
}

// node_modules/@unicity-astrid/sdk/dist/ipc.js
var ipc_exports = {};
__export(ipc_exports, {
  Subscription: () => Subscription,
  publish: () => publish,
  publishAs: () => publishAs,
  publishJson: () => publishJson,
  publishJsonAs: () => publishJsonAs,
  requestResponse: () => requestResponse,
  runtimeInterceptors: () => runtimeInterceptors,
  subscribe: () => subscribe
});
import { publish as hostPublish, publishAs as hostPublishAs, subscribe as hostSubscribe, getInterceptorBindings as hostGetInterceptorBindings } from "astrid:ipc/host@1.0.0";
import { randomBytes as hostRandomBytes } from "astrid:sys/host@1.0.0";
var DEFAULT_RECV_TIMEOUT_MS = 5000n;
function publish(topic, payload) {
  callHost(`ipc.publish(${quote2(topic)})`, () => hostPublish(topic, payload));
}
function publishJson(topic, payload) {
  publish(topic, jsonify(`ipc.publishJson(${quote2(topic)})`, payload));
}
function publishAs(topic, payload, principal) {
  callHost(`ipc.publishAs(${quote2(topic)})`, () => hostPublishAs(topic, payload, principal));
}
function publishJsonAs(topic, payload, principal) {
  publishAs(topic, jsonify(`ipc.publishJsonAs(${quote2(topic)})`, payload), principal);
}
function subscribe(topicPattern) {
  const inner = callHost(`ipc.subscribe(${quote2(topicPattern)})`, () => hostSubscribe(topicPattern));
  return new Subscription(inner, topicPattern);
}
function runtimeInterceptors() {
  const handles = callHost("ipc.runtimeInterceptors", () => hostGetInterceptorBindings());
  return handles.map((h) => ({ handle: h.handleId, action: h.action, topic: h.topic }));
}
var Subscription = class {
  topic;
  #inner;
  constructor(inner, topic) {
    this.#inner = inner;
    this.topic = topic;
  }
  /** Non-blocking poll. Returns whatever's already queued. */
  poll() {
    const env = callHost(`ipc.poll(${quote2(this.topic)})`, () => this.#requireInner().poll());
    return envelopeToPollResult(env);
  }
  /** Blocking receive (timeout capped at 60s by the host). */
  recv(timeoutMs = DEFAULT_RECV_TIMEOUT_MS) {
    const env = callHost(`ipc.recv(${quote2(this.topic)})`, () => this.#requireInner().recv(timeoutMs));
    return envelopeToPollResult(env);
  }
  /**
   * Idempotent — closing an already-closed subscription is a no-op.
   * Equivalent to the resource Drop. Prefer `using` when the surrounding
   * code can adopt explicit resource management.
   */
  close() {
    if (this.#inner === void 0)
      return;
    const inner = this.#inner;
    this.#inner = void 0;
    try {
      inner[Symbol.dispose]();
    } catch {
    }
  }
  [Symbol.dispose]() {
    this.close();
  }
  /**
   * AsyncIterable convenience. Loops calling `.recv()` and yielding each
   * message. Stops when the subscription is closed. Drops `lagged`/`dropped`
   * info — use `.poll()`/`.recv()` explicitly if you need to react to lag.
   */
  async *[Symbol.asyncIterator]() {
    while (this.#inner !== void 0) {
      const batch = this.recv();
      for (const msg of batch.messages) {
        yield msg;
      }
    }
  }
  #requireInner() {
    if (this.#inner === void 0) {
      throw SysError.api(`subscription on ${quote2(this.topic)} is closed`);
    }
    return this.#inner;
  }
};
function requestResponse(requestTopic, responseNamespace, request, timeoutMs) {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw SysError.api("request_response: request payload must serialize to a JSON object so the correlation_id can be injected");
  }
  const correlationId = randomUuidV4();
  const augmented = {
    ...request,
    correlation_id: correlationId
  };
  const payload = jsonify("requestResponse", augmented);
  const replyTopic = `${responseNamespace}.${correlationId}`;
  const sub = subscribe(replyTopic);
  try {
    publish(requestTopic, payload);
    const timeoutBig = typeof timeoutMs === "bigint" ? timeoutMs : BigInt(Math.max(0, Math.floor(timeoutMs)));
    const poll = sub.recv(timeoutBig);
    const msg = poll.messages[0];
    if (msg === void 0) {
      throw SysError.api(`request_response: no reply on '${replyTopic}' within ${String(timeoutMs)}ms`);
    }
    try {
      return JSON.parse(msg.payload);
    } catch (err) {
      throw SysError.json(`request_response: failed to parse reply on '${replyTopic}': ${err.message}`, err);
    }
  } finally {
    sub.close();
  }
}
function envelopeToPollResult(env) {
  return {
    messages: env.messages.map(makeIpcMessage),
    dropped: env.dropped,
    lagged: env.lagged
  };
}
function makeIpcMessage(m) {
  return {
    topic: m.topic,
    payload: m.payload,
    sourceId: m.sourceId,
    principal: m.principal,
    json() {
      try {
        return JSON.parse(m.payload);
      } catch (err) {
        throw SysError.json(`IpcMessage.json() on topic ${quote2(m.topic)}: ${err.message}`, err);
      }
    }
  };
}
function jsonify(label, value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw SysError.json(`${label}: ${err.message}`, err);
  }
}
function quote2(s) {
  return `"${s.replace(/"/g, '\\"')}"`;
}
function randomUuidV4() {
  const bytes = getRandomBytes();
  bytes[6] = (bytes[6] ?? 0) & 15 | 64;
  bytes[8] = (bytes[8] ?? 0) & 63 | 128;
  const hex = [];
  for (let i = 0; i < 16; i++) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
  }
  return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" + hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" + hex.slice(10, 16).join("");
}
function getRandomBytes() {
  return hostRandomBytes(16n);
}

// node_modules/@unicity-astrid/sdk/dist/fs.js
import { fsOpen as hostOpen, fsExists as hostExists, fsMkdir as hostMkdir, fsMkdirAll as hostMkdirAll, fsReaddir as hostReaddir, fsStat as hostStat, fsStatSymlink as hostStatSymlink, fsUnlink as hostUnlink, readFile as hostReadFile, writeFile as hostWriteFile, fsAppend as hostAppend, fsCopy as hostCopy, fsRename as hostRename, fsRemoveDirAll as hostRemoveDirAll, fsCanonicalize as hostCanonicalize, fsReadLink as hostReadLink, fsHardLink as hostHardLink } from "astrid:fs/host@1.0.0";
var decoder2 = new TextDecoder();
var encoder2 = new TextEncoder();

// node_modules/@unicity-astrid/sdk/dist/http.js
import { httpRequest as hostRequest, httpStreamStart as hostStreamStart } from "astrid:http/host@1.0.0";

// node_modules/@unicity-astrid/sdk/dist/net.js
import { bindUnix as hostBindUnix, bindTcp as hostBindTcp, connectTcp as hostConnectTcp, udpBind as hostUdpBind, lookupHost as hostLookupHost } from "astrid:net/host@1.0.0";

// node_modules/@unicity-astrid/sdk/dist/time.js
var time_exports = {};
__export(time_exports, {
  monotonicNs: () => monotonicNs,
  now: () => now,
  nowMs: () => nowMs,
  sleepMs: () => sleepMs,
  sleepNs: () => sleepNs
});
import { clockMs, clockMonotonicNs, sleepNs as hostSleepNs } from "astrid:sys/host@1.0.0";
function now() {
  const ms = callHost("time.now", () => clockMs());
  return new Date(Number(ms));
}
function nowMs() {
  return callHost("time.nowMs", () => clockMs());
}
function monotonicNs() {
  return callHost("time.monotonicNs", () => clockMonotonicNs());
}
function sleepMs(ms) {
  const ns = BigInt(Math.max(0, Math.floor(ms))) * 1000000n;
  callHost(`time.sleepMs(${ms})`, () => hostSleepNs(ns));
}
function sleepNs(ns) {
  callHost(`time.sleepNs(${ns})`, () => hostSleepNs(ns));
}

// node_modules/@unicity-astrid/sdk/dist/env.js
import { getConfig } from "astrid:sys/host@1.0.0";
var CONFIG_SOCKET_PATH = "ASTRID_SOCKET_PATH";
function get2(key) {
  return tryGet(key) ?? "";
}
function tryGet(key) {
  return callHost(`env.get(${JSON.stringify(key)})`, () => getConfig(key));
}

// node_modules/@unicity-astrid/sdk/dist/runtime.js
var runtime_exports = {};
__export(runtime_exports, {
  caller: () => caller,
  randomBytes: () => randomBytes,
  signalReady: () => signalReady,
  socketPath: () => socketPath
});
import { getCaller as hostGetCaller, signalReady as hostSignalReady, randomBytes as hostRandomBytes2 } from "astrid:sys/host@1.0.0";
function signalReady() {
  callHost("runtime.signalReady", () => hostSignalReady());
}
function caller() {
  const ctx = callHost("runtime.caller", () => hostGetCaller());
  return {
    sourceId: ctx.sourceId,
    principal: ctx.principal,
    timestamp: ctx.timestamp
  };
}
function randomBytes(length) {
  return callHost(`runtime.randomBytes(${length})`, () => hostRandomBytes2(BigInt(length)));
}
function socketPath() {
  const path = get2(CONFIG_SOCKET_PATH);
  if (path === "") {
    throw SysError.api("ASTRID_SOCKET_PATH config key is empty");
  }
  if (path.indexOf("\0") >= 0) {
    throw SysError.api("ASTRID_SOCKET_PATH contains null byte");
  }
  return path;
}

// node_modules/@unicity-astrid/sdk/dist/capabilities.js
import { checkCapsuleCapability } from "astrid:sys/host@1.0.0";

// node_modules/@unicity-astrid/sdk/dist/elicit.js
import { elicit as hostElicit, hasSecret as hostHasSecret } from "astrid:elicit/host@1.0.0";

// node_modules/@unicity-astrid/sdk/dist/identity.js
import { identityResolve as hostResolve, identityLink as hostLink, identityUnlink as hostUnlink2, identityCreateUser as hostCreateUser, identityListLinks as hostListLinks } from "astrid:identity/host@1.0.0";

// node_modules/@unicity-astrid/sdk/dist/approval.js
import { requestApproval as hostRequestApproval } from "astrid:approval/host@1.0.0";

// node_modules/@unicity-astrid/sdk/dist/uplink.js
import { uplinkRegister, uplinkSend } from "astrid:uplink/host@1.0.0";

// dist/index.js
var __runInitializers = function(thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) {
    value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  }
  return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) {
    if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
    return f;
  }
  var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
  var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn.access[p];
    context.addInitializer = function(f) {
      if (done) throw new TypeError("Cannot add initializers after decoration has completed");
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
    if (kind === "accessor") {
      if (result === void 0) continue;
      if (result === null || typeof result !== "object") throw new TypeError("Object expected");
      if (_ = accept(result.get)) descriptor.get = _;
      if (_ = accept(result.set)) descriptor.set = _;
      if (_ = accept(result.init)) initializers.unshift(_);
    } else if (_ = accept(result)) {
      if (kind === "field") initializers.unshift(_);
      else descriptor[key] = _;
    }
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
};
function ping(context) {
  try {
    ipc_exports.publishJson("arcade.v1.league.ping", {
      from: "league-pinger",
      context,
      at: Number(time_exports.nowMs())
    });
    log_exports.info(`[pinger] published arcade.v1.league.ping (${context})`);
  } catch (e) {
    const err = e;
    let detail = "";
    try {
      detail = err.payload !== void 0 ? ` payload=${JSON.stringify(err.payload)}` : "";
    } catch {
    }
    log_exports.warn(`[pinger] publish failed (${context}): ${err.message ?? String(e)}${detail}`);
  }
}
var LeaguePinger = (() => {
  let _classDecorators = [capsule];
  let _classDescriptor;
  let _classExtraInitializers = [];
  let _classThis;
  let _instanceExtraInitializers = [];
  let _onInstall_decorators;
  let _onUpgrade_decorators;
  let _daemon_decorators;
  var LeaguePinger2 = class {
    static {
      _classThis = this;
    }
    static {
      const _metadata = typeof Symbol === "function" && Symbol.metadata ? /* @__PURE__ */ Object.create(null) : void 0;
      _onInstall_decorators = [install];
      _onUpgrade_decorators = [upgrade];
      _daemon_decorators = [run];
      __esDecorate(this, null, _onInstall_decorators, { kind: "method", name: "onInstall", static: false, private: false, access: { has: (obj) => "onInstall" in obj, get: (obj) => obj.onInstall }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _onUpgrade_decorators, { kind: "method", name: "onUpgrade", static: false, private: false, access: { has: (obj) => "onUpgrade" in obj, get: (obj) => obj.onUpgrade }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _daemon_decorators, { kind: "method", name: "daemon", static: false, private: false, access: { has: (obj) => "daemon" in obj, get: (obj) => obj.daemon }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
      LeaguePinger2 = _classThis = _classDescriptor.value;
      if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
      __runInitializers(_classThis, _classExtraInitializers);
    }
    onInstall() {
      log_exports.info("league-pinger installed");
      ping("install");
    }
    onUpgrade() {
      ping("upgrade");
    }
    daemon() {
      runtime_exports.signalReady();
      ping("daemon");
      for (; ; )
        time_exports.sleepMs(1e3);
    }
    constructor() {
      __runInitializers(this, _instanceExtraInitializers);
    }
  };
  return LeaguePinger2 = _classThis;
})();

// node_modules/@unicity-astrid/sdk/dist/runtime/bridge.js
import { getConfig as getConfig2 } from "astrid:sys/host@1.0.0";
var STATE_KEY = "__state";
var decoder3 = new TextDecoder();
function denied(reason) {
  return { action: "deny", data: reason };
}
function cont(data) {
  return { action: "continue", data };
}
function createBridge() {
  let toolDescribeCache;
  let warmed = false;
  function reg() {
    const r = getRegistration();
    if (r !== void 0 && !warmed) {
      warmed = true;
      try {
        new r.ctor();
      } catch {
      }
    }
    if (r === void 0) {
      throw new Error("No @capsule class registered. The build pipeline emits the entry module after the user's source so decorators have already fired \u2014 this means the user code never imported the SDK or never declared a @capsule class.");
    }
    return r;
  }
  function buildToolDescribe() {
    const r = reg();
    const tools = Array.from(r.tools.values()).map(toolToDescribeEntry);
    return JSON.stringify({
      tools,
      description: r.description ?? ""
    });
  }
  function loadInstance(r) {
    const instance = new r.ctor();
    const persisted = get(STATE_KEY);
    if (persisted !== void 0 && typeof persisted === "object" && persisted !== null) {
      Object.assign(instance, persisted);
    }
    return instance;
  }
  function persistInstance(instance) {
    const snapshot = {};
    for (const [key, value] of Object.entries(instance)) {
      snapshot[key] = value;
    }
    set(STATE_KEY, snapshot);
  }
  function getInstance(entry) {
    const r = reg();
    if (entry.mutable) {
      return { instance: loadInstance(r), persist: true };
    }
    return { instance: new r.ctor(), persist: false };
  }
  function executeTool(entry, payload) {
    let req;
    try {
      req = JSON.parse(decoder3.decode(payload));
    } catch (e) {
      return denied(`failed to parse tool execute payload: ${e.message}`);
    }
    const callId = req.call_id ?? "";
    let instance;
    let persist;
    try {
      ({ instance, persist } = getInstance(entry));
    } catch (e) {
      publishToolError(entry.name, callId, `failed to load state: ${e.message}`);
      return cont();
    }
    let resultPayload;
    try {
      const raw = invoke(instance, entry.methodName, req.arguments);
      resultPayload = { content: stringifyResult(raw), isError: false };
    } catch (e) {
      resultPayload = { content: e.message ?? String(e), isError: true };
    }
    if (persist && !resultPayload.isError) {
      try {
        persistInstance(instance);
      } catch (e) {
        publishToolError(entry.name, callId, `failed to save state: ${e.message}`);
        return cont();
      }
    }
    publishToolResult(entry.name, callId, resultPayload.content, resultPayload.isError);
    return cont();
  }
  function executeHookHandler(entry, payload) {
    let parsed = void 0;
    if (payload.length > 0) {
      try {
        parsed = JSON.parse(decoder3.decode(payload));
      } catch (e) {
        return denied(`failed to parse payload: ${e.message}`);
      }
    }
    let instance;
    let persist;
    try {
      ({ instance, persist } = getInstance(entry));
    } catch (e) {
      return denied(`failed to load state: ${e.message}`);
    }
    let resultJson;
    try {
      const raw = invoke(instance, entry.methodName, parsed);
      resultJson = stringifyResult(raw);
    } catch (e) {
      return denied(e.message ?? String(e));
    }
    if (persist) {
      try {
        persistInstance(instance);
      } catch (e) {
        return denied(`failed to save state: ${e.message}`);
      }
    }
    if (resultJson === "null")
      return cont();
    return cont(resultJson);
  }
  return {
    astridHookTrigger(action, payload) {
      try {
        if (action === "tool_describe") {
          toolDescribeCache ??= buildToolDescribe();
          return cont(toolDescribeCache);
        }
        if (action.startsWith("tool_execute_")) {
          const name = action.slice("tool_execute_".length);
          const r2 = reg();
          const entry = r2.tools.get(name);
          if (entry === void 0)
            return denied(`unknown tool: ${name}`);
          return executeTool(entry, payload);
        }
        const r = reg();
        const interceptor2 = r.interceptors.get(action);
        if (interceptor2 !== void 0) {
          return executeHookHandler(interceptor2, payload);
        }
        const command2 = r.commands.get(action);
        if (command2 !== void 0) {
          return executeHookHandler(command2, payload);
        }
        return denied(`unknown hook action: ${action}`);
      } catch (e) {
        return denied(`bridge panic in astridHookTrigger: ${e.message ?? String(e)}`);
      }
    },
    run() {
      try {
        const r = reg();
        if (r.runMethod === void 0) {
          return;
        }
        const instance = loadInstance(r);
        const raw = invoke(instance, r.runMethod, void 0);
        if (raw instanceof Promise) {
          syncWait(raw);
        }
      } catch (e) {
        error(`run loop exited with error: ${e.message ?? String(e)}`);
      }
    },
    astridInstall() {
      try {
        const r = reg();
        if (r.installMethod === void 0)
          return;
        const instance = new r.ctor();
        invoke(instance, r.installMethod, void 0);
        persistInstance(instance);
      } catch (e) {
        error(`install hook failed: ${e.message ?? String(e)}`);
      }
    },
    astridUpgrade() {
      try {
        const r = reg();
        if (r.upgradeMethod === void 0)
          return;
        const prevVersion = safeGetConfig("prev_version");
        const instance = loadInstance(r);
        invoke(instance, r.upgradeMethod, prevVersion);
        persistInstance(instance);
      } catch (e) {
        error(`upgrade hook failed: ${e.message ?? String(e)}`);
      }
    }
  };
}
function invoke(instance, methodName, arg) {
  const method = instance[methodName];
  if (typeof method !== "function") {
    throw new Error(`method ${methodName} not found on capsule instance`);
  }
  const raw = arg === void 0 ? method.call(instance) : method.call(instance, arg);
  return raw instanceof Promise ? syncWait(raw) : raw;
}
function toolToDescribeEntry(entry) {
  const schema = entry.inputSchema ?? { type: "object", properties: {} };
  const inputSchema = { ...schema, mutable: entry.mutable };
  return {
    name: entry.name,
    description: entry.description ?? "",
    input_schema: inputSchema
  };
}
function publishToolResult(name, callId, content, isError) {
  const topic = `tool.v1.execute.${name}.result`;
  publishJson(topic, {
    type: "tool_execute_result",
    call_id: callId,
    result: { call_id: callId, content, is_error: isError }
  });
}
function publishToolError(name, callId, message) {
  publishToolResult(name, callId, message, true);
}
function stringifyResult(value) {
  if (typeof value === "string")
    return value;
  if (value === void 0)
    return "null";
  try {
    return JSON.stringify(value);
  } catch (e) {
    throw new Error(`failed to serialize tool result: ${e.message}`);
  }
}
function safeGetConfig(key) {
  try {
    return getConfig2(key) ?? "";
  } catch {
    return "";
  }
}
function syncWait(promise) {
  let settled = false;
  let value;
  let error2;
  promise.then((v) => {
    settled = true;
    value = v;
  }, (e) => {
    settled = true;
    error2 = e;
  });
  if (!settled) {
    throw new Error("Handler returned a Promise that did not settle synchronously. ComponentizeJS syncifies awaits backed by host imports it knows how to drive \u2014 pure setTimeout/setInterval will hang. Use only Astrid SDK calls inside handlers, or make the handler sync.");
  }
  if (error2 !== void 0)
    throw error2;
  return value;
}

// gen/_entry.src.mjs
var bridge = createBridge();
function astridHookTrigger(action, payload) {
  return bridge.astridHookTrigger(action, payload);
}
function run2() {
  bridge.run();
}
function astridInstall() {
  bridge.astridInstall();
}
function astridUpgrade() {
  bridge.astridUpgrade();
}
export {
  astridHookTrigger,
  astridInstall,
  astridUpgrade,
  run2 as run
};
