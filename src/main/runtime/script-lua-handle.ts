import { LuaEventMasks, LuaFactory, LuaGlobal, LuaLibraries, LuaReturn, LuaType, LUA_REGISTRYINDEX, PointerSize, type LuaThread, type LuaWasm } from 'wasmoon';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import hostProgram from './script-handle.lua?raw';
import type { ScriptEventSource } from '../../shared/script-run';
import { CALLBACK_TIMEOUT_MS, callbackTimeoutSchema } from '../../domain/master-script';
import type { LuaOperator, LuaScalar, ScriptLuaKernel } from '../../domain/script-lua-operators';

export const SCRIPT_SLICE_MS = 3;
export class ScriptHandleFault extends Error {}
export type LuaAction = { kind: string; group: number; index: number };

let wasm: LuaWasm | undefined;
let loading: Promise<void> | undefined;
// Share the WASM runtime. luaL_newstate below creates an independent Lua heap and registry for each run.
export function loadScriptLua(): Promise<void> {
  return loading ??= new LuaFactory().getLuaModule().then(module => { wasm = module; })
    .catch(error => { loading = undefined; throw error; });
}

function slot(source: ScriptEventSource) { return source === 'on_start' ? 0 : source === 'on_run' ? 1 : 2 + Number(source.slice(1)); }

export class ScriptLuaHandle {
  private readonly lua: LuaWasm;
  private readonly root: LuaGlobal;
  private startup?: LuaThread;
  private sliced = false;
  private fault?: string;
  private rootDeadline = Infinity;
  private coroutineDeadline = Infinity;
  private readonly hook: number;
  private readonly faultFunction: number;
  private readonly inputFunction: number;
  private inputFrame?: { read: (index: number) => LuaScalar; failure?: { reason: unknown } };
  private readonly operators = new Map<LuaOperator, number>();
  private readonly expressions: number[] = [];
  private observeRef?: number;
  private truthRef?: number;

  constructor(kernel: ScriptLuaKernel, readonly callbackTimeoutMs: number = CALLBACK_TIMEOUT_MS.default, name = 'block-handle') {
    callbackTimeoutSchema.parse(callbackTimeoutMs);
    if (!wasm) throw new Error('Lua 运行环境尚未加载');
    this.lua = wasm;
    this.root = new LuaGlobal(wasm, false);
    this.hook = wasm.module.addFunction((L: number) => {
      if (L === this.startup?.address) {
        if (performance.now() >= this.coroutineDeadline && this.lua.lua_isyieldable(L)) this.lua.lua_yieldk(L, 0, 0, null);
      } else if (performance.now() >= this.rootDeadline) this.raise(L, this.timeoutMessage());
    }, 'vii');
    this.faultFunction = wasm.module.addFunction((L: number) => this.raise(L, this.lua.lua_tolstring(L, 1, null)), 'ii');
    this.inputFunction = wasm.module.addFunction((L: number) => {
      const frame = this.inputFrame!;
      try {
        this.pushScalar(L, frame.read(Number(this.lua.lua_tointegerx(L, 1, null)) - 1));
        return 1;
      } catch (reason) {
        frame.failure = { reason };
        this.lua.lua_pushstring(L, reason instanceof Error ? reason.message : '运算输入不可用');
      }
      return this.lua.lua_error(L);
    }, 'ii');
    try {
      this.root.loadLibrary(LuaLibraries.Base);
      this.root.loadLibrary(LuaLibraries.Coroutine);
      this.root.loadLibrary(LuaLibraries.Math);
      this.lua.lua_pushcclosure(this.root.address, this.faultFunction, 0);
      this.lua.lua_setglobal(this.root.address, 'handle_fault');
      this.installHook(this.root);
      this.budget(this.callbackTimeoutMs);
      this.root.loadString(hostProgram + '\n' + kernel.executable, name);
      if (kernel.source) {
        const L = this.root.address;
        this.check(this.root, wasm.lua_pcallk(L, 0, 2, 0, 0, null));
        for (const op of kernel.operators) {
          wasm.lua_getfield(L, -2, op);
          this.operators.set(op, wasm.luaL_ref(L, LUA_REGISTRYINDEX));
        }
        if (kernel.observe) {
          wasm.lua_getfield(L, -2, 'observe');
          this.observeRef = wasm.luaL_ref(L, LUA_REGISTRYINDEX);
        }
        if (kernel.truth) {
          wasm.lua_getfield(L, -2, 'truth');
          this.truthRef = wasm.luaL_ref(L, LUA_REGISTRYINDEX);
        }
        for (let i = 0; i < kernel.expressionCount; i++) {
          wasm.lua_rawgeti(L, -1, BigInt(i + 1));
          this.expressions.push(wasm.luaL_ref(L, LUA_REGISTRYINDEX));
        }
      } else this.root.runSync();
      this.root.setTop(0);
      this.budget(Infinity);
    } catch (error) { this.close(); throw error; }
  }

