#!/usr/bin/env node
// 合规审计脚本的自测（meta 验证）：造两种合成会话日志——①全合规 ②逐条违规——
// 断言审计脚本分别给出 PASS / FAIL。这是「检查器的检查器」，防锁失效（T5c 恒真那类事故）。
//
// 用法：node selftest-workflow-compliance.mjs
// 退出码：0 = 全部自测通过；1 = 有 FAIL。
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, "..");
const AUDIT = join(HERE, "check-workflow-compliance.mjs");
const SKILL = join(WS, "dsh-preset/harness/skills/harness/SKILL.md");
const TMP = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "compliance-selftest-" + process.pid);

// 从 SKILL.md 现读各段首尾句（与审计脚本同源，避免自测里硬编码）
// 实现与 check-workflow-compliance.mjs 的 extractSegmentAnchor 保持一致（用 indexOf 切分，
// 不用正则——`$` 在 m 标志下的跨行行为曾致自测数据为空，2026-09-23 踩坑）。
function segAnchors() {
  const txt = readFileSync(SKILL, "utf8");
  const grab = (secNo) => {
    const start = txt.indexOf(`### ${secNo} `);
    if (start < 0) return null;
    const after = txt.slice(start);
    const end = Math.min(...["\n### ", "\n## "].map((k) => { const i = after.indexOf(k, 4); return i < 0 ? Infinity : i; }));
    const body = after.slice(0, end === Infinity ? after.length : end).split("\n").slice(1).join("\n").trim();
    return { first: body.split(/[。\n]/)[0].trim(), tail: body.split(/[。\n]/).filter((x) => x.trim()).pop().trim(), body };
  };
  return { bing: grab("7.3"), jia: grab("7.1"), yi: grab("7.2") };
}

const A = segAnchors();
const events = [];
let seq = 1;
const ev = (type, data, extra = {}) => ({ type, seq: seq++, time: 1700000000000 + seq, data, ...extra });
const zstdFrame = (text) => zlib.zstdCompressSync(Buffer.from(text, "utf8"));

function writeSession(dir, id, { preset = "harness", parent = "", depth = 0, evs, cwd = "" }) {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  const head = { type: "session", version: 3, id, createdAt: 1700000000000, cwd, isSeeded: false, delegationDepth: depth, agentPreset: preset, ...(parent ? { parentSession: parent } : {}) };
  const body = [head, ...evs].map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(d, "session.v3.jsonl.zstd"), zstdFrame(body));
}

const toolCall = (name, args) => ({ type: "tool/call", seq: seq++, time: 1700000000000 + seq, data: { turn: 1, step: 1, callId: "c" + seq, name, arguments: JSON.stringify(args) } });
const asstText = (text) => ({ type: "assistant/message", seq: seq++, time: 1700000000000 + seq, data: { message: { role: "assistant", content: [{ type: "text", text }] } } });

// ── 用例 1：全合规 ──
function caseCompliant(dir) {
  const rootId = "root-compliant";
  const ctrlId = "ctrl-compliant";
  const workerId = "worker-compliant";
  writeSession(dir, rootId, {
    preset: "harness", depth: 0, evs: [
      // 派主控：真实派发包含「主控子代理」标识 + 乙段 + 上限行（同 SKILL §7.2 要求）
      toolCall("subagent", { description: "建看板", prompt: `你是本项目的主控子代理（项目经理）。\n\n${A.yi.body}\n\n执行卡上限 4 张` }),
      // 提问走工具
      toolCall("ask_user_question", { questions: [{ question: "选哪个", options: [{ label: "A" }] }] })
    ]
  });
  writeSession(dir, ctrlId, {
    preset: "harness", parent: rootId, depth: 1, evs: [
      // 派孙代理：逐字附带整段丙段（首句 + 尾句都在）
      toolCall("subagent", { description: "卡1", prompt: `【任务卡】卡1\n\n${A.bing.body}\n\n## 你的任务\n写点东西` })
    ]
  });
  writeSession(dir, workerId, { preset: "harness", parent: ctrlId, depth: 2, evs: [asstText("完工报告：已完成")] });
}

