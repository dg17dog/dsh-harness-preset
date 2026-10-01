#!/usr/bin/env node
// 驾驭工程 · run 后合规审计（read-only）
// ─────────────────────────────────────────────────────────────────────────────
// 立论（2026-09-23 工作流方法攻击 附录 B）：方法层 12 条硬约束里有 9 条「只有自我约束、
// 无外部检测」——违规只能靠当事人自报。本脚本把其中 6 条变成**可自动报警**的检查，
// 判据来自**会话日志与面板状态这类原始事实**，不是执行方的自述。
//
// 覆盖规则（编号对应攻击报告附录 B2 表）：
//   R1 丙段逐字附带（SKILL §7.3；实测 0/19 → 预期报警）
//   R2 甲段整段发出（SKILL §7.1；攻击/审计会话入参须含八维度清单）
//   R3 提问纪律：ask_user_question 使用 vs 正文夹带选项化问句（SKILL §9）
//   R4 停用线不得自行恢复（SKILL §11；扫面板状态 log）
//   R5 不越级上报（丙段「沿孙→主控→主代理→用户逐级上报」）
//   R6 执行卡上限下达行（乙段「必须随本条下达『执行卡上限＝N 张』」）
//   R7 高风险命中即派独立审计（SKILL §10.2①；**弱检**：2026-09-24 补 B2-6 剩余一条——
//      仅当根会话正文出现「高风险命中」类信号且整棵树零甲段派发时报「有信号无动作」供人工复核）
//   R8 探索未维度化 / 学习替代探索（SKILL §11 禁令；**弱检**，2026-09-24 立）
//   R9 派主控时未整段逐字附带乙段（SKILL §7.2「整段复制发出」；2026-09-24 E2E 实测后立：
//   R10 押题清单锁定人独立（修攻击报告 C6；**弱检**，2026-09-25 立）
//      真机发现模型把乙段改写成自己的话派发——正是 §7.2 点名要防的「跨层转述=口径漂移」）
// 配套修正（2026-09-24 E2E 实测发现的两个审计自身缺陷）：
//   ① 门禁拦下的派发被重复计为 R1/R2/R6 违规——被拦下的调用根本没派出去（模型当场收到拒绝理由），
//      应单列「门禁拦截」统计而不计入违规，否则「门禁起了作用」反被记成违规。
//   ② 「派主控」被误判为 worker 卡——原判据只认逐字首句，模型改写首句即漏判（连带 R6 的合规统计失真）。
//      现改为「前 160 字符内含『主控子代理』」或「含逐字首句」双判据。

//
// 用法：
//   node check-workflow-compliance.mjs --cwd "D:\pqq"          # 按工作区审计全部会话树
//   node check-workflow-compliance.mjs --root <sessionId>      # 只审计该根会话的树
//   node check-workflow-compliance.mjs --cwd "D:\pqq" --json   # 机器可读
//   node check-workflow-compliance.mjs --skill <SKILL.md 路径> # 指定判据来源（默认工作区副本）
//   node check-workflow-compliance.mjs --sessions-dir <目录>     # 指定会话日志根（自测/归档日志用）
//
// 纪律：只读；不改任何文件；退出码 = 违规规则数（0 = 全部合规）。
// 判据同源（D2）：甲乙丙三段的锚点**从 SKILL.md 现读**，不硬编码——SKILL 改了这里自动跟随。
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const flag = (name) => argv.includes(name);
const WS_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CWD_FILTER = arg("--cwd");            // 只看 cwd 命中该路径的会话
const ROOT_FILTER = arg("--root");          // 只看该根会话的树
const AS_JSON = flag("--json");
const VERBOSE = flag("--verbose");
// 判据来源（D2 同源）：--skill 显式指定 > 环境变量 HARNESS_SKILL_PATH > 多候选默认——
//   ① 工作区布局（本仓库内跑：验收/ 的上一级 + dsh-preset/harness/…）
//   ② 发布布局（GitHub 仓库内跑：tools/ 的上一级 + desktop-bundle|preset/…）
//   ③ 安装副本（~/.dsh/.agent-presets/harness/…）
// 取第一个存在者；全不存在时报错并提示 --skill。
const _here = dirname(fileURLToPath(import.meta.url));
function resolveSkillDefault() {
  if (process.env.HARNESS_SKILL_PATH) return process.env.HARNESS_SKILL_PATH;
  const cands = [
    join(_here, "..", "dsh-preset", "harness", "skills", "harness", "SKILL.md"),
    join(_here, "..", "desktop-bundle", "skills", "harness", "SKILL.md"),
    join(_here, "..", "preset", "harness", "skills", "harness", "SKILL.md"),
    join(process.env.USERPROFILE ?? homedir(), ".dsh", ".agent-presets", "harness", "skills", "harness", "SKILL.md"),
  ];
  for (const c of cands) { try { if (existsSync(c)) return c; } catch {} }
  return cands[0];
}
const SKILL_PATH = arg("--skill", resolveSkillDefault());
// 会话日志根目录。默认 ~/.dsh/sessions；可用 --sessions-dir 指向别处（自测合成用例 / 归档日志）。
const SESSIONS = arg("--sessions-dir", join(process.env.USERPROFILE ?? homedir(), ".dsh", "sessions"));
const FLOW_DIR = arg("--flow-dir", join(process.env.USERPROFILE ?? homedir(), ".dsh", "harness-flow"));

