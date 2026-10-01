// B17 预设门禁回归测试（dsh-harness-flow）
// 跑法：node test/preset-gate.test.mjs   （零依赖，纯 node 内建断言）
//
// 立法依据：用户 2026-09-25 B16 拍板「不启动驾驭工程预设时不注入任何驾驭工程内容」。
// 该拍板当时只落在提示词注入一路，工具一路漏了——本测试锁死工具一路。
import assert from "node:assert/strict";
import { composedPresetOf, makeToolGuards } from "../lib/index.js";

const STUB_STORE = { peek: () => null, load: async () => null, save: async () => {} };
const ctxWithPreset = (pid) => ({
  get: (n) => (n === "agentPresets" ? { composedPreset: () => pid } : undefined)
});
const execOf = (toolName) => ({ name: toolName, agent: { session: { id: "sess-test" } } });
const gateOf = (ctx) => {
  const g = makeToolGuards(STUB_STORE, ctx).find((x) => String(x.name).includes("预设门禁"));
  assert.ok(g, "「预设门禁」guard 必须存在于 makeToolGuards 返回值中");
  assert.equal(typeof g.guard, "function");
  return g.guard;
};

let n = 0;
const t = (label, fn) => { fn(); n++; console.log("  PASS [" + n + "] " + label); };

console.log("B17 预设门禁回归：");

// ① 事故本体：standard 会话调用 harness_flow → 必须拒绝
t("standard 会话调用 harness_flow → 拒绝（字符串理由）", () => {
  const r = gateOf(ctxWithPreset("standard"))(execOf("harness_flow"));
  assert.equal(typeof r, "string", "应返回拒绝字符串（非 undefined）");
  assert.ok(r.includes("不适用"), "拒绝理由应含「不适用」");
  assert.ok(r.includes("standard"), "拒绝理由应回显实际 preset，便于诊断");
  assert.ok(r.includes("忽略"), "拒绝理由应指示模型忽略描述里的流程要求");
});

// ② 正主不受影响：harness 会话调用 harness_flow → 放行
t("harness 会话调用 harness_flow → 放行（undefined）", () => {
  assert.equal(gateOf(ctxWithPreset("harness"))(execOf("harness_flow")), undefined);
});

// ③ 不误伤：其他工具名一律放行（含最像的子代理工具）
t("非 harness_flow 工具 → 一律放行", () => {
  const g = gateOf(ctxWithPreset("standard"));
  for (const nm of ["pwsh", "subagent", "subagent_fork", "ask_user_question", "todo_write", ""]) {
    assert.equal(g(execOf(nm)), undefined, "不应拦 " + JSON.stringify(nm));
  }
});

// ④ 边界：agentPresets 服务不可达 → fail-open（与既有 guard 同口径，合成测试环境）
t("agentPresets 不可达 → fail-open 放行", () => {
  assert.equal(gateOf({ get: () => undefined })(execOf("harness_flow")), undefined);
  assert.equal(gateOf({})(execOf("harness_flow")), undefined);
});

// ⑤ composedPresetOf 边界：空串/异常/无服务 → undefined
t("composedPresetOf 边界（空串 / 抛异常 / 无服务 → undefined）", () => {
  assert.equal(composedPresetOf({}, { get: () => undefined }), undefined);
  assert.equal(composedPresetOf({}, ctxWithPreset("")), undefined);
  assert.equal(composedPresetOf({}, { get: () => ({ composedPreset: () => { throw new Error("boom"); } }) }), undefined);
  assert.equal(composedPresetOf({}, ctxWithPreset("standard")), "standard");
  assert.equal(composedPresetOf({}, ctxWithPreset("harness")), "harness");
});

// ⑥ 子代理随父组合：exec.agent.ctx 形态也要能解析（composedPreset 读的是 scope chain）
t("agent.ctx 形态可解析（子代理随父组合路径）", () => {
  const ctx = { get: (n) => (n === "agentPresets" ? { composedPreset: (a) => (a && a.marker === "agent-ctx" ? "standard" : "harness") } : undefined) };
  assert.equal(composedPresetOf({ ctx: { marker: "agent-ctx" } }, ctx), "standard");
  assert.equal(composedPresetOf({}, ctx), "harness");
});

console.log("\nB17 预设门禁回归： " + n + "/" + n + " PASS");