// ── 用例 2：逐条违规 ──
function caseViolating(dir) {
  const rootId = "root-bad";
  const ctrlId = "ctrl-bad";
  writeSession(dir, rootId, {
    preset: "harness", depth: 0, evs: [
      // R6：派主控不带上限行；R2：派攻击代理不带八维清单
      toolCall("subagent", { description: "建看板", prompt: `你是本项目的主控子代理。\n\n${A.yi.body}\n\n（没有上限行）` }),
      toolCall("subagent", { description: "攻击", prompt: "你是一次性独立红队攻击代理，只攻不建。请攻击条款。" }),
      // R3：正文夹带问用户（不走工具）
      asstText("下一步可选：直接开跑（需要你锁押题清单 + 拍板 H7），或先处理 P1 机制。等你回：A 开跑 / B 先处理。")
    ]
  });
  writeSession(dir, ctrlId, {
    preset: "harness", parent: rootId, depth: 1, evs: [
      // R1：派孙代理不带丙段
      toolCall("subagent", { description: "卡1", prompt: "你是孙代理 S1，执行卡1。你只做本卡这一件事。请写点东西。" })
    ]
  });
}

// ── 用例 2b：R7 高风险弱检（真阳 + 真阴）──
// 真阳：根正文出现「命中高风险」信号、整棵树零甲段派发 → 报 R7；
// 真阴：同样信号但树内有甲段（攻击/审计）派发 → 不报。
const RISK_TEXT = "我判定本卡命中高风险②（跨模块改动），须按 §10.2 派独立审计。";
function caseR7(dir) {
  const mkRoot = (id, withAudit) => {
    const evs = [
      toolCall("subagent", { description: "建看板", prompt: `你是本项目的主控子代理（项目经理）。\n\n${A.yi.body}\n\n执行卡上限 4 张` })
    ];
    if (withAudit) evs.push(toolCall("subagent", { description: "审计", prompt: `${A.jia.body}\n\n请审计交付物。` }));
    evs.push(asstText(RISK_TEXT));
    writeSession(dir, id, { preset: "harness", depth: 0, evs });
  };
  mkRoot("root-r7-bad", false);
  mkRoot("root-r7-good", true);
}

// 真阳：探索段会话 + 全部 worker 卡自述「学习」且零「维度」字样 → 报 R8；
// 真阴：同探索段，卡片含「维度」字样（正常探索）→ 不报；工程段全是学习卡 → 不报（learnNeed 合法用法）。
function caseR8(dir) {
  const EXPLORE_NOTE = "判型=探索模式（定稿）：工作流=你给初始维度→子代理扩展维度后再派孙代理→孙代理逐维调查值。";
  const mkRoot = (id, { explore, cards }) => {
    const evs = [];
    if (explore) evs.push(asstText(EXPLORE_NOTE));
    for (const c of cards) evs.push(toolCall("subagent", { description: c.desc, prompt: c.prompt }));
    writeSession(dir, id, { preset: "harness", depth: 0, evs });
  };
  // 真阳：4 张卡全叫「学习/勘察」且 prompt 里无「维度」
  mkRoot("root-r8-bad", { explore: true, cards: [
    { desc: "学习：GitHub 开源项目勘察", prompt: "你是探索勘察子代理（学习环）。任务：勘察 GitHub 上的现成开源项目。" },
    { desc: "学习：技术选型", prompt: "你是探索勘察子代理（技术选型勘察）。任务：评估技术路线。" },
    { desc: "学习：素材版权", prompt: "你是探索勘察子代理（素材勘察）。任务：勘察美术素材方案。" },
    { desc: "学习：玩法拆解", prompt: "你是探索勘察子代理（玩法拆解）。任务：拆解核心玩法循环。" }
  ] });
  // 真阴 1：探索段但卡片含「维度」（正常探索）
  mkRoot("root-r8-good1", { explore: true, cards: [
    { desc: "维度调查：颜色与大小", prompt: "你是孙代理。逐维调查：颜色=？大小=？附证据路径。" },
    { desc: "维度调查：口感与环境", prompt: "你是孙代理。逐维调查：口感=？生长环境=？附证据路径。" }
  ] });
  // 真阴 2：工程段 + 学习卡（learnNeed=B 的合法用法；正文无探索标识）
  mkRoot("root-r8-good2", { explore: false, cards: [
    { desc: "学习：Phaser 用法", prompt: "你是学习子代理。任务：补齐 Phaser 3 的 tilemap 用法能力缺口。" },
    { desc: "学习：打包流程", prompt: "你是学习子代理。任务：查清打包与本地预览流程。" }
  ] });
}