// ── zstd 多帧解压（会话日志形态；与 tree-cost-authoritative.mjs 同法） ────────
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function readZstd(p) {
  const b = readFileSync(p); const idx = []; let i = 0;
  while (i < b.length) { const q = b.indexOf(ZSTD_MAGIC, i); if (q < 0) break; idx.push(q); i = q + 4; }
  let t = ""; for (let k = 0; k < idx.length; k++) { try { t += zlib.zstdDecompressSync(b.subarray(idx[k], idx[k + 1] ?? b.length)).toString("utf8"); } catch {} }
  return t;
}
const parseEvents = (t) => t.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// ── 会话发现（sessions/<workspace>/<sid>/session.v3.jsonl.zstd） ─────────────
function walkSessionFiles(dir, out = []) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSessionFiles(p, out);
    else if (e.name === "session.v3.jsonl.zstd") out.push(p);
  }
  return out;
}

function loadSessions() {
  const out = [];
  for (const f of walkSessionFiles(SESSIONS)) {
    let evs; try { evs = parseEvents(readZstd(f)); } catch { continue; }
    const head = evs.find((e) => e.type === "session");
    if (!head) continue;
    const id = String(head.id);
    const parent = String(head.parentSession ?? head.parent ?? "");
    const cwd = String(head.cwd ?? "");
    out.push({ id, parent, cwd, depth: typeof head.delegationDepth === "number" ? head.delegationDepth : (parent ? null : 0), path: f, events: evs });
  }
  // depth 缺失时按 parent 链补
  const byId = new Map(out.map((s) => [s.id, s]));
  for (const s of out) {
    if (s.depth === null || s.depth === undefined) {
      let d = 0, cur = s, guard = 0;
      while (cur?.parent && byId.has(cur.parent) && guard++ < 50) { cur = byId.get(cur.parent); d++; }
      s.depth = d;
    }
  }
  return out;
}

// ── 判据提取（从 SKILL.md 现读甲乙丙段，保证口径同源） ──────────────────────
// 用 indexOf 切分而非正则：`$` 在 m 标志下不匹配字符串末尾以外的位置，曾致提取为空。
function extractSegmentAnchor(section) {
  if (!existsSync(SKILL_PATH)) return null;
  const txt = readFileSync(SKILL_PATH, "utf8");
  const start = txt.indexOf(`### ${section} `);
  if (start < 0) return null;
  const after = txt.slice(start);
  const end = Math.min(...["\n### ", "\n## "].map((k) => { const i = after.indexOf(k, 4); return i < 0 ? Infinity : i; }));
  const body = after.slice(0, end === Infinity ? after.length : end).split("\n").slice(1).join("\n").trim();
  if (!body) return null;
  const firstSentence = body.split(/[。\n]/)[0].trim();
  const tailSentence = (body.split(/[。\n]/).filter((x) => x.trim()).pop() ?? "").trim();
  return { body, firstSentence, tailSentence, len: body.length };
}

// ── 各规则检查 ──────────────────────────────────────────────────────────────
function toolCalls(evs, name) {
  return evs.filter((e) => e.type === "tool/call" && e.data?.name === name).map((e) => {
    let a = null; try { a = JSON.parse(e.data.arguments ?? "{}"); } catch {}
    return { seq: e.seq, time: e.time, kind: name, callId: e.data?.callId, args: a ?? {}, raw: e.data.arguments ?? "" };
  });
}
// 被硬门禁当场拦下的调用集合（callId）：从 tool/result 文本里识别门禁拒绝理由——
// 这些调用**没有真正派发**（模型当场收到理由并通常自纠），不应再计为「任务卡缺丙段」等违规。
function blockedCallIds(evs) {
  const out = new Set();
  for (const e of evs) {
    if (e.type !== "tool/result") continue;
    const s = JSON.stringify(e.data ?? {});
    if (!s.includes("驾驭工程门禁")) continue;
    const cid = e.data?.message?.source?.callId;
    if (typeof cid === "string") out.add(cid);
    const content = e.data?.message?.content;
    for (const c of (Array.isArray(content) ? content : [])) if (typeof c?.toolCallId === "string") out.add(c.toolCallId);
  }
  return out;
}
const normWs = (s) => String(s).replace(/\s+/g, "");

function assistantTexts(evs) {
  const out = [];
  for (const e of evs) {
    if (e.type !== "assistant/message") continue;
    const content = e.data?.message?.content ?? e.data?.content ?? [];
    const arr = Array.isArray(content) ? content : [content];
    for (const c of arr) if (c && c.type === "text" && typeof c.text === "string") out.push({ seq: e.seq, text: c.text });
  }
  return out;
}