  private timeoutMessage() { return `主 L 看门狗超时（累计执行上限 ${this.callbackTimeoutMs} ms）`; }
  private installHook(thread: LuaThread) { this.lua.lua_sethook(thread.address, this.hook, LuaEventMasks.Count, 1000); }
  private raise(L: number, message: string) {
    this.fault = message;
    this.lua.lua_pushstring(L, message);
    return this.lua.lua_error(L);
  }
  private check(thread: LuaThread, status: number) {
    if (this.fault) throw new ScriptHandleFault(this.fault);
    if (status !== LuaReturn.Ok && status !== LuaReturn.Yield)
      throw new ScriptHandleFault(this.lua.lua_tolstring(thread.address, -1, null) || 'Lua 执行失败');
  }
  private push(L: number, args: readonly (number | string)[]) {
    for (const arg of args) {
      if (typeof arg === 'number') this.lua.lua_pushnumber(L, arg);
      else this.lua.lua_pushstring(L, arg);
    }
  }
  private result(L: number, base: number): LuaAction {
    return { kind: this.lua.lua_tolstring(L, base + 1, null), group: this.lua.lua_tonumberx(L, base + 2, null),
      index: this.lua.lua_tonumberx(L, base + 3, null) };
  }
  private callRoot(name: string, args: readonly (number | string)[], results = 0) {
    const L = this.root.address;
    const base = this.root.getTop();
    try {
      this.lua.lua_getglobal(L, name);
      this.push(L, args);
      this.check(this.root, this.lua.lua_pcallk(L, args.length, results, 0, 0, null));
      return results ? this.result(L, base) : undefined;
    } finally { this.root.setTop(base); }
  }
  private resumeStartup(args: readonly (number | string)[]): LuaAction {
    const co = this.startup!;
    this.coroutineDeadline = performance.now() + SCRIPT_SLICE_MS;
    // A yield from the instruction hook returns zero values and resumes with zero arguments.
    const inputs = this.sliced ? [] : args;
    this.push(co.address, inputs);
    const { result, resultCount } = co.resume(inputs.length);
    this.check(co, result);
    this.sliced = result === LuaReturn.Yield && !resultCount;
    if (this.sliced) return { kind: 'slice', group: 0, index: 0 };
    const action = this.result(co.address, co.getTop() - resultCount);
    co.pop(resultCount);
    return action;
  }