// ── 用例 2d：R9 派主控逐字附带乙段 + 门禁拦下不计违规（2026-09-24 E2E 实测后新增）──
// 真阳（R9）：派主控的 prompt 改写了乙段（无 §7.2 全文）→ R9 被抓；
// 真阴（拦下豁免）：worker 卡缺丙段，但该调用被硬门禁当场拦下（tool/result 带门禁理由）→ 不计 R1 违规。
function caseR9AndBlocked(dir) {
  const ctrlVerbatim = "你是执行（或探索）主控子代理。" + A.yi.body + " 执行卡上限 4 张";
  const ctrlRewritten = "你是本次任务的主控子代理（项目经理）。职责：建 goal + 看板 + 分工表后派孙代理。执行卡上限 4 张";
  writeSession(dir, "root-r9-bad", { preset: "harness", depth: 0, evs: [
    toolCall("subagent", { description: "派主控", prompt: ctrlRewritten })
  ] });
  writeSession(dir, "root-r9-good", { preset: "harness", depth: 0, evs: [
    toolCall("subagent", { description: "派主控", prompt: ctrlVerbatim })
  ] });
  const badCall = toolCall("subagent", { description: "缺段卡", prompt: "你是孙代理 S1。执行卡1。" });
  writeSession(dir, "root-blocked", { preset: "harness", depth: 0, evs: [
    badCall,
    { type: "tool/result", seq: seq++, time: 1700000000000 + seq,
      data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: badCall.data.callId },
        content: [{ type: "tool-result", toolCallId: badCall.data.callId,
          content: [{ type: "text", text: "⛔ 驾驭工程门禁：任务卡未逐字附带「丙・孙代理行为段」（SKILL §7.3）——缺段的任务卡不合格、不得发出。" }] }] } } }
  ] });
}

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${label}${extra ? " ｜ " + extra : ""}`);
  if (!ok) failures++;
};

function runAudit(dir, rootId) {
  const r = spawnSync(process.execPath, [AUDIT, "--sessions-dir", dir, "--root", rootId, "--skill", SKILL, "--json"], { encoding: "utf8" });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, raw: r.stdout + r.stderr };
}

try {
  // ── 用例 1 ──
  const d1 = join(TMP, "compliant");
  mkdirSync(d1, { recursive: true });
  caseCompliant(d1);
  const r1 = runAudit(d1, "root-compliant");
  const v1 = r1.json ? [...new Set(r1.json.findings.map((f) => f.rule))] : ["(解析失败)"];
  check("用例1 全合规 → 零违规", r1.code === 0 && v1.length === 0, `exit=${r1.code} 违规规则=${v1.join(",") || "无"}`);
  if (r1.json) {
    check("  子项：丙段命中计入合规统计", r1.json.anchors?.withBing === 1 && r1.json.anchors?.toWorker === 1, `withBing=${r1.json.anchors?.withBing}/toWorker=${r1.json.anchors?.toWorker}`);
    check("  子项：上限行计入合规统计", r1.json.anchors?.withCapLine === 1 && r1.json.anchors?.toController === 1, `withCapLine=${r1.json.anchors?.withCapLine}/toController=${r1.json.anchors?.toController}`);
    check("  子项：ask_user_question 计数", r1.json.r3?.askCalls === 1, `askCalls=${r1.json.r3?.askCalls}`);
  }

  // ── 用例 2 ──
  const d2 = join(TMP, "violating");
  mkdirSync(d2, { recursive: true });
  caseViolating(d2);
  const r2 = runAudit(d2, "root-bad");
  const v2 = new Set(r2.json ? r2.json.findings.map((f) => f.rule) : []);
  check("用例2 逐条违规 → R1 被抓", v2.has("R1"), `违规规则=${[...v2].join(",")}`);
  check("用例2 逐条违规 → R2 被抓", v2.has("R2"), "");
  check("用例2 逐条违规 → R3 被抓", v2.has("R3"), "");
  check("用例2 逐条违规 → R6 被抓", v2.has("R6"), "");
  check("用例2 退出码 = 违规规则数", r2.code === v2.size, `exit=${r2.code} 规则数=${v2.size}`);

  // ── 用例 2d【2026-09-24 全盘压测 B12 回归锁】：worker 卡引用「主控子代理」不得被判成「派主控」──
  // 真机背景（A3h 实测）：孙代理卡以「你是孙代理 SA-1，执行主控子代理下达的 Card-1」开头，
  // 旧判据「前 160 字符含『主控子代理』」把它误判成派主控 → 连带 R6「缺上限行」+ R9「乙段未逐字」
  // 共 3 条假违规（把合规记成违规）。修法：按角色声明段本体判（乙段首句在场=派主控；丙段首句在场=任务卡）。
  const d2dB12 = join(TMP, "b12");
  mkdirSync(d2dB12, { recursive: true });
  {
    const rootId = "root-b12";
    writeSession(d2dB12, rootId, {
      preset: "harness", depth: 0, evs: [
        // 合规派主控（乙段逐字 + 上限行在场）
        toolCall("subagent", { description: "建看板", prompt: `你是执行（或探索）主控子代理。