function checkR1_R6(sessions, anchors) {
  const yj = anchors["7.1"], yi = anchors["7.2"], bing = anchors["7.3"];
  const findings = [];
  const stats = { subagentCalls: 0, toController: 0, toWorker: 0, withBing: 0, withCapLine: 0, controllerVerbatim: 0, blocked: 0, attackCalls: 0, attackWithList: 0, forks: 0 };
  const attackBySession = new Map();   // R7 用：各会话的甲段（攻击/审计）派发数
  // 派发通道：subagent（新实例）与 subagent_fork（复用实例）都要查——fork 的入参里同样带 prompt/message。
  const DISPATCH = ["subagent", "subagent_fork"];

  for (const s of sessions) {
    const blocked = blockedCallIds(s.events);
    const subs = DISPATCH.flatMap((n) => toolCalls(s.events, n));
    for (const c of subs) {
      const prompt = String(c.args.prompt ?? c.args.message ?? "");   // subagent=prompt；subagent_fork=message
      if (!prompt) continue;
      stats.subagentCalls++;
      if (c.kind === "subagent_fork") stats.forks++;
      if (c.callId && blocked.has(c.callId)) { stats.blocked++; continue; }   // 被门禁拦下：未真正派发，不计违规
      // 角色判定（2026-09-23 修正 + 2026-09-24 E2E 加固 + 2026-09-24 全盘压测 B12 再修）：
      //   甲段任务卡里也含「主控子代理」字样（乙段被引用），故不能用「含该词」做全文判据。
      //   【B12 缺陷与修法】上一步加固改用「前 160 字符内含『主控子代理』」——实测**误伤 worker 卡**：
      //     孙代理卡常以「你是孙代理 SA-1，执行主控子代理下达的 Card-1」开头（A3h 实测），
      //     该措辞在前 160 字内命中 → worker 卡被判成「派主控」→ 连带 R6「缺少上限行」+ R9「乙段未逐字」
      //     共 3 条**假违规**（正是本项目最忌讳的「把合规记成违规」）。
      //   现判据按**角色声明段的本体是否在场**分层（与 G2/G4 门禁同源）：
      //     ① 乙段首句在场（真身「你是执行（或探索）主控子代理」）→ 派主控（正文里引用该措辞的 worker 卡不会逐字含此串）
      //     ② 否则丙段首句在场（真身「你只按本任务卡工作」）→ 任务卡（worker）
      //     ③ 都没有 → 退回前 160 字启发式（应对模型改写首句的漏判场景）
      const head = prompt.slice(0, 160);
      const isAttackMsg = (yj && prompt.includes(yj.firstSentence)) || /你是一次性独立红队攻击|独立审计代理，只攻不建/.test(prompt);
      const hasYiDecl = !!(yi && prompt.includes(yi.firstSentence));
      const hasBingDecl = !!(bing && prompt.includes(bing.firstSentence));
      const isControllerMsg = !isAttackMsg && (hasYiDecl || (!hasBingDecl && (/^你是执行（或探索）主控子代理/m.test(prompt) || head.includes("主控子代理"))));
      const isWorkerMsg = !isAttackMsg && !isControllerMsg && (hasBingDecl || /你只按本任务卡工作/.test(prompt));
      if (isAttackMsg) {
        stats.attackCalls++;
        attackBySession.set(s.id, (attackBySession.get(s.id) ?? 0) + 1);
        const dims = ["流程断点", "验收可检验性", "范围漏洞", "约束冲突", "机制可行性", "隐藏假设", "定义模糊", "口径遗漏"];
        const hit = dims.filter((d) => prompt.includes(d));
        if (hit.length >= 6) stats.attackWithList++;   // 八维清单大部分在场才算「整段发出」
        else findings.push({ rule: "R2", sev: "高", sid: s.id.slice(0, 20), seq: c.seq,
          detail: `攻击/审计派发未含甲段八维清单（命中 ${hit.length}/8 维）`, evidence: prompt.slice(0, 120).replace(/\s+/g, " ") });
      } else if (isControllerMsg) {
        stats.toController++;
        const hasCap = /执行卡上限\s*[＝=]?\s*\d+\s*张/.test(prompt) || /执行卡上限\s*[≤<]?\s*\d+/.test(prompt);
        if (hasCap) stats.withCapLine++;
        else findings.push({ rule: "R6", sev: "高", sid: s.id.slice(0, 20), seq: c.seq,
          detail: "派主控时未按乙段下达「执行卡上限＝N 张」行", evidence: prompt.slice(0, 120).replace(/\s+/g, " ") });
        // R9：乙段必须整段逐字附带（§7.2）；模型改写即「跨层转述」，允许重排空白但不得改字
        const verbatim = yi && normWs(prompt).includes(normWs(yi.body));
        if (verbatim) stats.controllerVerbatim++;
        else findings.push({ rule: "R9", sev: "中", sid: s.id.slice(0, 20), seq: c.seq,
          detail: "派主控时未整段逐字附带乙段（SKILL §7.2「整段复制发出，禁止改写精简」）——模型改写了行为规范段（跨层转述=口径漂移）",
          evidence: prompt.slice(0, 120).replace(/\s+/g, " ") });
      } else if (isWorkerMsg || !isControllerMsg) {
        // 兜底：既非攻击、也非主控标识的派发，一律按「任务卡」审 R1（宁可多查，不漏检丙段）
        stats.toWorker++;
        const hasBing = bing && prompt.includes(bing.firstSentence) && prompt.includes("本卡完成即停手待命");
        if (hasBing) stats.withBing++;
        else findings.push({ rule: "R1", sev: "高", sid: s.id.slice(0, 20), seq: c.seq,
          detail: "任务卡未逐字附带丙段（缺首句或尾句）", evidence: prompt.slice(0, 120).replace(/\s+/g, " ") });
      }
    }
  }
  // 汇总不另计条目（避免与逐卡明细重复计数）——聚合信息在输出行里显示
  return { findings, stats, attackBySession };
}