  open(source: ScriptEventSource, group: number) {
    if (source === 'on_start') this.budget(this.callbackTimeoutMs);
    this.callRoot('open_flow', [slot(source), group]);
    if (source === 'on_start') {
      this.startup = this.root.newThread(); // its value stays rooted on the main stack until the handle closes
      this.installHook(this.startup);
      this.lua.lua_getglobal(this.startup.address, 'startup_flow');
    }
  }
  budget(remainingMs: number) { this.rootDeadline = performance.now() + remainingMs; }
  evaluate(op: LuaOperator, a: LuaScalar, b: LuaScalar): LuaScalar {
    return this.callScalar(this.operators.get(op)!, [a, b]);
  }
  evaluateExpression(index: number, read: (index: number) => LuaScalar): LuaScalar {
    return this.callScalar(this.expressions[index]!, [], read);
  }
  observe(read: () => LuaScalar): string {
    return String(this.callScalar(this.observeRef!, [], read, true));
  }
  truth(value: LuaScalar): boolean {
    return typeof value === 'boolean' ? value : this.callScalar(this.truthRef!, [value]) === true;
  }
  private pushScalar(L: number, value: LuaScalar) {
    switch (typeof value) {
      case 'bigint': this.lua.lua_pushinteger(L, value); break;
      case 'number': this.lua.lua_pushnumber(L, value); break;
      case 'boolean': this.lua.lua_pushboolean(L, value ? 1 : 0); break;
      case 'string': this.lua.lua_pushlstring(L, value, Buffer.byteLength(value)); break;
    }
  }
  private callScalar(reference: number, inputs: LuaScalar[], read?: (index: number) => LuaScalar, observing = false): LuaScalar {
    const L = this.root.address, base = this.root.getTop();
    const previousFrame = this.inputFrame;
    try {
      if (!this.lua.lua_checkstack(L, inputs.length + 3)) throw new ScriptHandleFault('Lua 调用栈空间不足');
      this.lua.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(reference));
      if (read) {
        this.inputFrame = { read };
        this.lua.lua_pushcclosure(L, this.inputFunction, 0);
      } else {
        for (const value of inputs) this.pushScalar(L, value);
      }
      const status = this.lua.lua_pcallk(L, read ? 1 : inputs.length, 1, 0, 0, null);
      if (this.fault) throw new ScriptHandleFault(this.fault);
      if (read && !observing && this.inputFrame?.failure) throw this.inputFrame.failure.reason;
      if (status !== LuaReturn.Ok) throw new Error(this.lua.lua_tolstring(L, -1, null));
      if (this.lua.lua_type(L, -1) === LuaType.String) {
        const memory = this.lua.module;
        const size = memory._malloc(PointerSize);
        try {
          const ptr = memory.ccall('lua_tolstring', 'number', ['number', 'number', 'number'], [L, -1, size]) as number;
          return Buffer.from(memory.HEAPU8.buffer, ptr, memory.getValue(size, 'i32')).toString('utf8');
        } finally { memory._free(size); }
      }
      if (this.lua.lua_type(L, -1) === LuaType.Boolean) return !!this.lua.lua_toboolean(L, -1);
      return this.lua.lua_isinteger(L, -1) ? this.lua.lua_tointegerx(L, -1, null) : this.lua.lua_tonumberx(L, -1, null);
    } finally { this.inputFrame = previousFrame; this.root.setTop(base); }
  }
  watchdog(): never {
    this.callRoot('handle_fault', [this.timeoutMessage()]);
    throw new ScriptHandleFault(this.timeoutMessage());
  }
  advance(source: ScriptEventSource, reply: string, choice?: number): LuaAction {
    const args = choice === undefined ? [reply] : [reply, choice];
    if (source === 'on_start') return this.resumeStartup(args);
    return this.callRoot('advance_flow', [slot(source), ...args], 3)!;
  }
  sleep(source: ScriptEventSource, ms: number, signal: AbortSignal) {
    if (source !== 'on_start') this.callRoot('sleep_ms', [ms]);
    return this.sleepStartup(ms, signal);
  }
  private async sleepStartup(ms: number, signal: AbortSignal) {
    signal.throwIfAborted();
    let result = this.resumeStartup(['sleep', ms]);
    while (result.kind === 'slice') {
      await immediate(undefined, { signal });
      result = this.resumeStartup([]);
    }
    if (result.kind !== 'sleep' || result.group !== ms) throw new ScriptHandleFault('无效的 Lua 休眠请求');
    await delay(ms, undefined, { signal });
  }
  drop(source: ScriptEventSource) {
    if (!this.fault) {
      // Cleanup may follow a long debugger pause or an asynchronous cancellation.
      this.budget(this.callbackTimeoutMs);
      this.callRoot('close_flow', [slot(source)]);
    }
  }
  close() {
    this.root.close();
    this.lua.module.removeFunction(this.hook);
    this.lua.module.removeFunction(this.faultFunction);
    this.lua.module.removeFunction(this.inputFunction);
  }
}