${A.yi.body}

执行卡上限 4 张` }),
        // 合规 worker 卡，其正文**引用了**「主控子代理」字样（真机形态）——不得被判成派主控
        toolCall("subagent", { description: "卡1", prompt: `你是孙代理 SA-1，执行主控子代理下达的 Card-1。工作目录 D:/x。

${A.bing.body}

## 你的任务
写点东西` })
      ]
    });
  }
  const r12 = runAudit(d2dB12, "root-b12");
  const f12 = r12.json ? r12.json.findings : [];
  const v12 = new Set(f12.map((f) => f.rule));
  check("用例2d B12 回归：worker 卡正文引用「主控子代理」→ **不**误报 R6", !v12.has("R6"), `违规规则=${[...v12].join(",") || "无"}`);
  check("用例2d B12 回归：同上 → **不**误报 R9", !v12.has("R9"), `违规规则=${[...v12].join(",") || "无"}`);
  check("用例2d B12 回归：该树整体零违规（合规树不得被记成违规）", r12.code === 0 && f12.length === 0, `exit=${r12.code} 条数=${f12.length}`);

  // ── 用例 2e：R10 押题清单锁定人弱检（2026-09-25 立；真阳 + 真阴）──
  // 立论：攻击报告 C6 确凿——run-20260827-1 的押题清单自陈「锁定人：主代理」，独立性=0。
  // R10 读的是**工作区的押题清单文件**（不是会话日志），故本用例造一个临时 cwd 的 runs/ 结构。
  {
    const d10 = join(TMP, "r10ws");
    const runA = join(d10, "runs", "run-20260101-1");
    const runB = join(d10, "runs", "run-20260101-2");
    mkdirSync(runA, { recursive: true }); mkdirSync(runB, { recursive: true });
    writeFileSync(join(runA, "押题清单.md"), "# 押题清单\n\n> 锁定人：主代理；锁定时机：run 开始前。\n", "utf8");
    writeFileSync(join(runB, "押题清单.md"), "# 押题清单\n\n> 锁定人：用户（测试会话之前单独落盘）\n", "utf8");
    // 同时造一个最小合规会话树，保证审计脚本能正常跑完（R10 与会话内容无关）
    writeSession(join(d10, "sess"), "root-r10", { preset: "harness", depth: 0, cwd: d10, evs: [toolCall("ask_user_question", { question: "x" })] });
    const r10 = spawnSync(process.execPath, [AUDIT, "--sessions-dir", join(d10, "sess"), "--root", "root-r10", "--skill", SKILL, "--cwd", d10, "--json"], { encoding: "utf8" });
    let j10 = null; try { j10 = JSON.parse(r10.stdout); } catch {}
    const f10 = (j10?.findings ?? []).filter((f) => f.rule === "R10");
    check("用例2e R10：锁定人=主代理 → 被抓（真阳）", f10.length === 1 && /主代理/.test(f10[0].detail), `条数=${f10.length}`);
    check("用例2e R10：锁定人=用户 → 不报（真阴）", !f10.some((f) => f.evidence.includes("run-20260101-2")), "");
    check("用例2e R10：统计口径（扫描 2 份、含字段 2 份、报警 1 份）", j10?.r10?.scanned === 2 && j10?.r10?.withField === 2 && j10?.r10?.flagged === 1, JSON.stringify(j10?.r10 ?? {}));
  }

  // ── 用例 2b：R7 ──
  const d2b = join(TMP, "r7");
  mkdirSync(d2b, { recursive: true });
  caseR7(d2b);
  const rBad = runAudit(d2b, "root-r7-bad");
  const vBad = new Set(rBad.json ? rBad.json.findings.map((f) => f.rule) : []);
  check("用例2b 高风险信号无审计 → R7 被抓", vBad.has("R7"), `违规规则=${[...vBad].join(",") || "无"}`);
  check("用例2b 该案仅 R7（无 R6 误报：上限行在场）", !vBad.has("R6"), "");
  const rGood = runAudit(d2b, "root-r7-good");
  const vGood = new Set(rGood.json ? rGood.json.findings.map((f) => f.rule) : []);
  check("用例2b 同信号但有甲段派发 → R7 不报（真阴）", !vGood.has("R7"), `违规规则=${[...vGood].join(",") || "无"}`);

  // ── 用例 2c：R8 ──
  const d2c = join(TMP, "r8");
  mkdirSync(d2c, { recursive: true });
  caseR8(d2c);
  const r8Bad = runAudit(d2c, "root-r8-bad");
  const v8Bad = new Set(r8Bad.json ? r8Bad.json.findings.map((f) => f.rule) : []);
  check("用例2c 探索段全学习卡 → R8 被抓", v8Bad.has("R8"), `违规规则=${[...v8Bad].join(",") || "无"}`);
  const r8G1 = runAudit(d2c, "root-r8-good1");
  const v8G1 = new Set(r8G1.json ? r8G1.json.findings.map((f) => f.rule) : []);
  check("用例2c 探索段含维度卡 → R8 不报（真阴·正常探索）", !v8G1.has("R8"), `违规规则=${[...v8G1].join(",") || "无"}`);
  const r8G2 = runAudit(d2c, "root-r8-good2");
  const v8G2 = new Set(r8G2.json ? r8G2.json.findings.map((f) => f.rule) : []);
  check("用例2c 工程段学习卡 → R8 不报（真阴·learnNeed=B 合法用法）", !v8G2.has("R8"), `违规规则=${[...v8G2].join(",") || "无"}`);

  // ── 用例 2d：R9 + 门禁拦下豁免 ──
  const d2d = join(TMP, "r9");
  mkdirSync(d2d, { recursive: true });
  caseR9AndBlocked(d2d);
  const r9Bad = runAudit(d2d, "root-r9-bad");
  const v9Bad = new Set(r9Bad.json ? r9Bad.json.findings.map((f) => f.rule) : []);
  check("用例2d 派主控改写乙段 → R9 被抓", v9Bad.has("R9"), `违规规则=${[...v9Bad].join(",") || "无"}`);
  const r9Good = runAudit(d2d, "root-r9-good");
  const v9Good = new Set(r9Good.json ? r9Good.json.findings.map((f) => f.rule) : []);
  check("用例2d 派主控逐字附带乙段 → R9 不报（真阴）", !v9Good.has("R9"), `违规规则=${[...v9Good].join(",") || "无"}`);
  check("用例2d 逐字版计入合规统计（controllerVerbatim=1）", r9Good.json?.anchors?.controllerVerbatim === 1, `verbatim=${r9Good.json?.anchors?.controllerVerbatim}`);
  const rBlk = runAudit(d2d, "root-blocked");
  const vBlk = new Set(rBlk.json ? rBlk.json.findings.map((f) => f.rule) : []);
  check("用例2d 门禁拦下的卡不计 R1 违规（豁免生效）", !vBlk.has("R1"), `违规规则=${[...vBlk].join(",") || "无"}`);
  check("用例2d 拦下数计入统计（blocked=1）", rBlk.json?.anchors?.blocked === 1, `blocked=${rBlk.json?.anchors?.blocked}`);

  // ── 用例 3：边界——无会话/空目录不崩 ──
  const d3 = join(TMP, "empty");
  mkdirSync(d3, { recursive: true });
  const r3 = runAudit(d3, "root-none");
  check("用例3 空目录 → 不崩、零违规", r3.code === 0, `exit=${r3.code}`);
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(`\nSUMMARY: ${failures === 0 ? "ALL PASS" : "FAIL=" + failures}`);
process.exit(failures === 0 ? 0 : 1);