function checkR3(sessions) {
  const findings = []; const stats = { askCalls: 0, embeddedAsks: 0, sessionsWithEmbedded: 0, rootSessions: 0 };
  // 只查根会话——子代理给上级的汇报不算「问用户」（2026-09-23 校准：曾把返工报告误判为问询）。
  // 信号取「等你确认 / 请你选 / 由你决定 / 等你回」这类**要求用户拍板**的措辞（实测出现形态：
  // 「等你确认 T13+T14」「等你回：题目选项 A/B/C」）。选项块（行首 A./B.）作为加强信号。
  const decidePat = /(?:等|请|需要)你[^。\n]{0,14}(?:选|圈定|确认|拍板|决定|裁定|回)|由你(?:决定|选|拍板)|(?:请|你)选择/;
  const optPat = /(?:^|\n)\s*\*{0,2}[A-D][.、)）]\s*\*{0,2}\S/;
  for (const s of sessions) {
    if ((s.depth ?? 0) !== 0) continue;
    stats.rootSessions++;
    const asks = toolCalls(s.events, "ask_user_question");
    stats.askCalls += asks.length;
    // 排除「描述语境」误报：命中词若出现在「按工作法应先上报由你决定」「而不是…」这类
    // 转述/评价别人行为的句子里，不算本会话在问用户（2026-09-23 实测踩到的唯一误报形态）。
    const isDescribe = (text, idx) => {
      const before = text.slice(Math.max(0, idx - 44), idx);
      return /按(工作法|SKILL|条款|规范|方法|约定)|应\*{0,2}先|而不是|不等于|例如|这类|那种/.test(before);
    };
    const hits = [];
    for (const t of assistantTexts(s.events)) {
      const m = decidePat.exec(t.text);
      if (!m) continue;
      if (isDescribe(t.text, m.index)) continue;
      hits.push({ ...t, at: m.index, word: m[0] });
    }
    const strong = hits.filter((t) => optPat.test(t.text));
    if (hits.length > 0) {
      stats.embeddedAsks += hits.length; stats.sessionsWithEmbedded++;
      // G5 兜底识别（2026-09-24）：若本会话记录了 G5 自动置旗事件（harness/gate-denied auto-freeze），
      // 说明门禁已把「正文提问」变成「自动冻结 + 拒派」，即机制兜住了这次漂移——严重级降为「低」，
      // 并在条目里注明「已被 G5 自动冻结兜住」，避免把「机制生效」误报成「无人管」。
      const g5Froze = s.events.some((e) => e.type === "harness/gate-denied" && e.data?.action === "auto-freeze");
      if (g5Froze) stats.g5Froze = (stats.g5Froze ?? 0) + 1;
      findings.push({ rule: "R3", sev: asks.length === 0 ? (g5Froze ? "低" : "中") : "低", sid: s.id.slice(0, 20), seq: hits[0].seq,
        detail: `正文夹带「要求用户拍板」的问询 ${hits.length} 处（含选项块 ${strong.length} 处）｜该会话 ask_user_question 调用 ${asks.length} 次——SKILL §9 要求走选项化提问工具`
          + (g5Froze ? "｜**已被 G5 门禁自动冻结兜住**（harness/gate-denied auto-freeze 在场）" : ""),
        evidence: hits[0].text.replace(/\s+/g, " ").slice(Math.max(0, hits[0].at - 40), hits[0].at + 80) });
    }
  }
  return { findings, stats };
}

function checkR4(sessions) {
  const findings = []; const stats = { flowFiles: 0, checked: 0 };
  // 面板状态 log 里的「恢复/启用被跳过关卡」类条目
  const recoverPat = /恢复|重新启用|回退到|启用被跳过|重新开启/;
  const skipPat = /跳过|停用|关闭|direct|简约|一层/;
  for (const s of sessions) {
    // 状态文件名 = safeKey(会话 id)：非 [A-Za-z0-9_-] 替换为 _
    const key = s.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
    const p = join(FLOW_DIR, key + ".json");
    if (!existsSync(p)) continue;
    stats.flowFiles++;
    try {
      const st = JSON.parse(readFileSync(p, "utf8"));
      const log = Array.isArray(st.log) ? st.log : [];
      stats.checked++;
      const hits = log.filter((e) => recoverPat.test(String(e.text ?? "")) && skipPat.test(String(e.text ?? "")));
      if (hits.length) {
        findings.push({ rule: "R4", sev: "中", sid: s.id.slice(0, 20), seq: 0,
          detail: `面板留痕出现「恢复被跳过关卡」类条目 ${hits.length} 条`, evidence: hits.slice(0, 2).map((e) => String(e.text).slice(0, 60)).join(" ｜ ") });
      }
    } catch {}
  }
  return { findings, stats };
}

function checkR5(sessions) {
  const findings = []; const stats = { msgCalls: 0, fromWorker: 0, crossLevel: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const byPrefix = new Map(sessions.map((s) => [s.id.slice(0, 8), s]));
  for (const s of sessions) {
    const msgs = toolCalls(s.events, "send_message");
    for (const m of msgs) {
      stats.msgCalls++;
      if ((s.depth ?? 0) < 2) continue;         // 只有孙代理层才可能越级
      stats.fromWorker++;
      const target = String(m.args.agent_id ?? m.args.agentId ?? m.args.to ?? "");
      const t = byId.get(target) ?? byPrefix.get(target.slice(0, 8));
      if (t && (t.depth ?? 0) <= 1) {           // 孙代理直接给主代理/主控以外，或直接联系根
        if ((t.depth ?? 0) === 0) {
          stats.crossLevel++;
          findings.push({ rule: "R5", sev: "中", sid: s.id.slice(0, 20), seq: m.seq,
            detail: `孙代理越级直发主代理（应沿 孙→主控→主代理 逐级）`, evidence: `目标 ${target.slice(0, 20)} (depth=${t.depth})` });
        }
      }
    }
  }
  return { findings, stats };
}

// ── R7 弱检：高风险命中即派独立审计（SKILL §10.2①；2026-09-24 补 B2-6 剩余一条）─────
// 为什么只能弱检：「高风险是否命中」本身是模型判断，无法机械化。本检查退一步看**痕迹**：
// 根会话（主代理）正文若出现「命中/触发…高风险|D1」类信号，而整棵树**零甲段（攻击/审计）派发**，
// 报 R7 供人工复核（不判对错，只报「有信号、无动作」）。
// 边界（诚实声明）：
//   ① 信号靠正则，措辞不受控——否定式（不/未/没 命中）已排除，但转述、举例仍可能误报；
//      且**无信号 ≠ 未发生**（换个说法就漏），本检查不是覆盖率证明。
//   ② 只审「有派发的树」（三层在跑：树内存在任意 subagent/subagent_fork 调用）——
//      一层编排树不适用独立审计线，不报。
function checkR7(sessions, attackBySession) {
  const findings = []; const stats = { trees: 0, treesWithSignal: 0, treesWithAudit: 0, signalCovered: 0, flagged: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const childrenOf = new Map();
  for (const s of sessions) {
    if (s.parent) { if (!childrenOf.has(s.parent)) childrenOf.set(s.parent, []); childrenOf.get(s.parent).push(s.id); }
  }
  const P1 = /(?<![不未没])(?:命中|触发|构成)[^。\n]{0,16}(?:高风险|D1)/;
  const P2 = /(?:高风险|D1)[^。\n]{0,16}(?<![不未没])命中/;
  const conditional = (text, idx) => /若|如果|假如|一旦|当.{0,6}时/.test(text.slice(Math.max(0, idx - 8), idx));
  for (const root of sessions.filter((s) => (s.depth ?? 0) === 0)) {
    // 整棵树（按 parent 链展开）
    const tree = [root]; const queue = [root.id];
    while (queue.length) {
      const cur = queue.shift();
      for (const c of (childrenOf.get(cur) ?? [])) { const cs = byId.get(c); if (cs) { tree.push(cs); queue.push(c); } }
    }
    const anyDispatch = tree.some((s) => s.events.some((e) => e.type === "tool/call" && (e.data?.name === "subagent" || e.data?.name === "subagent_fork")));
    if (!anyDispatch) continue;                       // 一层编排树不适用
    stats.trees++;
    const auditCalls = tree.reduce((n, s) => n + (attackBySession.get(s.id) ?? 0), 0);
    const hits = [];
    for (const t of assistantTexts(root.events)) {
      const m = P1.exec(t.text) ?? P2.exec(t.text);
      if (m && !conditional(t.text, m.index)) hits.push({ seq: t.seq, at: m.index, word: m[0], text: t.text });
    }
    if (hits.length) stats.treesWithSignal++;
    if (auditCalls > 0) { stats.treesWithAudit++; if (hits.length) stats.signalCovered++; continue; }
    if (!hits.length) continue;
    const h = hits[0];
    stats.flagged++;
    findings.push({ rule: "R7", sev: "中", sid: root.id.slice(0, 20), seq: h.seq,
      detail: `弱检：根会话正文出现高风险信号「${h.word}」（${hits.length} 处），但整棵树零甲段（攻击/审计）派发——SKILL §10.2① 要求命中即派，请人工复核是否该派未派`,
      evidence: h.text.replace(/\s+/g, " ").slice(Math.max(0, h.at - 40), h.at + 80) });
  }
  return { findings, stats };
}

// ── R8 弱检：探索未维度化 / 学习替代探索（SKILL §11 禁令；2026-09-24 立）──────────────
// 立论（真实教训）：2026-09-21 星露谷 run 主代理以「学习需求 B」为由派 4 张宽泛勘察卡替代了探索链，
// 且方向由主代理自列后直派（跳过子代理扩展维度的层）——当时无任何检查点。
// 判据（痕迹级，不判对错；**双通道识别探索工作**，避免依赖会话终态判型——星露谷 run 结束时
// 面板状态已切到工程段，靠 judge 会漏检）：
//   通道 A：会话正文（assistant）含探索标识（探索阶段/探索模式/探索链/逐维调查/维度清单表）；
//   通道 B：该会话派出的卡片自称含「探索」（如「探索勘察子代理」）——表明它们在做探索工作。
//   命中任一通道后：worker 卡 ≥2 张、**零张**含「维度」字样、且**全部**卡为宽泛形态
//   （含 勘察/调研/学习/了解/梳理/盘点/探讨 之一）→ 报 R8。
// 为什么以「零维度」为主判据、而非「含学习」：实测星露谷 4 张卡里只有 1 张自称「学习环」，
//   另 3 张自称「勘察」——用「全部含学习」会漏检；真正的机制缺口是**没有任何卡做维度化调查**。
//   「学习」字样降为附加证据（evidence 里优先列出）。
// 边界（诚实声明）：
//   ① 弱检：若探索用了别种措辞（方面/角度/指标）代替「维度」，会误报——故 finding 文案是
//      「请人工复核是否维度化」，不是判定违规；**零命中 ≠ 未混淆**。
//   ② 「学习卡 + 维度卡」并存的探索段（合法：能力补齐与逐维调查并行）不报。
//   ③ 单张卡不报（不足以判形态）。
function checkR8(sessions) {
  const findings = []; const stats = { exploreSessions: 0, workerDispatches: 0, noDimCards: 0, flagged: 0 };
  const EXPLORE_MARK = /探索阶段|探索模式|探索工作流|探索链|逐维调查|维度清单表/;
  const CARD_EXPLORE = /探索/;
  const DIM_WORD = /维度/;
  const BROAD_FORM = /勘察|调研|学习|了解|梳理|盘点|探讨/;
  for (const s of sessions) {
    const texts = assistantTexts(s.events);
    const chanA = texts.some((t) => EXPLORE_MARK.test(t.text));
    const cards = [];
    for (const name of ["subagent", "subagent_fork"]) {
      for (const c of toolCalls(s.events, name)) {
        const prompt = String(c.args.prompt ?? c.args.message ?? "");
        if (!prompt) continue;
        const desc = String(c.args.description ?? "");
        // 排除非 worker 派发（主控/攻击/审计）——它们的卡面不该带「维度」
        if (/主控子代理|你是一次性独立红队攻击|独立审计代理，只攻不建/.test(prompt)) continue;
        cards.push({ seq: c.seq, desc, prompt, head: (desc + " " + prompt.slice(0, 200)) });
      }
    }
    const chanB = cards.some((c) => CARD_EXPLORE.test(c.head));
    if (!chanA && !chanB) continue;
    stats.exploreSessions++;
    if (cards.length < 2) continue;
    stats.workerDispatches += cards.length;
    const dimCards = cards.filter((c) => DIM_WORD.test(c.head));
    const broadCards = cards.filter((c) => BROAD_FORM.test(c.head));
    if (dimCards.length > 0) continue;
    stats.noDimCards++;
    if (broadCards.length !== cards.length) continue;
    const learnCards = cards.filter((c) => /学习/.test(c.head));
    stats.flagged++;
    findings.push({ rule: "R8", sev: "中", sid: s.id.slice(0, 20), seq: cards[0].seq,
      detail: `弱检：探索段会话派出 ${cards.length} 张 worker 卡，零张含「维度」且全部为宽泛形态（${[...new Set(broadCards.map((c) => (BROAD_FORM.exec(c.head) ?? [""])[0]))].join("/")}）——SKILL §11 要求「逐维调查 + 扩展维度」，请人工复核是否以宽泛勘察/学习替代了探索`,
      evidence: (learnCards.length ? learnCards : cards).slice(0, 2).map((c) => (c.desc || c.prompt.slice(0, 40)).replace(/\s+/g, " ")).join(" ｜ ") + `（其中自称含「学习」的 ${learnCards.length} 张）` });
    continue;
  }
  return { findings, stats };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const anchors = { "7.1": extractSegmentAnchor("7.1"), "7.2": extractSegmentAnchor("7.2"), "7.3": extractSegmentAnchor("7.3") };
const anchorOk = Object.values(anchors).every(Boolean);

let all = loadSessions();
if (CWD_FILTER) {
  // 路径归一化（2026-09-24 全盘压测 B11 修复）：Windows 上会话头记录反斜杠，而调用方
  // 常写正斜杠（`--cwd D:/x/y`）——旧实现只做小写化与去尾斜杠，正斜杠输入会
  // **匹配到 0 个会话**，脚本随即输出「违规 0 条」= 一次静默假通过。
  const normCwd = (v) => String(v ?? "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  const want = normCwd(CWD_FILTER);
  all = all.filter((s) => normCwd(s.cwd) === want);
  if (all.length === 0) {
    // 范围为空必须**响亮失败**，不得静默全绿（下游会把 exit 0 读成"合规"）
    console.error(`✖ 审计范围为空：--cwd "${CWD_FILTER}" 未匹配到任何会话（归一化分隔符后仍为空）。`);
    console.error("  可能原因：路径写错 / 该工作区确实没有 harness 会话 / 会话日志根不对（--sessions-dir）。");
    console.error("  按纪律：空范围不得当作「合规」——已以退出码 3 结束。");
    process.exit(3);
  }
}
if (ROOT_FILTER) {
  const byId = new Map(all.map((s) => [s.id, s]));
  const keep = new Set([ROOT_FILTER]);
  let grew = true;
  while (grew) { grew = false; for (const s of all) if (s.parent && keep.has(s.parent) && !keep.has(s.id)) { keep.add(s.id); grew = true; } }
  all = all.filter((s) => keep.has(s.id));
}
// 预设过滤：显式给了 --cwd/--root 时不过滤（根的 preset 可能是 cordis/standard，
// 但子树是 harness——按 preset 过滤会把根会话误删，2026-09-23 实测踩到）；
// 无过滤条件时才默认只看 harness 会话（避免扫全库噪音）。
const harnessOnly = (CWD_FILTER || ROOT_FILTER)
  ? all
  : all.filter((s) => {
    const head = s.events.find((e) => e.type === "session");
    return !head?.agentPreset || head.agentPreset === "harness";
  });
const roots = harnessOnly.filter((s) => (s.depth ?? 0) === 0);
const byRole = { 0: harnessOnly.filter((s) => s.depth === 0).length, 1: harnessOnly.filter((s) => s.depth === 1).length, 2: harnessOnly.filter((s) => (s.depth ?? 0) >= 2).length };

const r = {};
if (anchorOk) {
  const { findings: f16, stats: s16, attackBySession } = checkR1_R6(harnessOnly, anchors);
  const { findings: f3, stats: s3 } = checkR3(harnessOnly);
  const { findings: f4, stats: s4 } = checkR4(harnessOnly);
  const { findings: f5, stats: s5 } = checkR5(harnessOnly);
  const { findings: f7, stats: s7 } = checkR7(harnessOnly, attackBySession);
  const { findings: f8, stats: s8 } = checkR8(harnessOnly);
  // R10 的扫描根：显式 --cwd 优先；否则——若给了 --sessions-dir（自测夹具），**不扫文件**（夹具无 runs/，
  //   且默认扫工作区会把真实无关闭题的 R10 混进每个合成用例）；两者都无 → 默认工作区。
  const r10Root = CWD_FILTER ? CWD_FILTER : (arg("--sessions-dir") ? null : WS_DEFAULT);
  const { findings: f10, stats: s10 } = checkR10(r10Root);
  const allFindings = [...f16, ...f3, ...f4, ...f5, ...f7, ...f8, ...f10].sort((a, b) => (a.rule < b.rule ? -1 : 1));
  r.anchors = s16; r.r3 = s3; r.r4 = s4; r.r5 = s5; r.r7 = s7; r.r8 = s8; r.r10 = s10; r.findings = allFindings;
} else {
  r.findings = [{ rule: "ANCHOR", sev: "高", sid: "-", seq: 0, detail: `无法从 SKILL.md 提取判据段（路径 ${SKILL_PATH}）`, evidence: "判据同源失败——请检查 SKILL.md 路径" }];
}


// ── R10 弱检：押题清单（ground truth）锁定人不得为被测链主代理（2026-09-25 立）────────────
// 立论：攻击报告 C6（确凿）——`runs/run-20260827-1/押题清单.md` 自陈「锁定人：主代理」，且该目录同时是
//   被测产物输出目录，押题内容多条是测试提示词原文的复述 → 押题退化为「查 AI 有没有读提示词」，独立性=0。
// 本检查只做**弱检**：扫 <cwd>/runs/**/押题清单*.md 里的「锁定人」字段，命中「主代理」即报。
// 边界（诚实声明）：① 无「锁定人」字段的清单（老格式）不报——零命中 ≠ 已独立；
//   ② 锁定人字段可能被改写措辞绕过；③ 只扫 runs/ 一层之下的押题清单，不含自定义路径。
function checkR10(cwd) {
  const findings = [];
  let scanned = 0, withField = 0;
  if (!cwd || !existsSync(cwd)) return { findings, stats: { scanned, withField, flagged: 0 } };
  const runsDir = join(cwd, "runs");
  let dirs = [];
  try { dirs = readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(runsDir, d.name)); } catch { return { findings, stats: { scanned, withField, flagged: 0 } }; }
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && /押题清单.*\.md$/.test(f.name)).map((f) => join(dir, f.name)); } catch { continue; }
    for (const fp of files) {
      scanned += 1;
      let txt = "";
      try { txt = readFileSync(fp, "utf8"); } catch { continue; }
      const m = txt.match(/锁定人\s*[:：=]\s*([^\n｜|]{1,40})/);
      if (!m) continue;
      withField += 1;
      const who = m[1].trim();
      if (/主代理|主控|被测|执行侧/.test(who)) {
        findings.push({ rule: "R10", sev: "中", sid: "-", seq: 0,
          detail: `押题清单的锁定人是「${who}」——ground truth 不独立（攻击报告 C6）：押题不得由被测链自锁，否则易退化为「查 AI 有没有读提示词」`,
          evidence: fp.replace(cwd, "<cwd>") });
      }
    }
  }
  return { findings, stats: { scanned, withField, flagged: findings.length } };
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const violated = new Set(r.findings.map((f) => f.rule));
if (AS_JSON) {
  console.log(JSON.stringify({ sessions: { total: harnessOnly.length, roots: roots.length, byRole }, ...r }, null, 1));
} else {
  console.log("═══ 驾驭工程 · run 后合规审计 ═══");
  console.log(`判据来源：${SKILL_PATH}`);
  console.log(`甲乙丙段锚点：${anchorOk ? "已提取（首句/尾句各一）" : "提取失败"}`);
  console.log(`审计范围：${harnessOnly.length} 个会话（根 ${byRole[0]} / 主控 ${byRole[1]} / 孙代 ${byRole[2]}）${CWD_FILTER ? `  cwd=${CWD_FILTER}` : ""}${ROOT_FILTER ? `  root=${ROOT_FILTER.slice(0, 16)}` : ""}`);
  if (r.anchors) console.log(`派发统计：派发调用 ${r.anchors.subagentCalls}（→主控 ${r.anchors.toController} / →孙代 ${r.anchors.toWorker}）｜其中 fork ${r.anchors.forks}｜攻击审计 ${r.anchors.attackCalls}｜**被硬门禁当场拦下 ${r.anchors.blocked}（未派发，不计违规）**`);
  if (r.anchors && r.anchors.toController > 0) console.log(`派主控质量：上限下达行合规 ${r.anchors.withCapLine}/${r.anchors.toController}｜乙段整段逐字 ${r.anchors.controllerVerbatim}/${r.anchors.toController}`);
  if (r.r3) console.log(`提问纪律：ask_user_question ${r.r3.askCalls} 次｜正文夹带选项化提问 ${r.r3.embeddedAsks} 处（${r.r3.sessionsWithEmbedded} 个会话）`);
  if (r.r5) console.log(`消息统计：send_message ${r.r5.msgCalls} 次（孙代发起 ${r.r5.fromWorker}）`);
  if (r.r7) console.log(`高风险弱检：三层在跑的树 ${r.r7.trees} 棵｜其中正文有高风险信号 ${r.r7.treesWithSignal} 棵、有甲段派发 ${r.r7.treesWithAudit} 棵`);
  if (r.r8) console.log(`探索维度化弱检：探索段会话 ${r.r8.exploreSessions} 个｜其中 worker 派发 ${r.r8.workerDispatches} 张卡、零维度卡 ${r.r8.noDimCards} 个会话、报警 ${r.r8.flagged} 个`);
  if (r.r10) console.log(`押题清单弱检（R10）：扫描 ${r.r10.scanned} 份清单｜其中含「锁定人」字段 ${r.r10.withField} 份、被测方自锁报警 ${r.r10.flagged} 份`);
  console.log("");
  const order = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "ANCHOR"];
  const ruleName = { R1: "丙段逐字附带", R2: "甲段整段发出", R3: "提问纪律（ask_user_question）", R4: "停用线不得自行恢复", R5: "不越级上报", R6: "上限下达行", R7: "高风险命中即派独立审计（弱检·供人工复核）", R8: "探索未维度化（弱检·供人工复核）", R9: "派主控逐字附带乙段（§7.2）", R10: "押题清单锁定人独立（弱检·供人工复核）", ANCHOR: "判据提取" };
  for (const rule of order) {
    const fs = r.findings.filter((f) => f.rule === rule);
    let agg = "";
    if (rule === "R1" && r.anchors && r.anchors.toWorker > 0) agg = `（合规 ${r.anchors.withBing}/${r.anchors.toWorker} 张卡）`;
    if (rule === "R6" && r.anchors && r.anchors.toController > 0) agg = `（合规 ${r.anchors.withCapLine}/${r.anchors.toController} 次）`;
    if (rule === "R2" && r.anchors && r.anchors.attackCalls > 0) agg = `（合规 ${r.anchors.attackWithList}/${r.anchors.attackCalls} 次）`;
    if (!fs.length) { console.log(`[PASS] ${rule} ${ruleName[rule]}${agg}：未发现违规`); continue; }
    console.log(`[FAIL] ${rule} ${ruleName[rule]}${agg}：${fs.length} 条`);
    for (const f of fs.slice(0, VERBOSE ? 999 : 3)) console.log(`       · ${f.detail}${f.evidence ? ` ｜ ${f.evidence}` : ""}`);
    if (!VERBOSE && fs.length > 3) console.log(`       · …另有 ${fs.length - 3} 条（--verbose 看全部）`);
  }
  const failRules = order.filter((x) => violated.has(x));
  console.log("");
  console.log(`SUMMARY: 违规规则 ${failRules.length} 条${failRules.length ? `（${failRules.join("、")}）` : ""}｜违规条目 ${r.findings.length} 条`);
  console.log("说明：本脚本覆盖攻击报告附录 B2 表中可机检的 6 条 + 弱检 3 条（R7 高风险派审计、R8 探索维度化、R10 押题锁定人独立）" +
    " + E2E 实测新增 1 条（R9 派主控逐字附带乙段）；" +
    "另有「一卡一交付物 / 鲁棒性不自行消化」两条只能字段化——不在此脚本范围，勿据本输出推断「其余全合规」。" +
    "【2026-10-01 起】工具级门禁已取消（v2.0 纯提示词工程版，用户拍板）：R1/R9 等形式类条款的违规数现在是「自律执行率」的读数——约束在 SKILL §10.9.0，检测在本脚本，两者合起来替代旧拦截层。");
}
process.exit(violated.size);
