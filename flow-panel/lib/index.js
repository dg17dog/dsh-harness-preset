// dsh-harness-flow · Host 半
// 驾驭工程代理树面板：会话级状态 + loopback HTTP 通道 + 模型工具 harness_flow
// + **每轮系统上下文注入**（systemPrompt.variable provider 每轮 pre-step 以 {agent} 求值，
//   面板状态真实进入模型上下文——不是花架子）。
// 零 npm 依赖（仅 node: 内建）；工具用 ctx.tools.register 的 raw JSON-Schema 形态注册。
// 面板门禁在 Client 半按 projectionValues.agentPreset === "harness" 判定。
// B17（2026-09-25）：**工具一路门禁此前缺失**——ctx.tools.register 无条件注册，标准模式会话照样
//   拿到 harness_flow，而它的 description 自称「仅驾驭工程模式会话使用」，导致模型把「工具存在」
//   误读为「模式存在」并自行走判型 + 开局五问（实测事故：session-2e8634bc）。现补两道：
//   makeToolGuards 的「预设门禁」条（主）+ makeTool.execute 的 fail-closed 兜底；两者与下方
//   systemPrompt.variable 注入门禁同源（composedPresetOf，读 live scope chain）。

import { appendFile, mkdir, readFile, rename, unlink, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const name = "dsh-harness-flow";
const inject = ["webServer", "tools", "systemPrompt"];  // B16：agentPresets 故意**不**进 inject——声明它会触发 cordis-plugin-loader 的 typert 装配（zod .volatile 在捆绑版缺失）连带降级 @linxin666 两个 client-ui 插件；改为运行时 ctx.get 静默探测（核心服务无需声明亦可 get）

// ── 阶段主线（「当前阶段」行用） ────────────────────────────────────────────
const NODES = [
  { id: "intent", label: "① 意图理解" },
  { id: "explore", label: "② 目标探索" },
  { id: "typing", label: "③ 判型" },
  { id: "charter", label: "④ 立项条款" },
  { id: "attack", label: "⑤ 攻击/审计" },
  { id: "release", label: "⑥ 用户放行 · 冻结" },
  { id: "execute", label: "⑦ 发卡执行" },
  { id: "review", label: "⑧ 内容验收" },
  { id: "audit", label: "⑨ 高风险审计" },
  { id: "deliver", label: "⑩ 交付 · 自证" }
];
const NODE_IDS = NODES.map((n) => n.id);
// 开局五问缺项清单：供 directive 与每轮注入点名，逼模型把用户已确认的项落账
function missingFiveAsk(st) {
  const miss = [];
  if (st.judge === "unset") miss.push("①任务性质未定稿（set_judge；用户已在对话点选/确认可直接定稿）");
  if (st.modeConfirmed !== "confirmed") miss.push("②工作模式未确认（用户在对话确认了所选模式→立即 set_triage(modeConfirmed=confirmed) 补写，不要再追问一遍）");
  if (st.askPolicy === "unset") miss.push("③项目相关提问授权未答");
  if (st.learnNeed === "unset") miss.push("④学习需求未答");
  if (st.goalConfirmed !== "confirmed") miss.push(st.conversationGoal !== ""
    ? "⑤目标确认未落账（对话目标已写入但未确认——若用户已在对话确认「对吗？」，立即 set_triage(goalConfirm=confirmed) 补写，禁止重复追问）"
    : "⑤目标未复述（先 set_goal 写 conversationGoal，再问用户「对吗？」）");
  return miss;
}
const nodeLabel = (id) => NODES.find((n) => n.id === id)?.label ?? id;
const judgeName = (j) => j === "engineering" ? "工程模式" : j === "exploration" ? "探索模式" : j === "compound" ? "复合模式" : "未定";

// ── 工作模式旋钮 + 依赖规则引擎（与 Client 半同源） ─────────────────────────
// judge：判型（开局必做）——unset/engineering/exploration。
// layering：编排——three=三层（主代理→主控→孙）；two=两层（父审核子：主代理直接管理孙并验收）；one=一层（主代理亲自执行）。
// attackGate：攻击代理（独立子代理·主代理左侧）——on=开启（派发条款→补充条款）；skip=关闭。简约（一层）不显示。
// auditGate：审计代理（独立子代理·高危审计·主代理右侧）——on=开启（转发子代理内容→提交审计报告，不做修改）；skip=关闭。
// releaseGate：放行——user=需用户审核；auto=免审全自动（等同自主模式声明）。
// reworkMode：返工策略（仅子层存在时有效）——loop=循环打回直至通过；limited=最多打回 reworkMax 次，超限带缺陷报告上报；report=不打回，单次机会直接带缺陷报告上报。
const TREE_FIELDS = {
  judge: ["unset", "engineering", "exploration", "compound"],
  layering: ["three", "two", "one"],
  attackGate: ["on", "skip"],
  auditGate: ["on", "skip"],
  // 探索段独立开关（2026-09-23 用户要求「复合模式中探索和工程部分的攻击/审计代理不能统一，本质要分开」）：
  // attackGate/auditGate = **工程段**（含纯工程模式）；explore* = **探索段**（含纯探索模式）。
  // 复合模式下两段各自独立可调；非复合模式按判型取对应一组（见 effectiveEdges）。
  exploreAttackGate: ["on", "skip"],
  exploreAuditGate: ["on", "skip"],
  releaseGate: ["user", "auto"],
  reworkMode: ["loop", "limited", "report"],
  askPolicy: ["unset", "unlimited95", "limited", "noAsk"],
  learnNeed: ["unset", "A", "B", "C", "D"],
  missingPolicy: ["unset", "A", "B", "C"],
  compoundPhase: ["explore", "engineering"],
  triageAsked: ["unset", "asked"],
  goalConfirmed: ["unset", "confirmed"],
  modeConfirmed: ["unset", "confirmed"],
  reviewSheet: ["on", "off"],
  outputStyle: ["minimal", "normal", "free"],
  // assistLevel：辅助程度——主代理对用户主张的默认态度。challenge=质疑（默认：用户主张先当假设，需证据才采纳）；trust=默认用户正确。
  assistLevel: ["challenge", "trust"],
  // cardCap：执行卡上限（三层/两层编排下主控在一次任务里可自行派发的孙代理卡数上限）；"none"=不限。
  // 默认 "4"——实测「数理统计复习网页」一案主控自定 13 张卡（37M input tokens / 174 分钟）。
  cardCap: ["2", "4", "6", "8", "none"],
  // freezeForQuestion：提问冻结旗（2026-09-19 用户要求）——模型提出需用户答复的问题时置 frozen，
  // 冻结期间禁止下发与该问题口径相关的指令（派子代理/发卡/落盘/推进阶段）。用户答复后清除。
  // （2026-10-01 v0.15.0：G1–G5 工具级门禁取消——冻结旗保留为状态同步与面板展示，不再拦截派发）
  freezeForQuestion: ["clear", "frozen"]
};
const TREE_FIELD_LOG = {
  judge: { engineering: "判型→工程模式", exploration: "判型→探索模式", compound: "判型→复合模式（先探索再驾驭）" },
  layering: { three: "编排→三层（主代理→主控→孙）", two: "编排→两层（父审核子：主代理直接管理孙代理并验收）", one: "编排→一层（主代理亲自执行，无子代理）" },
  attackGate: { on: "攻击代理→开启（独立子代理：派发条款，回收补充条款）", skip: "攻击代理→关闭" },
  auditGate: { on: "审计代理→开启（独立子代理·高危审计：转发子代理内容，回收审计报告，不做修改）", skip: "审计代理→关闭" },
  exploreAttackGate: { on: "探索段攻击代理→开启（探索阶段独立）", skip: "探索段攻击代理→关闭" },
  exploreAuditGate: { on: "探索段审计代理→开启（探索阶段独立）", skip: "探索段审计代理→关闭" },
  releaseGate: { user: "放行→需用户审核", auto: "放行→免审全自动（用户审核权全部交由主代理：判型/工作模式/条款放行均由主代理判断并留痕）" },
  reworkMode: { loop: "返工→循环打回直至通过", limited: "返工→限次打回（超限带缺陷报告上报）", report: "返工→不打回，直接带缺陷报告上报" },
  askPolicy: { unlimited95: "提问授权→无限提问直至完全理解用户需求（内置 95% 置信度；探索模式下不得以提问代替自身探索）", limited: "提问授权→只允许有限度的提问", noAsk: "提问授权→不开启额外提问", unset: "提问授权→取消选择" },
  goalConfirmed: { confirmed: "对话临时目标→用户已确认复述正确" },
  modeConfirmed: { confirmed: "工作模式→用户已确认（开局五问②）" },
  learnNeed: { A: "学习需求→A：电脑中已有可学习能力", B: "学习需求→B：无装载，自己去补齐能力缺口（查工具/库/现成方案）", C: "学习需求→C：用户不清楚，代理自查", D: "学习需求→D：用户补充", unset: "学习需求→取消选择" },
  missingPolicy: { A: "关键信息缺失→A：尝试自己寻找/推理（做不到降级为留空）", B: "关键信息缺失→B：留空", C: "关键信息缺失→C：编造（风险自担）", unset: "关键信息缺失→取消选择（未设默认 A）" },
  compoundPhase: { explore: "复合模式→回到探索阶段", engineering: "复合模式→进入驾驭阶段（放行探索结果）" },
  triageAsked: { asked: "任务问询→已完成" },
  reviewSheet: { on: "审查记录→开启（孙代理完工必须填自检表，主控按表核签，不全量重读）", off: "审查记录→关闭（主控全量重读验收）" },
  outputStyle: { minimal: "输出风格→极简（汇报只留骨干，复杂结果大白话翻译，只留成果与决策要素）", normal: "输出风格→普通（不赘述，复杂结果大白话翻译，只留成果与决策要素）", free: "输出风格→无约束（模型自行稍减输出）" },
  assistLevel: { challenge: "辅助程度→质疑（用户主张默认存疑，需证据才采纳）", trust: "辅助程度→默认用户正确（按用户所述执行，仅在握有硬证据时才提示分歧）" },
  freezeForQuestion: { frozen: "提问冻结→开启（问题未答复前，禁止下发口径相关指令）", clear: "提问冻结→解除" },
  cardCap: { "2": "执行卡上限→2 张", "4": "执行卡上限→4 张", "6": "执行卡上限→6 张", "8": "执行卡上限→8 张", none: "执行卡上限→不限（主控自行拆分，成本自负）" }
};
// 三档预设（判型不属预设——开局必做；攻击/审计为独立子代理，简约=一层不显示）
const PRESETS = [
  { id: "simple", label: "简约", combo: { layering: "one", attackGate: "skip", auditGate: "skip", exploreAttackGate: "skip", exploreAuditGate: "skip", releaseGate: "user", reworkMode: "report" } },
  { id: "standard", label: "一般", combo: { layering: "three", attackGate: "skip", auditGate: "skip", exploreAttackGate: "skip", exploreAuditGate: "skip", releaseGate: "user", reworkMode: "loop" } },
  { id: "full", label: "复杂", combo: { layering: "three", attackGate: "on", auditGate: "on", exploreAttackGate: "on", exploreAuditGate: "on", releaseGate: "user", reworkMode: "loop" } }
];
const PRESET_IDS = PRESETS.map((p) => p.id);

// 依赖规则引擎：哪些线活着（上层线被切断 → 下层循环线失效）
function effectiveEdges(st) {
  const childLayer = st.layering !== "one";                       // 子层（主控下的孙代理层）存在
  const masterLayer = st.layering === "three";                    // 主控层存在
  // 段归属（2026-09-23）：探索阶段用 explore* 开关，工程阶段用 attackGate/auditGate。
  // 复合模式按 compoundPhase 切换；纯探索/纯工程固定取各自那组。
  const inExplore = st.judge === "exploration" || (st.judge === "compound" && st.compoundPhase !== "engineering");
  const attackOn = inExplore ? st.exploreAttackGate === "on" : st.attackGate === "on";
  const auditOn = inExplore ? st.exploreAuditGate === "on" : st.auditGate === "on";
  return {
    masterLayer,
    childLayer,
    segment: inExplore ? "explore" : "engineer",
    parentReview: st.layering === "two",                          // 二层结构：父审核子
    attackAgent: childLayer && attackOn,                          // 攻击代理线（无子层即无意义；简约不显示）
    auditAgent: childLayer && auditOn,                            // 审计代理线（独立子代理·高危审计）
    releaseLine: true,                                            // 放行线恒在（取值可 auto）
    reworkLine: childLayer,                                       // 返工循环线需子层存在
    reworkWho: st.layering === "three" ? "孙→主控（主控打回孙代理）" : st.layering === "two" ? "子代理→主代理（父审核子，打回）" : null,
    reworkPolicy: childLayer ? st.reworkMode : null,
    reworkMax: childLayer && st.reworkMode === "limited" ? st.reworkMax : null
  };
}

// ── 预估倍率（结构性估算；用户 2026-09-19 裁定口径） ────────────────────────
// 基准：全局简约工作流（一层主代理单干、无攻击/审计、无学习、无返工）= 1.0×。
// 成本主因 = 轮次 × 每轮上下文重发（本会话实测：仅 2 次工具调用的一轮也耗 144K tok，上下文主导）。
// 判型分档：
//  · 工程模式 = 收敛执行：主代理统筹 → 主控 → 执行卡×N →（攻击/审计/返工/重读按旋钮）
//    N = 执行卡上限卡值（cardCap 旋钮，默认 4）；"none"=不限 → 按 8 张保守估（面板会标注「未设上限」）。
//    口径裁定（用户 2026-09-19）：按上限值估算——宁可高估也不低估。实测「数理统计复习网页」一案主控自定
//    13 张卡（37M input tokens / 174 分钟），而按名义 2 张估只有 2.67×，严重误导用户。
//  · 探索模式 = 宽度优先：主代理给初始维度 → 子代理扩展维度 → 孙代理逐维调查（名义 4 个维度）
//    探索产出是方向/思路（不落地实施），与工程执行不是同一件事，倍率因此与工程不同档。
//  · 复合模式 = 探索段 + 工程段（先探索再驾驭，两段都要做）→ 相加。
// 输出风格不进模型（各模式都同一风格，倍率相同 → 不参与）；辅助程度不进模型（不改变工作量，只改态度）。
// 学习子代理只计一次。
const EST_W = {
  master: { tok: 6, time: 6 },          // 一层主代理单干（1.0× 基准）
  masterUp: { tok: 3, time: 3 },        // 有子层时主代理统筹 / 给初步方向
  control: { tok: 3.5, time: 3 },       // 主控层（工程）/ 细化层（探索）
  card: { tok: 3.5, time: 4 },          // 工程执行卡（张数=cardCap，见 EST_K）
  exploreDir: { tok: 2.5, time: 3 },    // 探索方向卡（名义 D=4 个方向）
  attack: { tok: 2.5, time: 2 },        // 攻击代理（一次性）
  audit: { tok: 3, time: 2.5 },         // 审计代理（高危审计）
  learn: { tok: 4, time: 5 },           // 学习子代理（补齐能力缺口，只计一次）
  reread: { tok: 2, time: 1 },          // 审查记录关=全量重读（开=省）
  reworkLoop: { tok: 2.5, time: 3.5 },  // 循环返工期望成本
  reworkPer: { tok: 0.75, time: 1.1 }   // 限次返工每次
};
const EST_BASE = EST_W.master;      // 全局简约工作流 = 1.0×
const EST_D = 4;                    // 探索：名义方向数
const CARD_CAP_UNLIMITED = 8;       // cardCap="none"（不限）时的保守估值
// 执行卡张数：由 cardCap 旋钮派生（"none" → 保守 8 张）；一层编排本就不派卡，值无意义
function estCardCount(st) {
  const raw = st?.cardCap;
  if (raw === "none") return CARD_CAP_UNLIMITED;
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}
function estAdd(acc, w, label) {
  acc.tok += w.tok; acc.time += w.time;
  if (label) acc.parts.push(label);
}
function estEngineering(st) {
  const e = effectiveEdges(st);
  const acc = { tok: 0, time: 0, parts: [] };
  if (st.layering === "one") estAdd(acc, EST_W.master, "一层主代理");
  else {
    const K = estCardCount(st);
    const capNote = st?.cardCap === "none" ? `（未设上限，按 ${K} 保守估）` : "";
    estAdd(acc, EST_W.masterUp, "主代理统筹");
    if (e.masterLayer) estAdd(acc, EST_W.control, "主控层");
    estAdd(acc, { tok: EST_W.card.tok * K, time: EST_W.card.time * K }, `执行卡×${K}${capNote}`);
  }
  if (e.attackAgent) estAdd(acc, EST_W.attack, "攻击代理");
  if (e.auditAgent) estAdd(acc, EST_W.audit, "审计代理");
  if (e.reworkLine && st.reviewSheet === "off") estAdd(acc, EST_W.reread, "全量重读");
  if (e.reworkLine) {
    if (st.reworkMode === "loop") estAdd(acc, EST_W.reworkLoop, "循环返工(期望)");
    else if (st.reworkMode === "limited") estAdd(acc, { tok: EST_W.reworkPer.tok * st.reworkMax, time: EST_W.reworkPer.time * st.reworkMax }, `限次返工×${st.reworkMax}`);
  }
  return acc;
}
function estExploration(st) {
  const e = effectiveEdges(st);
  const acc = { tok: 0, time: 0, parts: [] };
  if (st.layering === "one") estAdd(acc, EST_W.master, "主代理单干探方向");
  else {
    estAdd(acc, EST_W.masterUp, "主代理给初步方向");
    if (e.masterLayer) estAdd(acc, EST_W.control, "子代理细化");
  }
  estAdd(acc, { tok: EST_W.exploreDir.tok * EST_D, time: EST_W.exploreDir.time * EST_D }, `探索维度×${EST_D}`);
  // 攻击/审计代理属工程段的一次性角色——只计一次（复合模式两段相加时不重复计数）
  return acc;
}
function estimate(st) {
  const acc = { tok: 0, time: 0, parts: [] };
  if (st.judge === "compound") {
    const ex = estExploration(st);
    const en = estEngineering(st);
    acc.tok = ex.tok + en.tok; acc.time = ex.time + en.time;
    acc.parts = ["探索段", ...ex.parts, "工程段", ...en.parts];
  } else if (st.judge === "exploration") {
    const ex = estExploration(st);
    acc.tok = ex.tok; acc.time = ex.time; acc.parts = ex.parts.slice();
  } else {
    const en = estEngineering(st);
    acc.tok = en.tok; acc.time = en.time; acc.parts = en.parts.slice();
  }
  if (st.learnNeed === "B") estAdd(acc, EST_W.learn, "学习子代理");
  const round1 = (v) => Math.round(v * 100) / 100;
  return {
    tokenX: round1(acc.tok / EST_BASE.tok),
    timeX: round1(acc.time / EST_BASE.time),
    parts: acc.parts,
    parts: acc.parts,
    note: `结构估算（基准=全局简约工作流 1.0×；判型分档：工程=收敛执行、卡数按执行卡上限 / 探索=宽度优先名义 4 维度 / 复合=探索段+工程段相加${st?.cardCap === "none" ? "；执行卡上限为「不限」，按 8 张保守估" : ""}；学习子代理只计一次；输出风格与辅助程度不参与）`,
    // 结构分解（用户悬停可见，也可用于机检「卡数按上限计」）
    estSummary: acc.parts.join(" + ")
  };
}

// directive：给模型的效力说明（依赖规则感知；2026-09-19 v0.10.2 重建——修「误删致工具抛错/注入静默失效」）
function buildDirective(st) {
  const e = effectiveEdges(st);
  const parts = [];
  parts.push(st.layering === "three" ? "三层编排（主代理→主控→孙代理，主控建 goal/看板/分工后派孙）"
    : st.layering === "two" ? "两层编排（父审核子：你直接管理子代理并亲自验收其工作，不设主控层）"
    : "一层编排（简约：你亲自执行全部工作，包括设计/图形/UI 类工作，不派任何子代理）——模式切换即时生效：在途子代理完成当前任务卡后停止，不再派发新卡；停用线不再使用");
  // 攻击/审计：按当前段取开关（2026-09-23 拆分四开关后，明确告诉模型作用于哪一段）
  const segName = e.segment === "explore" ? "探索段" : "工程段";
  parts.push(e.attackAgent ? `攻击代理开启【${segName}】（独立子代理·**仅主代理派出**）：**派发子代理工作之前**先攻「初步维度/条款草案」（甲段），意见采纳修订后再派发——先攻后派；主控/孙代理不得代派（§11 时序与归属）` : `攻击代理关闭【${segName}】（不派攻击代理）`);
  parts.push(e.auditAgent ? `审计代理开启【${segName}】（独立子代理·高危审计·**仅主代理派出**）：**子代理提交之后**由你转发成果做独立审计（甲段四件），报告只回主代理；主控/孙代理不得代派（§11 时序与归属）` : `审计代理关闭【${segName}】（不派审计代理）`);
  if (true) {
    const ex = Array.isArray(st.gateExplicit) ? st.gateExplicit : [];
    const off = GATE_FIELDS.filter((f) => st[f] === "skip" || (f === "releaseGate" && st[f] === "user"));
    const eo = off.filter((f) => ex.includes(f)), dOff = off.filter((f) => !ex.includes(f));
    if (off.length) parts.push(`门控关闭来源：用户明示=[${eo.join("、") || "无"}]（不得自恢复，确需必上报）｜默认预设=[${dOff.join("、") || "无"}]（确需可留痕自行启用并申报）——见 SKILL §10.9.1`);
  }
  // （2026-10-01 v0.15.0：门禁强度播报随 G1–G5 取消一并移除——约束改由提示词自律 + 合规审计事后记账）
  if (st.judge === "compound") parts.push(`复合模式两段开关（各自独立）：探索段 攻击=${st.exploreAttackGate === "on" ? "开" : "关"}／审计=${st.exploreAuditGate === "on" ? "开" : "关"}；工程段 攻击=${st.attackGate === "on" ? "开" : "关"}／审计=${st.auditGate === "on" ? "开" : "关"}`);
  parts.push(st.releaseGate === "auto" ? "免审全自动：用户审核权全部交由主代理——判型、工作模式、条款放行均由你判断并写入面板留痕，无需等用户确认" : "用户放行关卡生效：条款/探索方针必须等用户审核放行");
  if (e.reworkLine) {
    if (st.reworkMode === "loop") parts.push(`返工策略（${e.reworkWho}）：循环打回直至验收通过，不设次数上限`);
    else if (st.reworkMode === "limited") parts.push(`返工策略（${e.reworkWho}）：同一问题最多打回 ${st.reworkMax} 次，超限必须带缺陷报告逐级上报`);
    else parts.push(`返工策略（${e.reworkWho}）：不打回——子代理单次交付后直接带缺陷报告上报，由上级裁定`);
  } else parts.push("返工循环线停用（无子层，主代理自查交付）");
  if (st.judge === "unset" && st.judgeProposal) parts.push(`判型建议=${judgeName(st.judgeProposal)}（理由：${st.judgeReason}）——待用户确认，确认后定稿；用户未确认前不要开工${st.releaseGate === "auto" ? "；但全自动已开启——判型由你自行定稿并留痕，不必等用户" : ""}`);
  else if (st.judge === "unset") parts.push(`判型未定：澄清需求后用 set_judge(propose=true) 给出判型建议与人话理由，用户确认后定稿${st.releaseGate === "auto" ? "；但全自动已开启——判型由你自行定稿并留痕" : ""}`);
  else parts.push(st.judge === "exploration" ? "判型=探索模式（定稿）：产出=尽可能探索所有可能方向（给用户思路/方向即可，不落地实施；要实际工作转复合模式）；工作流=用户发要求→你给初步维度→子代理扩展维度（每个新增维度须写理由）后再派孙代理→孙代理逐维调查值并留证据（维度≈边界条件，漏一维=漏一类边界条件）；子代理向你汇报=整合孙代理成果后汇报；探索契约替代规格（含维度清单表：初始/扩展+理由/每维值与证据/负发现），验收后置；学习卡不得充当探索卡"
    : st.judge === "compound" ? `判型=复合模式（定稿）：先探索再驾驭，当前阶段=${st.compoundPhase === "engineering" ? "工程模式（用户已放行探索结果）——按工程模式三层执行" : "探索——按探索工作流展开（你给初步维度→子代理扩展维度后再派孙代理→孙代理逐维调查值），用户放行探索结果后面板进入工程阶段"}`
    : "判型=工程模式（定稿）：主代理→子代理「下发条款」；执行中发现验收标准立不住→冻结当前工作并上报转探索");
  // 工作模式（开局五问②）：AI 推荐 → 用户确认
  {
    const derived = deriveCombo(st);
    if (st.modeConfirmed === "confirmed") parts.push(`工作模式=${derived.pathLabel}（用户已确认）`);
    else if (st.modeProposal !== "") parts.push(`工作模式建议=${PRESETS.find((p) => p.id === st.modeProposal)?.label ?? st.modeProposal}（理由：${st.modeReason || "未附"}）——待用户确认后再开工`);
    else parts.push("工作模式未确认：先 set_recommend 给出推荐（结合判型与任务复杂度：简单/设计图形UI→simple；一般任务→standard；复杂工程级→full），用户确认后 set_triage(modeConfirmed=confirmed)");
  }
  parts.push("任务执行中用户提问：先由你判断——只需了解进度、澄清概念的直接回答即可（不派子代理、不为一句提问启动立项/发卡流程）；确需实际工作（查证、改动、产出物）才按当前工作模式委派。工作模式约束的是「干活」的执行结构，不约束你直接回答问题——模式不要太死板");
  {
    const est = estimate(st);
    parts.push(`预估消耗：token ×${est.tokenX}｜时间 ×${est.timeX}（${est.note}）`);
  }
  parts.push(st.missingPolicy === "B" ? "关键信息缺失处理=留空（缺就留空，不得编造）" : st.missingPolicy === "C" ? "关键信息缺失处理=编造（用户已授权：缺失信息可编造补齐，风险自担）" : "关键信息缺失处理=尝试自己寻找/推理（做不到降级为留空；默认口径）");
  // 辅助程度（用户 2026-09-19 新增）：主代理对用户主张的默认态度。默认质疑。
  parts.push(st.assistLevel === "trust"
    ? "辅助程度=默认用户正确：用户的陈述、判断、给的口径一律照办，不得主动质疑或替用户改口径；仅当你握有硬证据（实测数据/可复现反例/文件物证）证明用户有误且不纠正会导致返工级后果时，才提示一次分歧并给出证据，用户坚持则照办并在交付注明"
    : "辅助程度=质疑（默认，必须执行）：用户的主张默认按假设处理——涉及事实、数据、口径、可行性、验收标准的用户陈述，不得直接当既定前提写进条款与产物；你必须先自查（能查的查、能测的测），把「已核实」「与事实不符」「无法核实」三类结论写进立项条款或交付说明；与已知事实冲突时当场指出并给依据，不得顺着用户说；对目标模糊、验收立不住、范围自相矛盾的情形主动提出质疑。但质疑不等于抬杠：用户已明确拍板的偏好与产品决策照办，不得反复纠缠");
  // 执行卡上限（用户 2026-09-19 新增）：抑制孙代理扇出致成本爆炸
  if (st.layering !== "one") {
    const cap = st.cardCap;
    parts.push(cap === "none"
      ? "执行卡上限=不限（用户明示）：卡数与拆分维度由主控自定，但必须在开工时把预计卡数写进分工表并计入成本声明；实测暂无上限的同类任务曾达 13 张卡（约 3700 万 input tokens / 174 分钟），请据此自控"
      : `执行卡上限=${cap} 张（硬约束）：本次任务主控自行派发的孙代理卡数不得超过 ${cap} 张；需要更多卡时必须先冻结当前工作、逐级上报（说明为什么要超、每张卡做什么、预计成本），由用户裁定，不得自行超发。一卡 = 一个可独立验收的交付物，禁止按知识点/章节/文件把同一件事切碎成多卡；返工卡不重复计数`);
  }
  if (st.triageAsked !== "asked") {
    parts.push("开局问询未完成（未答不能开工）：分两轮，第一轮只问五个必须问题，每个都先给 AI 推荐再由用户确认或改——①任务性质（判型：set_judge(propose=true) 给建议）②工作模式（set_recommend mode=simple/standard/full 给推荐）③项目相关提问授权（set_recommend ask=unlimited95/limited/noAsk 给推荐）④学习需求（set_recommend learn=A/B/C/D 给推荐；B=无装载，随后派学习子代理补齐能力缺口——查工具/库/现成方案，不承担探索职责）⑤目标确认（把「当前对话临时目标」复述写入 conversationGoal，同时确认 projectGoal——用户不说=默认与对话目标一致；用户确认后 set_triage(goalConfirm=confirmed)）。五问答案用 set_triage 写入（含 modeConfirmed=confirmed）；第二轮才问项目相关问题（任务领域细节），不要和五问混在一轮。另：关键信息缺失口径 missingPolicy（A 尝试推理做不到留空[默认] / B 留空 / C 编造）可随时 set_tree 调整。无限/有限提问授权仅用于理解需求——探索模式下不得以提问代替自身探索");
    const miss = missingFiveAsk(st);
    if (miss.length > 0) parts.push(`当前缺项（用户已确认过的项必须立即补写落账，不要重复追问）：${miss.join("；")}`);
  } else parts.push(`开局五问已答：任务性质=${judgeName(st.judge)}｜工作模式=${deriveCombo(st).pathLabel}｜提问授权=${st.askPolicy === "unlimited95" ? "无限提问直至完全理解用户需求（95% 置信度）" : st.askPolicy === "limited" ? "只允许有限度的提问" : "不开启"}｜学习需求=${st.learnNeed === "A" ? "电脑中有" : st.learnNeed === "B" ? "无装载——派学习子代理补齐能力缺口（学习环；探索职责归探索链）" : st.learnNeed === "C" ? "用户不清楚，你自查" : st.learnNeed === "D" ? `用户补充：${st.learnNote || "（待填）"}` : "未答"}｜目标=${st.goalConfirmed === "confirmed" ? "用户已确认" : "未确认"}；第二轮项目相关问题按需追问`);
  parts.push(`输出风格必须遵守（用户设定，违反=交付不合格）：${st.outputStyle === "minimal" ? "极简——对话中禁止复述已知信息与过程流水账；结论先行，只保留「成果 + 证据路径 + 需用户决策的要素」三样；技术细节折叠或指向文件而不铺开；复杂结论必须译成大白话再给" : st.outputStyle === "normal" ? "普通——对话中不要赘述过程与推理链；结论先行，只保留「成果 + 证据路径 + 需用户决策的要素」；必要的技术细节简短给出，不铺开" : "无约束——按你的判断输出，但不要为了凑字数重复已知信息"}`);
  if (st.reviewSheet === "on" && e.reworkLine) parts.push("审查记录模式开启：孙代理交付必须附「审查记录」自检表（任务卡号/验收条款逐条自查过不过+证据路径/偏差与未决/自评置信度），主控按表核签+抽查验收，不全量重读孙代理产出（省 token）；孙代理未附表=验收退回补表");
  // 提问冻结（⑥）：最强的单条约束，放在接近末尾以便最后被读到
  if (st.freezeForQuestion === "frozen") parts.push("⚠ 提问冻结中（用户已裁决的硬约束）：你刚提出了需要用户答复的问题，在用户答复之前**禁止下发与该问题口径相关的任何指令**——不得派子代理、不得发任务卡、不得落盘口径相关产物、不得推进阶段。本轮只允许：等待答复、或做与该问题口径无关的准备工作。用户答复后用 set_tree(freezeForQuestion=clear) 解除");
  return `用户在面板代理树选定的执行方式（每轮注入，以本面板为准）：${parts.join("；")}。被跳过/停用的关卡与循环线不得自行恢复；交付时按流程偏差申报注明当前组合。`;
}

// 每轮注入文本（compact；2026-09-19 v0.10.2 重建）
function renderStateBlock(st) {
  const e = effectiveEdges(st);
  const derived = deriveCombo(st);
  const est = estimate(st);
  const lines = [
    "【驾驭工程面板 · 用户实时掌控（每轮生效，与你的执行强约束）】",
    `判型：${st.judge === "unset" ? "未定（开局必做——本轮第一动作完成判型）" : judgeName(st.judge)}${st.judge === "compound" ? `（当前阶段：${st.compoundPhase === "engineering" ? "工程模式" : "探索"}）` : ""}`,
    `编排：${st.layering === "three" ? "三层（主代理→主控→孙）" : st.layering === "two" ? "两层（父审核子）" : "一层（主代理亲自执行）"}｜攻击代理【${e.segment === "explore" ? "探索段" : "工程段"}】：${e.attackAgent ? "开（派发前攻方向/条款→补充条款·仅主代理派）" : "关"}｜审计代理【${e.segment === "explore" ? "探索段" : "工程段"}】：${e.auditAgent ? "开（提交后转发成果→独立审计·仅主代理派）" : "关"}｜放行：${st.releaseGate === "auto" ? "免审全自动（审核权归主代理）" : "需用户审核"}`,
    `门控明示状态（§10.9.1 判定依据）：${(() => {
      const ex = Array.isArray(st.gateExplicit) ? st.gateExplicit : [];
      const off = GATE_FIELDS.filter((f) => st[f] === "skip" || (f === "releaseGate" && st[f] === "user"));
      const explicitOff = off.filter((f) => ex.includes(f));
      const defaultOff = off.filter((f) => !ex.includes(f));
      const nm = { attackGate: "攻击(工程)", auditGate: "审计(工程)", exploreAttackGate: "攻击(探索)", exploreAuditGate: "审计(探索)", releaseGate: "放行", reviewSheet: "审查记录" };
      return `用户明示关闭=【${explicitOff.map((f) => nm[f] ?? f).join("、") || "无"}】（不得自行恢复，确需→上报）；默认关闭=【${defaultOff.map((f) => nm[f] ?? f).join("、") || "无"}】（判断确需→可留痕自行启用并申报）`;
    })()}`,
    e.reworkLine ? `返工（${e.reworkWho}）：${st.reworkMode === "loop" ? "循环打回直至通过" : st.reworkMode === "limited" ? `最多打回 ${st.reworkMax} 次后带缺陷报告上报` : "不打回，直接带缺陷报告上报"}` : "返工线：停用（无子层）",
    `组合：${derived.pathLabel}｜关键信息缺失：${st.missingPolicy === "B" ? "留空" : st.missingPolicy === "C" ? "编造（用户授权）" : "尝试推理，做不到留空（默认）"}`,
    st.triageAsked === "asked"
      ? `开局五问：已完成（任务性质=${judgeName(st.judge)}｜工作模式=${derived.pathLabel}｜提问授权=${st.askPolicy === "unlimited95" ? "无限提问至完全理解" : st.askPolicy === "limited" ? "只允许有限度提问" : "不开启"}｜学习需求=${st.learnNeed}${st.learnNeed === "D" && st.learnNote ? `（${st.learnNote}）` : ""}｜目标=${st.goalConfirmed === "confirmed" ? "已确认" : "未确认"}）——无限/有限提问仅用于理解需求；第二轮项目问题按需追问`
      : `开局问询：未完成——第一轮只问五个必须问题（①任务性质 ②工作模式 ③提问授权 ④学习需求 ⑤目标确认；每个先给 AI 推荐：set_judge propose / set_recommend mode·ask·learn / set_goal 复述），set_triage 写入答案（含 modeConfirmed=confirmed）；第二轮才问项目相关问题；B=派学习子代理（计入预估倍率）。缺项：${missingFiveAsk(st).join("；") || "无"}`, 
    `判型：${st.judge === "unset" ? (st.judgeProposal ? `建议${judgeName(st.judgeProposal)}（${st.judgeReason}）——待用户确认` : "未定（澄清后 set_judge propose 给建议）") : `${judgeName(st.judge)}（定稿）`}`,
    `工作模式：${st.modeConfirmed === "confirmed" ? `${derived.pathLabel}（已确认）` : st.modeProposal !== "" ? `建议${PRESETS.find((p) => p.id === st.modeProposal)?.label ?? st.modeProposal}（${st.modeReason || "未附理由"}）——待用户确认（未确认不开工）` : "未确认（先 set_recommend 给推荐）"}`,
    `执行中提问：用户中途提问由主代理先判断——简单澄清直接回答，不派子代理、不硬走流程；确需实际工作才按当前模式委派`,
    st.assistLevel === "trust"
      ? "辅助程度：默认用户正确（必须执行）——用户陈述一律照办，不得主动质疑改口径；仅握有硬证据且不纠正后果严重时提示一次分歧"
      : "辅助程度：质疑（默认，必须执行）——用户主张当假设处理，事实/数据/口径/可行性/验收类陈述先自查（已核实/与事实不符/无法核实三类写进条款或交付说明），冲突当场指出并给依据；但用户已拍板的偏好与产品决策照办，不得反复纠缠",
    st.layering === "one"
      ? "执行卡上限：一层编排不适用（不派卡）"
      : st.cardCap === "none"
        ? "执行卡上限：不限（用户明示）——卡数自定，但必须把预计卡数写进分工表并作成本声明"
        : `执行卡上限：${st.cardCap} 张（硬约束）——主控自派孙代理卡数不得超过；需超发必须先冻结并逐级上报由用户裁定，不得自行超发；一卡=一个可独立验收的交付物，禁止把同一件事按知识点/章节/文件切碎；返工卡不重复计数`,
    `输出风格必须遵守（违反=交付不合格）：${st.outputStyle === "minimal" ? "极简——禁止复述已知信息与过程流水账；结论先行，只留「成果 + 证据路径 + 需用户决策的要素」；技术细节折叠或指向文件；复杂结论译成大白话" : st.outputStyle === "normal" ? "普通——不赘述过程与推理链；结论先行，只留「成果 + 证据路径 + 需用户决策的要素」；必要细节简短给出" : "无约束——按你判断输出，不凑字数"}`,
    `审查记录：${st.reviewSheet === "on" ? "开启——孙代理完工必须附自检审查记录，主控按表核签+抽查，不全量重读" : "关闭——主控全量重读验收"}`,
    `预估消耗：token ×${est.tokenX}｜时间 ×${est.timeX}（${est.note}）`,
    `项目总目标：${st.projectGoal === "" ? (st.conversationGoal !== "" ? "（未设——默认与对话目标一致）" : "（未设）") : st.projectGoal}`,
    `当前对话目标：${st.conversationGoal === "" ? "（未设）" : st.conversationGoal}`,
    st.freezeForQuestion === "frozen"
      ? "⚠ 提问冻结中：你提了需用户答复的问题，用户未答复前禁止派子代理/发卡/落盘口径相关产物/推进阶段——只等答复或做无关准备；答复后用 set_tree(freezeForQuestion=clear) 解除"
      : "提问冻结：未触发（你提问时必须置 set_tree(freezeForQuestion=frozen)，用户答复后置 clear）",
    "规则：以上为用户预先放行与裁定；被跳过/停用的关卡与循环线不得自行恢复；用户可能随时在面板改值——与本块冲突时以本块为准；交付时按流程偏差申报注明当前组合。"
  ];
  return lines.join("\n");
}

// 由旋钮组合派生预设名（命中=预设 id，否则 custom；judge 不参与预设判定）
function deriveCombo(st) {
  const preset = PRESETS.find((p) => Object.entries(p.combo).every(([k, v]) => st[k] === v));
  return preset ? { path: preset.id, pathLabel: preset.label } : { path: "custom", pathLabel: "自定义组合" };
}

// ── 状态存取（内存缓存权威；文件落盘异步；provider 同步 peek） ──────────────
function dshHome() {
  const raw = process.env.DSH_HOME;
  if (raw !== undefined && raw.trim() !== "") {
    const p = raw.startsWith("~") ? join(homedir(), raw.slice(1).replace(/^[\\/]/, "")) : raw;
    return p;
  }
  return join(homedir(), ".dsh");
}
const safeKey = (sid) => String(sid).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "adhoc";

// ── A14 日志 side-car（2026-09-24 落地；依据架构攻击 A14「日志 50 条上限致状态不可回溯」）────
// 全量日志**只追加**到 <dshHome>/harness-flow/<safeKey>.log.jsonl，不再被 50 条上限截断；
// 状态文件内仍保留最近 50 条（面板显示与红点逻辑不变），字段级 before/after 随条目写入（可机检）。
// 边界：①日志内容不进每轮注入块（renderStateBlock 不含 log）→ 上下文零增长；
//       ②写失败 fail-open（仅丢归档，不阻断主流程）；
//       ③种子回填（seedLogSidecar）：本机制上线前已有状态文件的会话，side-car 不存在时
//         一次性把状态内现存条目（≤50）写入，保证「升级前最近 50 条」也可回溯——用 'wx' 独占创建，
//         只成功一次、并发安全、不重复追加。
async function appendLogSidecar(sid, entries) {
  if (typeof sid !== "string" || sid === "" || !Array.isArray(entries) || entries.length === 0) return;
  try {
    const dir = join(dshHome(), "harness-flow");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${safeKey(sid)}.log.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  } catch {}
}
async function seedLogSidecar(sid, logEntries) {
  if (typeof sid !== "string" || sid === "" || !Array.isArray(logEntries) || logEntries.length === 0) return;
  try {
    const dir = join(dshHome(), "harness-flow");
    await mkdir(dir, { recursive: true });
    const p = join(dir, `${safeKey(sid)}.log.jsonl`);
    const handle = await open(p, "wx");   // 独占创建：已存在则抛错 → 静默跳过（不重复回填）
    try {
      await handle.writeFile(logEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    } finally {
      await handle.close();
    }
  } catch {}
}

function initState(sessionId) {
  return {
    version: 3,
    sessionId,
    judge: "unset",
    layering: "three",
    attackGate: "skip",
    auditGate: "skip",
    exploreAttackGate: "skip",
    exploreAuditGate: "skip",
    releaseGate: "user",
    reworkMode: "loop",
    reworkMax: 2,
    askPolicy: "unset",
    learnNeed: "unset",
    missingPolicy: "unset",
    compoundPhase: "explore",
    triageAsked: "unset",
    goalConfirmed: "unset",
    modeConfirmed: "unset",
    modeProposal: "",
    modeReason: "",
    askProposal: "",
    askReason: "",
    learnProposal: "",
    learnReason: "",
    learnNote: "",
    reviewSheet: "on",
    outputStyle: "minimal",
    assistLevel: "challenge",
    cardCap: "4",
    freezeForQuestion: "clear",
    // gateExplicit：被「用户/代理单项点击」改过的门控字段列表（§10.9.1）。
    // 用于区分「实示关」与「默认预设关」——预设整组切换会清空本列表（预设驱动≠用户明示）。
    gateExplicit: [],
    judgeProposal: "",
    judgeReason: "",
    // 与上方默认 combo 同源派生（三层+免攻击审计+用户审核+循环返工 = 一般/standard）——
    // 写死 "full" 会在首帧错显「复杂」高亮（2026-09-19 检测发现）
    path: "standard",
    projectGoal: "",
    conversationGoal: "",
    currentNode: "intent",
    visited: ["intent"],
    lastNote: "",
    logSeen: 0,
    logRead: 0,
    log: [],
    // logArchivePath（A14）：全量日志 side-car 文件路径（面板「操作留痕」底部提示用；由 store 在 load/save 时填）
    logArchivePath: "",
    updatedAt: Date.now()
  };
}

function validState(value) {
  if (typeof value !== "object" || value === null) return null;
  const st = initState(typeof value.sessionId === "string" ? value.sessionId : "");
  for (const [field, allowed] of Object.entries(TREE_FIELDS)) {
    if (allowed.includes(value[field])) st[field] = value[field];
  }
  if (Array.isArray(value.goalConfirmed) ) {} else if (TREE_FIELDS.goalConfirmed.includes(value.goalConfirmed)) st.goalConfirmed = value.goalConfirmed;
  if (typeof value.learnNote === "string") st.learnNote = value.learnNote;
  if (TREE_FIELDS.outputStyle.includes(value.outputStyle)) st.outputStyle = value.outputStyle;
  if (value.judgeProposal === "engineering" || value.judgeProposal === "exploration" || value.judgeProposal === "compound") st.judgeProposal = value.judgeProposal;
  if (typeof value.modeProposal === "string" && PRESET_IDS.includes(value.modeProposal)) st.modeProposal = value.modeProposal;
  if (typeof value.modeReason === "string") st.modeReason = value.modeReason.slice(0, 300);
  if (typeof value.askProposal === "string" && TREE_FIELDS.askPolicy.slice(1).includes(value.askProposal)) st.askProposal = value.askProposal;
  if (typeof value.askReason === "string") st.askReason = value.askReason.slice(0, 300);
  if (typeof value.learnProposal === "string" && TREE_FIELDS.learnNeed.slice(1).includes(value.learnProposal)) st.learnProposal = value.learnProposal;
  if (typeof value.learnReason === "string") st.learnReason = value.learnReason.slice(0, 300);
  if (typeof value.judgeReason === "string") st.judgeReason = value.judgeReason.slice(0, 300);
  if (typeof value.reworkMax === "number" && Number.isFinite(value.reworkMax)) st.reworkMax = Math.min(9, Math.max(1, Math.round(value.reworkMax)));
  if (typeof value.logSeen === "number" && Number.isFinite(value.logSeen)) st.logSeen = value.logSeen;
  if (typeof value.logRead === "number" && Number.isFinite(value.logRead)) st.logRead = value.logRead;
  if (typeof value.projectGoal === "string") st.projectGoal = value.projectGoal;
  if (typeof value.conversationGoal === "string") st.conversationGoal = value.conversationGoal;
  if (NODE_IDS.includes(value.currentNode)) st.currentNode = value.currentNode;
  if (Array.isArray(value.visited)) st.visited = value.visited.filter((id) => NODE_IDS.includes(id));
  if (!st.visited.includes(st.currentNode)) st.visited.push(st.currentNode);
  if (typeof value.lastNote === "string") st.lastNote = value.lastNote;
  if (Array.isArray(value.gateExplicit)) st.gateExplicit = value.gateExplicit.filter((f) => typeof f === "string" && GATE_FIELDS.includes(f)).slice(0, 12);
  if (Array.isArray(value.log)) st.log = value.log.filter((e) => typeof e === "object" && e !== null && typeof e.text === "string").slice(-50);
  if (typeof value.logArchivePath === "string") st.logArchivePath = value.logArchivePath.slice(0, 260);
  st.path = deriveCombo(st).path;
  return st;
}

async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(JSON.stringify(value, null, 1), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function makeStore() {
  const cache = new Map();
  const dir = join(dshHome(), "harness-flow");
  const pathFor = (sid) => join(dir, `${safeKey(sid)}.json`);
  // A14：全量日志 side-car 路径（与状态文件同目录、同 key；只追加）
  const logPathFor = (sid) => join(dir, `${safeKey(sid)}.log.jsonl`);
  const load = async (sid) => {
    if (cache.has(sid)) return cache.get(sid);
    let st = initState(sid);
    try {
      const raw = await readFile(pathFor(sid), "utf8");
      st = validState(JSON.parse(raw)) ?? st;
      st.sessionId = sid;
    } catch {}
    st.logArchivePath = logPathFor(sid);
    cache.set(sid, st);
    // 种子回填（A14③）：老会话首次被加载时把现存 log 条目补进 side-car（独占创建，只成功一次）
    await seedLogSidecar(sid, st.log);
    return st;
  };
  const peek = (sid) => (typeof sid === "string" ? cache.get(sid) : undefined);
  const save = async (sid, st) => {
    st.updatedAt = Date.now();
    st.logArchivePath = logPathFor(sid);
    cache.set(sid, st);
    try {
      await mkdir(dirname(pathFor(sid)), { recursive: true });
      await writeJsonAtomic(pathFor(sid), st);
    } catch {}
  };
  return { load, peek, save, pathFor, logPathFor };
}

// ── 状态变更（工具与 UI 共用） ──────────────────────────────────────────────
// 门控字段集（2026-09-23 §10.9.1）：这些字段的取值若来自**用户单项点击**，记入 st.gateExplicit
// （=用户明示）；选预设整组切换时重置（预设驱动≠用户明示）。主代理据此区分「明示关」与「默认关」：
// 明示关→不得自恢复但必须上报；默认关→可留痕自行启用。
const GATE_FIELDS = ["attackGate", "auditGate", "exploreAttackGate", "exploreAuditGate", "releaseGate", "reviewSheet"];
function applyPatch(st, patch, source) {
  const changes = [];
  // A14（2026-09-24）：本次新增的日志条目（供 side-car 全量归档）；字段级 before/after 随条目携带（可机检）。
  const appended = [];
  const traces = [];
  const pushLog = (entry) => { const e = { ts: Date.now(), source, ...entry }; st.log.push(e); appended.push(e); };
  if (patch.goalConfirm === "confirmed") {
    patch = { ...patch, goalConfirmed: "confirmed" };
    if (st.judge === "unset" && (st.judgeProposal === "engineering" || st.judgeProposal === "exploration")) {
      st.judge = st.judgeProposal;
      changes.push(`判型定稿→${st.judge === "engineering" ? "工程模式" : "探索模式"}（开工确认包确认）`);
    }
  }
  if (typeof patch.learnNote === "string") { patch = { ...patch, learnNote: patch.learnNote.slice(0, 300) }; }
  if (typeof patch.path === "string" && PRESET_IDS.includes(patch.path)) {
    const preset = PRESETS.find((p) => p.id === patch.path);
    const before = JSON.stringify([st.layering, st.attackGate, st.releaseGate, st.reworkMode]);
    Object.assign(st, preset.combo);
    // 预设=整组切换 → 门控取值属「预设驱动」，清空明示标记（§10.9.1）
    st.gateExplicit = [];
    if (before !== JSON.stringify([st.layering, st.attackGate, st.releaseGate, st.reworkMode])) changes.push(`工作模式→ ${preset.label}（预设组合）`);
  }
  // 用户/代理**单项**改动门控字段 → 记入明示列表（agent 改动也记：它代表主代理的显式决定）
  for (const f of GATE_FIELDS) {
    const v = patch[f];
    if (typeof v === "string" && TREE_FIELDS[f]?.includes(v) && v !== st[f]) {
      if (!Array.isArray(st.gateExplicit)) st.gateExplicit = [];
      if (!st.gateExplicit.includes(f)) st.gateExplicit.push(f);
    }
  }
  for (const [field, labels] of Object.entries(TREE_FIELD_LOG)) {
    const v = patch[field];
    if (typeof v === "string" && TREE_FIELDS[field].includes(v) && v !== st[field]) {
      const before = st[field];
      st[field] = v;
      changes.push(labels[v]);
      traces.push({ text: labels[v], field, before, after: v });
      if (field === "layering" && v === "one") {
        // 依赖规则：一层编排下无子层——攻击线强制停用、返工线停用（记录派生变化）
        if (st.attackGate === "on") changes.push("攻击线随编排停用（一层无子层）");
      }
    }
  }
  if (typeof patch.reworkMax === "number" && Number.isFinite(patch.reworkMax)) {
    const v = Math.min(9, Math.max(1, Math.round(patch.reworkMax)));
    if (v !== st.reworkMax) {
      const before = st.reworkMax;
      st.reworkMax = v;
      changes.push(`返工限次→ ${v} 次`);
      traces.push({ text: `返工限次→ ${v} 次`, field: "reworkMax", before, after: v });
    }
  }
  // 开局五问的 AI 推荐（set_recommend 写入；与实际答案分离）
  if (typeof patch.modeProposal === "string" && PRESET_IDS.includes(patch.modeProposal) && patch.modeProposal !== st.modeProposal) {
    st.modeProposal = patch.modeProposal;
    changes.push(`工作模式推荐→${PRESETS.find((p) => p.id === patch.modeProposal)?.label ?? patch.modeProposal}（待用户确认）`);
  }
  if (typeof patch.modeReason === "string") st.modeReason = patch.modeReason.slice(0, 300);
  if (typeof patch.askProposal === "string" && TREE_FIELDS.askPolicy.slice(1).includes(patch.askProposal) && patch.askProposal !== st.askProposal) {
    st.askProposal = patch.askProposal;
    changes.push("提问授权推荐→已给出（待用户采纳）");
  }
  if (typeof patch.askReason === "string") st.askReason = patch.askReason.slice(0, 300);
  if (typeof patch.learnProposal === "string" && TREE_FIELDS.learnNeed.slice(1).includes(patch.learnProposal) && patch.learnProposal !== st.learnProposal) {
    st.learnProposal = patch.learnProposal;
    changes.push("学习需求推荐→已给出（待用户采纳）");
  }
  if (typeof patch.learnReason === "string") st.learnReason = patch.learnReason.slice(0, 300);

  // 日志已读水位（不写日志本身；chip 数字角标 / 面板红点据此消隐）
  if (typeof patch.logSeen === "number" && Number.isFinite(patch.logSeen)) st.logSeen = patch.logSeen;
  if (typeof patch.logRead === "number" && Number.isFinite(patch.logRead)) st.logRead = patch.logRead;
  if (typeof patch.projectGoal === "string" && patch.projectGoal.trim() !== "" && patch.projectGoal !== st.projectGoal) {
    st.projectGoal = patch.projectGoal.slice(0, 500);
    changes.push("总目标更新");
  }
  if (typeof patch.conversationGoal === "string" && patch.conversationGoal.trim() !== "" && patch.conversationGoal !== st.conversationGoal) {
    st.conversationGoal = patch.conversationGoal.slice(0, 500);
    changes.push("对话目标更新");
  }
  // 提问冻结门禁（⑥）：冻结期间，模型不得自行推进阶段（面板层软门禁；派子代理的硬拦截不在本插件权限内）
  if (st.freezeForQuestion === "frozen" && typeof patch.node === "string" && NODE_IDS.includes(patch.node) && patch.node !== "intent" && source === "agent") {
    pushLog({ text: `⚠ 冻结期间拒收阶段推进→ ${nodeLabel(patch.node)}（问题未答复；用户答复后再推进）` });
    delete patch.node;
  }
  if (typeof patch.node === "string" && NODE_IDS.includes(patch.node) && patch.node !== st.currentNode) {
    st.currentNode = patch.node;
    if (!st.visited.includes(patch.node)) st.visited.push(patch.node);
    changes.push(`阶段→ ${nodeLabel(patch.node)}`);
  }
  if (typeof patch.learnNote === "string" && patch.learnNote.trim() !== "" && patch.learnNote !== st.learnNote) {
    st.learnNote = patch.learnNote;
    changes.push("学习需求补充更新");
  }
  if (typeof patch.note === "string" && patch.note.trim() !== "") {
    st.lastNote = patch.note.slice(0, 200);
    changes.push(`备注：${st.lastNote}`);
  }
  // 开局五问门禁：任务性质(judge) + 工作模式(modeConfirmed) + 提问授权 + 学习需求 + 目标确认 —— 未答不能开工
  if (st.triageAsked !== "asked" && st.askPolicy !== "unset" && st.learnNeed !== "unset" && st.goalConfirmed === "confirmed" && st.judge !== "unset" && st.modeConfirmed === "confirmed") {
    st.triageAsked = "asked";
    changes.push("开局五问→已完成");
  } else if (st.triageAsked === "asked" && (st.askPolicy === "unset" || st.learnNeed === "unset" || st.goalConfirmed !== "confirmed" || st.modeConfirmed !== "confirmed")) {
    // 用户取消某项选择（重复点击已选项）→ 问询状态回退，未答不开工重新生效
    st.triageAsked = "unset";
    changes.push("开局五问→回退（有项被取消，未完成不开工）");
  }
  st.path = deriveCombo(st).path;
  // A14（2026-09-24）：日志条目按变更逐条落盘；能定位到字段的附 before/after（可机检），其余为纯文本。
  const traceByText = new Map(traces.map((t) => [t.text, t]));
  for (const text of changes) {
    const tr = traceByText.get(text);
    pushLog(tr ? { text, field: tr.field, before: tr.before, after: tr.after } : { text });
  }
  // 状态文件内仍保留最近 50 条（面板显示/红点逻辑不变）；全量由 side-car 承接（调用方 appendLogSidecar）
  if (st.log.length > 50) st.log = st.log.slice(-50);
  return { changes, appended };
}

// 外部角标计数：agent 侧写入且未读的日志数（面板内 UI 改动不计入；打开面板 logSeen=now 清零）
function unseenAgentCount(st) {
  const seen = typeof st.logSeen === "number" ? st.logSeen : 0;
  return (Array.isArray(st.log) ? st.log : []).filter((e) => e && e.source !== "ui" && (e.ts ?? 0) > seen).length;
}

// ── HTTP 通道（loopback 栅栏） ──────────────────────────────────────────────
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" };
function writeJson(res, status, body) {
  res.writeHead(status, { ...JSON_HEADERS, "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function isIPv4Loopback(v4) {
  const parts = v4.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function isLoopbackRequest(req) {
  const addr = (req.socket?.remoteAddress ?? "").toLowerCase();
  const loopback = addr === "::1" || (addr.startsWith("::ffff:") && isIPv4Loopback(addr.slice(7))) || isIPv4Loopback(addr);
  if (!loopback) return false;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  try {
    const hostUrl = new URL("http://" + host);
    const hn = hostUrl.hostname;
    if (!(hn === "localhost" || hn === "[::1]" || isIPv4Loopback(hn))) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
const readBody = (req, limit = 16384) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) {
      reject(new Error("body too large"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

function makeStateRoute(store) {
  return {
    kind: "exact",
    path: "/api/harness-flow/state",
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
        return;
      }
      try {
        if (req.method === "GET") {
          const url = new URL(req.url, "http://localhost");
          const sid = url.searchParams.get("sessionId") ?? "";
          if (sid === "") {
            writeJson(res, 400, { ok: false, error: "sessionId required" });
            return;
          }
          const st = await store.load(sid);
          writeJson(res, 200, { ok: true, state: { ...st, unseenAgent: unseenAgentCount(st) }, edges: effectiveEdges(st), est: estimate(st) });
          return;
        }
        if (req.method === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}");
          const sid = typeof body.sessionId === "string" ? body.sessionId : "";
          if (sid === "") {
            writeJson(res, 400, { ok: false, error: "sessionId required" });
            return;
          }
          const st = await store.load(sid);
          const inPatch = typeof body.patch === "object" && body.patch !== null ? body.patch : {};
          const source = typeof body.source === "string" ? body.source : "ui";
          // 预估即时预览（2026-09-22 用户要求「不要等确认修改之后才更改」）：草稿态下把待应用改动
          // 在副本上试算——只回 est/edges，不落盘、不进日志。正式生效仍必须走「应用」（无 preview 的 POST）。
          if (body.preview === true) {
            const probe = structuredClone(st);
            applyPatch(probe, inPatch, source);
            writeJson(res, 200, { ok: true, preview: true, est: estimate(probe), edges: effectiveEdges(probe) });
            return;
          }
          const { changes, appended } = applyPatch(st, inPatch, source);
          await store.save(sid, st);
          await appendLogSidecar(sid, appended);
          writeJson(res, 200, { ok: true, state: { ...st, unseenAgent: unseenAgentCount(st) }, edges: effectiveEdges(st), est: estimate(st), changes });
          return;
        }
        writeJson(res, 405, { ok: false, error: "method not allowed" });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
}

// ── 模型工具 harness_flow ───────────────────────────────────────────────────
// 注意：raw register 的 parameters 是【标准 JSON Schema】——required 只能是对象层的
// 字符串数组；属性内不允许 dsh spec 式的 required: true（OpenAI 兼容层会报 400）。
const TOOL_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["get", "set_goal", "set_node", "set_judge", "set_tree", "set_preset", "set_triage", "set_recommend", "note"],
      description: "操作：get=读面板状态；set_goal=写项目总目标/当前对话目标；set_node=阶段推进；set_judge=判型（开局必做——会话开始后第一个执行类动作就是它）；set_tree=调整树上旋钮（layering/attackGate/auditGate/releaseGate/reworkMode/reworkMax/reviewSheet/missingPolicy/compoundPhase，仅用户明示时代理代调，面板点选为主）；set_preset=三档预设整组切换（simple/standard/full）；set_triage=写入开局五问答案（任务开始前必答，缺一不开工：askPolicy/learnNeed/goalConfirm/modeConfirmed，judge 由 set_judge 承担；learnNeed=B 时派学习子代理补齐能力缺口（不承担探索职责）；无限/有限提问仅用于理解需求，探索模式不得以问代探）；set_recommend=给开局五问的 AI 推荐（mode/ask/learn 三项，附理由，供用户采纳或改——第一轮只问这五问再问项目问题）；note=留痕。"
    },
    judge: { type: "string", enum: ["engineering", "exploration", "compound"], description: "判型（set_judge 用）：engineering=工程模式（目标明确直接开工）；exploration=探索模式（尽可能探索所有可能方向，给用户思路方向，不落地实施）；compound=复合模式（先探索再驾驭：探索收到用户放行探索结果后进入驾驭工程阶段）。澄清后先 propose 建议制，用户确认后定稿。" },
    propose: { type: "boolean", description: "set_judge 用：true=只写判型建议（judgeProposal+judgeReason），待用户开工确认后定稿；缺省=false 直接定稿。" },
    reason: { type: "string", description: "判型建议的人话理由（propose 时必带，≤200 字，例：需求已收敛为X，验收可预置，可直接开工）。" },
    outputStyle: { type: "string", enum: ["minimal", "normal", "free"], description: "输出风格（set_tree 用）：minimal=极简/normal=普通/free=无约束。" },
    assistLevel: { type: "string", enum: ["challenge", "trust"], description: "辅助程度（set_tree 用）：challenge=质疑（默认：用户主张当假设处理，事实/数据/口径/可行性/验收类陈述先自查，冲突当场指出并给依据；但用户已拍板的偏好照办）；trust=默认用户正确（按用户所述执行，仅握硬证据且后果严重时提示一次分歧）。" },
    gateExplicit: { type: "array", items: { type: "string" }, description: "只读：被单项点击改过的门控字段列表（用户/代理明示）；预设切换会清空。主代理据此区分「明示关」与「默认关」（见 SKILL §10.9.1）。" },
    freezeForQuestion: { type: "string", enum: ["clear", "frozen"], description: "提问冻结旗（set_tree 用）：frozen=你刚提出需用户答复的问题、在答复到前冻结口径相关动作；clear=用户已答复，解除冻结。冻结期间禁止派子代理/发卡/落盘/推进阶段。" },
    cardCap: { type: "string", enum: ["2", "4", "6", "8", "none"], description: "执行卡上限（set_tree 用，三层/两层编排下生效）：主控在一次任务里可自行派发的孙代理卡数上限，默认 4；none=不限（须由用户明示）。超发必须先冻结并逐级上报由用户裁定；一卡=一个可独立验收的交付物，禁止把同一件事切碎。" },
    askPolicy: { type: "string", enum: ["unlimited95", "limited", "noAsk"], description: "任务问询①（set_triage 用）：unlimited95=允许无限制提问直至理解置信度达 95%；limited=只允许有限度的提问；noAsk=不开启。" },
    learnNeed: { type: "string", enum: ["A", "B", "C", "D"], description: "任务问询②（set_triage 用）：A=电脑中有该能力；B=无装载，派学习子代理补齐能力缺口（查工具/库/现成方案；不承担探索职责）；C=用户不清楚，代理自查；D=用户补充（附 learnNote）。" },
    goalConfirm: { type: "string", enum: ["confirmed"], description: "开局五问⑤（set_triage 用）：用户确认「当前对话临时目标」复述无误后传 confirmed。" },
    modeConfirmed: { type: "string", enum: ["confirmed"], description: "开局五问②（set_triage 用）：用户确认工作模式后传 confirmed——未确认不能开工（全自动下由主代理自行判断确认并留痕）。" },
    mode: { type: "string", enum: ["simple", "standard", "full"], description: "工作模式推荐（set_recommend 用）：simple=简单任务/设计图形UI；standard=一般任务（最常用）；full=复杂工程级任务。附 modeReason。" },
    modeReason: { type: "string", description: "工作模式推荐的人话理由（≤200 字）。" },
    ask: { type: "string", enum: ["unlimited95", "limited", "noAsk"], description: "提问授权推荐（set_recommend 用）：unlimited95=无限提问直至完全理解用户需求/limited=只允许有限度/noAsk=不开启。附 askReason。" },
    askReason: { type: "string", description: "提问授权推荐理由（≤200 字）。" },
    learn: { type: "string", enum: ["A", "B", "C", "D"], description: "学习需求推荐（set_recommend 用）：A 电脑中有/B 无装载去补能力缺口（查工具、库、现成方案）——不承担探索职责/C 不清楚/D 用户补充。附 learnReason。" },
    learnReason: { type: "string", description: "学习需求推荐理由（≤200 字）。" },
    learnNote: { type: "string", description: "任务问询② D 选项的用户补充内容（≤300 字）。" },
    reviewSheet: { type: "string", enum: ["on", "off"], description: "审查记录模式（set_tree 用）：on=孙代理完工必须附自检审查记录，主控按表核签+抽查不全量重读；off=主控全量重读。" },
    layering: { type: "string", enum: ["three", "two", "one"], description: "编排旋钮（set_tree 用）：three=三层（主代理→主控→孙）；two=两层（父审核子：主代理直接管理孙代理并验收）；one=一层（主代理亲自执行，含设计/图形/UI 类工作）。" },
    attackGate: { type: "string", enum: ["on", "skip"], description: "攻击代理旋钮【工程段】（set_tree 用，独立子代理，位于主代理左侧）：on=开启（主代理→攻击代理「派发条款」，攻击代理→主代理「补充条款」）；skip=关闭。简约（一层）不显示。复合模式下本旋钮只管工程段，探索段用 exploreAttackGate。" },
    auditGate: { type: "string", enum: ["on", "skip"], description: "审计代理旋钮【工程段】（set_tree 用，独立子代理·高危审计，位于主代理右侧）：on=开启（主代理→审计代理「转发子代理内容」，审计代理→主代理「提交审计报告（不做修改）」）；skip=关闭。简约（一层）不显示。复合模式下本旋钮只管工程段，探索段用 exploreAuditGate。" },
    exploreAttackGate: { type: "string", enum: ["on", "skip"], description: "探索段攻击代理旋钮（set_tree 用，仅探索模式/复合模式探索阶段生效）：on=开启；skip=关闭。与工程段的 attackGate 相互独立（2026-09-23 用户要求两段分开调）。" },
    exploreAuditGate: { type: "string", enum: ["on", "skip"], description: "探索段审计代理旋钮（set_tree 用，仅探索模式/复合模式探索阶段生效）：on=开启；skip=关闭。与工程段的 auditGate 相互独立。" },
    releaseGate: { type: "string", enum: ["user", "auto"], description: "放行旋钮（set_tree 用）：user=需用户审核；auto=免审全自动（用户审核权全部交由主代理控制——判型/工作模式/条款放行均由主代理判断并留痕）。" },
    missingPolicy: { type: "string", enum: ["A", "B", "C"], description: "关键信息缺失处理（set_tree 用）：A=尝试自己寻找/推理（做不到降级为留空，默认）；B=留空；C=编造（用户授权，风险自担）。" },
    compoundPhase: { type: "string", enum: ["explore", "engineering"], description: "复合模式阶段（set_tree 用）：explore=探索阶段（默认）；engineering=驾驭工程阶段（用户放行探索结果后进入）。" },
    reworkMode: { type: "string", enum: ["loop", "limited", "report"], description: "返工策略旋钮（set_tree 用，需子层存在）：loop=循环打回直至通过；limited=最多打回 reworkMax 次，超限带缺陷报告上报；report=不打回直接带缺陷报告上报。" },
    reworkMax: { type: "integer", description: "返工限次上限 1-9（set_tree 用，reworkMode=limited 时生效）。" },
    path: { type: "string", enum: [...PRESET_IDS], description: "三档预设（set_preset 用）：simple=简约（主代理直接干）；standard=一般（立项免攻击走流程）；full=复杂（完整流程）。判型不随预设——开局必做。" },
    projectGoal: { type: "string", description: "项目总目标（一句话，做成什么+做到什么程度）。" },
    conversationGoal: { type: "string", description: "当前对话目标（一句话）。" },
    node: { type: "string", enum: [...NODE_IDS], description: "目标节点 id（set_node 用）：" + NODE_IDS.map((id) => `${id}=${nodeLabel(id)}`).join("；") + "。" },
    note: { type: "string", description: "留痕文本，≤200 字。" }
  },
  required: ["action"]
};

const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    judge: { type: "string", enum: ["unset", "engineering", "exploration", "compound"] },
    judgeProposal: { type: "string", enum: ["", "engineering", "exploration", "compound"] },
    judgeReason: { type: "string" },
    outputStyle: { type: "string", enum: ["minimal", "normal", "free"] },
    assistLevel: { type: "string", enum: ["challenge", "trust"] },
    cardCap: { type: "string", enum: ["2", "4", "6", "8", "none"] },
    freezeForQuestion: { type: "string", enum: ["clear", "frozen"] },
    layering: { type: "string", enum: ["three", "two", "one"] },
    attackGate: { type: "string", enum: ["on", "skip"] },
    auditGate: { type: "string", enum: ["on", "skip"] },
    exploreAttackGate: { type: "string", enum: ["on", "skip"] },
    exploreAuditGate: { type: "string", enum: ["on", "skip"] },
    segment: { type: "string", enum: ["explore", "engineer"] },
    gateExplicit: { type: "array", items: { type: "string" } },
    missingPolicy: { type: "string", enum: ["unset", "A", "B", "C"] },
    compoundPhase: { type: "string", enum: ["explore", "engineering"] },
    releaseGate: { type: "string", enum: ["user", "auto"] },
    reworkMode: { type: "string", enum: ["loop", "limited", "report"] },
    reworkMax: { type: "integer" },
    reworkLineActive: { type: "boolean" },
    attackLineActive: { type: "boolean" },
    auditLineActive: { type: "boolean" },
    askPolicy: { type: "string", enum: ["unset", "unlimited95", "limited", "noAsk"] },
    learnNeed: { type: "string", enum: ["unset", "A", "B", "C", "D"] },
    triageAsked: { type: "string", enum: ["unset", "asked"] },
    goalConfirmed: { type: "string", enum: ["unset", "confirmed"] },
    modeConfirmed: { type: "string", enum: ["unset", "confirmed"] },
    modeProposal: { type: "string", enum: ["", "simple", "standard", "full"] },
    modeReason: { type: "string" },
    askProposal: { type: "string", enum: ["", "unlimited95", "limited", "noAsk"] },
    askReason: { type: "string" },
    learnProposal: { type: "string", enum: ["", "A", "B", "C", "D"] },
    learnReason: { type: "string" },
    learnNote: { type: "string" },
    reviewSheet: { type: "string", enum: ["on", "off"] },
    path: { type: "string", enum: [...PRESET_IDS, "custom"] },
    pathLabel: { type: "string" },
    scanAi: { type: "number", description: "该会话未读日志水位（client 用；面板内改动=logSeen，agent 写=logSeen）" },
    logSeen: { type: "number" },
    logRead: { type: "number" },
    tokenX: { type: "number" },
    timeX: { type: "number" },
    estNote: { type: "string" },
    estSummary: { type: "string" },
    directive: { type: "string" },
    projectGoal: { type: "string" },
    conversationGoal: { type: "string" },
    currentNode: { type: "string" },
    currentNodeLabel: { type: "string" },
    visitedCount: { type: "integer" },
    lastNote: { type: "string" },
    updatedAt: { type: "number" }
  }
};

// B17：会话预设解析。与下方 systemPrompt.variable 注入门禁同源——用 dsh 官方
// agentPresets.composedPreset 读 live scope chain（子代理随父组合）。agentPresets 故意不进
// inject（见文件头 B16 说明），故此处运行时 ctx.get 静默探测。服务不可达 → undefined，
// 由调用方按各自口径处理（工具门禁 fail-open，注入门禁回退旧行为）。
function composedPresetOf(agent, ctx) {
  try {
    const ap = ctx?.get?.("agentPresets");
    if (!ap || typeof ap.composedPreset !== "function") return undefined;
    const pid = ap.composedPreset(agent?.ctx ?? agent);
    return typeof pid === "string" && pid !== "" ? pid : undefined;
  } catch {
    return undefined;
  }
}

function makeTool(store, ctx) {
  return {
    name: "harness_flow",
    description: "【适用性·先读】本工具仅在 harness（驾驭工程模式）preset 会话生效：非 harness 会话调用会被直接拒绝且不写入任何状态，此时请**忽略本描述中的全部流程要求**（判型 / 开局五问 / 三层编排 / 各类门禁），按常规方式工作，不要重试本工具。驾驭工程代理树面板同步工具（harness 会话下面板状态每轮注入你的上下文——与本工具返回一致，以面板为准）。判型（judge）开局必做。任务问询（set_triage）在每个任务开始前必答，未答不要开始任务：①提问授权 askPolicy（unlimited95=无限提问直至理解置信度95% / limited=有限度提问 / noAsk=不开启）；②学习需求 learnNeed（A=电脑中有/B=无装载——派学习子代理补齐能力缺口〔不承担探索职责〕/C=不清楚代理自查/D=用户补充；UI 美学、PPT 设计、论文去 AI 味类任务大概率是 B）；③目标复述确认 goalConfirm（对话临时目标+项目总目标；项目目标未设=默认与对话目标一致）。旋钮：编排 layering（three=三层/two=两层父审核子/one=一层主代理直接干）；攻击代理 attackGate（on/skip，独立子代理·主代理左侧，派发条款→补充条款）；审计代理 auditGate（on/skip，独立子代理·高危审计·主代理右侧，转发子代理内容→提交审计报告，不做修改）；放行 releaseGate（user=需审核/auto=免审全自动——审核权全部交由主代理控制，判型与工作模式也由你判断并留痕）；返工 reworkMode（loop/limited/report）；审查记录 reviewSheet（on=孙代理附自检审查记录，主控按表核签+抽查不全量重读；off=全量重读）；关键信息缺失 missingPolicy（A=尝试推理做不到留空[默认]/B=留空/C=编造）；复合模式阶段 compoundPhase（explore/engineering，用户放行探索结果后转 engineering）；辅助程度 assistLevel（challenge=质疑[默认：用户主张当假设，先自查再采纳，冲突当场指出给依据；但用户已拍板的偏好照办]/trust=默认用户正确）；执行卡上限 cardCap（2／4[默认]／6／8／none——三层两层编排下主控可自派的孙代理卡数硬上限，超发必须先冻结并逐级上报由用户裁定；一卡=一个可独立验收的交付物，禁止把同一件事切碎）。调用时机：判型完成→set_judge；任务问询答案→set_triage；目标确立或变化→set_goal；阶段推进→set_node 附 note；仅当用户明示调整模式时你才 set_tree/set_preset。被停用的线不得自行恢复。",
    parameters: TOOL_PARAMS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: "text",
        text: `驾驭工程面板已同步：判型=${value.judge}${value.judge === "compound" ? `（${value.compoundPhase === "engineering" ? "驾驭工程" : "探索"}阶段）` : ""}｜编排=${value.layering}｜攻击代理=${value.attackLineActive ? "开" : "关"}｜审计代理=${value.auditLineActive ? "开" : "关"}｜放行=${value.releaseGate === "auto" ? "全自动" : "需审核"}｜返工=${value.reworkLineActive ? `${value.reworkMode}${value.reworkMode === "limited" ? `(${value.reworkMax}次)` : ""}` : "停用"}｜辅助=${value.assistLevel === "trust" ? "默认用户正确" : "质疑"}｜卡上限=${value.layering === "one" ? "不适用" : value.cardCap === "none" ? "不限" : value.cardCap + "张"}｜缺失=${value.missingPolicy}｜预估=token×${value.tokenX}/时间×${value.timeX}｜组合=${value.pathLabel}`
      }]
    },
    async execute(args, exec) {
      const sid = exec.agent?.session?.id;
      if (typeof sid !== "string" || sid === "") throw new Error("harness_flow requires an owning agent session");
      // B17 fail-closed 兜底（ctx.tools.guard 不可用时也守住）：非 harness 会话一律拒绝，且卡在
      // store.load 之前——绝不读取 / 写入 / 改动任何状态。agentPresets 服务不可达（undefined）不拦。
      const gatePid = composedPresetOf(exec?.agent, ctx);
      if (gatePid !== undefined && gatePid !== "harness") {
        throw new Error("harness_flow 不适用于本会话（agentPreset=" + gatePid + "，非 harness）。本工具描述中的判型 / 开局五问 / 三层编排等要求对本会话无效，请按常规方式继续工作，不要重试本工具。");
      }
      const st = await store.load(sid);
      if (args.action !== "get") {
        const effPatch = { ...args };
        // A14：applyPatch 外的直接日志条目也要进 side-car 归档（propose 建议等）
        const preLog = [];
        // set_judge propose：只写建议不定稿（定稿由用户开工确认触发，见 applyPatch goalConfirm）
        if (args.action === "set_judge" && args.propose === true) {
          delete effPatch.judge;
          delete effPatch.reason;
          if (typeof args.judge === "string" && TREE_FIELDS.judge.slice(1).includes(args.judge)) {
            st.judgeProposal = args.judge;
            st.judgeReason = typeof args.reason === "string" ? args.reason.slice(0, 200) : "";
            const e = { ts: Date.now(), source: "agent", text: `判型建议→${args.judge === "engineering" ? "工程" : "探索"}（待用户开工确认）` };
            st.log.push(e);
            preLog.push(e);
          }
        }
        delete effPatch.propose;
        if (args.action === "set_recommend") {
          delete effPatch.mode; delete effPatch.ask; delete effPatch.learn;
          if (typeof args.mode === "string" && PRESET_IDS.includes(args.mode)) effPatch.modeProposal = args.mode;
          if (typeof args.ask === "string" && TREE_FIELDS.askPolicy.slice(1).includes(args.ask)) effPatch.askProposal = args.ask;
          if (typeof args.learn === "string" && TREE_FIELDS.learnNeed.slice(1).includes(args.learn)) effPatch.learnProposal = args.learn;
        }
        if (args.action === "set_triage") {
          if (typeof args.goalConfirm === "string" && args.goalConfirm === "confirmed") effPatch.goalConfirmed = "confirmed";
          if (typeof args.learnNote === "string") effPatch.learnNote = args.learnNote.slice(0, 300);
          if (typeof effPatch.askPolicy === "string" && typeof effPatch.learnNeed === "string" && st.goalConfirmed === "confirmed" && st.judge !== "unset") effPatch.triageAsked = "asked";
        }
        const { appended } = applyPatch(st, effPatch, "agent");
        await store.save(sid, st);
        await appendLogSidecar(sid, [...preLog, ...appended]);
      }
      const e = effectiveEdges(st);
      const derived = deriveCombo(st);
      const est = estimate(st);
      return {
        judge: st.judge,
        judgeProposal: st.judgeProposal,
        judgeReason: st.judgeReason,
        outputStyle: st.outputStyle,
        assistLevel: st.assistLevel,
        cardCap: st.cardCap,
        freezeForQuestion: st.freezeForQuestion,
      layering: st.layering,
      attackGate: st.attackGate,
      auditGate: st.auditGate,
      exploreAttackGate: st.exploreAttackGate,
      exploreAuditGate: st.exploreAuditGate,
      gateExplicit: Array.isArray(st.gateExplicit) ? st.gateExplicit.slice(0, 12) : [],
      segment: e.segment,
        missingPolicy: st.missingPolicy,
        compoundPhase: st.compoundPhase,
        releaseGate: st.releaseGate,
        reworkMode: st.reworkMode,
        reworkMax: st.reworkMax,
        reworkLineActive: e.reworkLine,
        attackLineActive: e.attackAgent,
        auditLineActive: e.auditAgent,
        logSeen: st.logSeen,
        logRead: st.logRead,
        tokenX: est.tokenX,
        timeX: est.timeX,
        estNote: est.note,
        estSummary: est.estSummary,
        askPolicy: st.askPolicy,
        learnNeed: st.learnNeed,
        triageAsked: st.triageAsked,
        goalConfirmed: st.goalConfirmed,
        modeConfirmed: st.modeConfirmed,
        modeProposal: st.modeProposal,
        modeReason: st.modeReason,
        askProposal: st.askProposal,
        askReason: st.askReason,
        learnProposal: st.learnProposal,
        learnReason: st.learnReason,
        learnNote: st.learnNote,
        reviewSheet: st.reviewSheet,
        path: derived.path,
        pathLabel: derived.pathLabel,
        directive: buildDirective(st),
        projectGoal: st.projectGoal,
        conversationGoal: st.conversationGoal,
        currentNode: st.currentNode,
        currentNodeLabel: nodeLabel(st.currentNode),
        visitedCount: st.visited.length,
        lastNote: st.lastNote,
        updatedAt: st.updatedAt
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "驾驭工程 · 代理树面板",
      kind: "other",
      rawInput: args
    })
  };
}

// ── 工具门禁（2026-10-01 v0.15.0 拆减）──
// 历史：本插件曾在 ctx.tools.guard 注册 G1–G5 五道门禁（冻结期拒派/五问未完成/丙段逐字/卡上限/未答即冻结）
// 与档位开关、记账字典。2026-10-01 用户拍板取消工具级门禁（约束分档实验收官）：
// A 类约束转为提示词强约束（SKILL §10.9.0）+ 合规审计事后记账；面板保留为可选观测/同步面。
// 仅保留 B17 预设门禁（非 harness 会话拒绝 harness_flow——防工具描述泄漏进其他模式的会话）。
function makeToolGuards(store, ctx) {
  return [
    {
      // B17（2026-09-25）：预设门禁——非 harness 会话一律拒绝 harness_flow。
      // 立法依据：用户 2026-09-25 B16 拍板「不启动驾驭工程预设时不注入任何驾驭工程内容」。
      // 实测事故：standard 会话的模型读到工具 description 后自行走判型 + 开局五问。
      // fail-open 仅限 agentPresets 服务不可达（合成测试环境），真机必有该服务。
      name: "harness-flow: 预设门禁（非 harness 会话不适用）",
      guard: (exec) => {
        try {
          const toolName = exec?.name ?? exec?.tool ?? "";
          if (toolName !== "harness_flow") return undefined;   // 不误伤任何其他工具
          const pid = composedPresetOf(exec?.agent, ctx);
          if (pid === undefined) return undefined;             // 服务不可达 → fail-open
          if (pid === "harness") return undefined;             // 正主 → 放行
          return "拒绝：本会话不是 harness（驾驭工程模式）preset（agentPreset=" + pid
            + "），harness_flow 不适用，本次调用未执行、未写入任何状态。"
            + "请忽略本工具描述中的全部流程要求（判型 / 开局五问 / 三层编排 / 过程硬约束），"
            + "按常规方式继续工作，不要再调用本工具。";
        } catch {
          return undefined;
        }
      }
    }
  ];
}

// ── 插件入口 ────────────────────────────────────────────────────────────────
function apply(ctx) {
  const store = makeStore();
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register(makeStateRoute(store));
    const disposeTool = ctx.tools.register(makeTool(store, ctx));
    // 工具门禁（v0.15.0 起仅 B17 预设门禁；G1–G5 已取消）：宿主不支持 ctx.tools.guard 时静默跳过
    const guardDisposers = [];
    const guardOk = typeof ctx.tools?.guard === "function";
    if (guardOk) {
      for (const g of makeToolGuards(store, ctx)) {
        try {
          guardDisposers.push(ctx.tools.guard(g.guard));
          console.log("[harness-flow] 工具门禁已注册: " + g.name);
        } catch (e) {
          console.log("[harness-flow] 工具门禁注册失败: " + g.name + " — " + (e?.message ?? e));
        }
      }
    } else {
      // 宿主版本无 tools.guard：预设门禁不可用，但 makeTool.execute 内还有 fail-closed 兜底
      console.log("[harness-flow] 警告：宿主 ctx.tools.guard 不可用 —— 预设门禁退化为 execute 内 fail-closed 兜底");
    }
    // 每轮上下文注入：variable provider 每轮 pre-step 以 {agent} 求值（assembleContextFor），
    // 同步读内存缓存；会话尚无面板状态时返回空文本（context 空文本会被过滤，零开销）。
    const disposeContext = ctx.systemPrompt.context({
      name: "harness:flow-state",
      order: 80,
      text: "{{harness_flow_panel}}"
    });
    const disposeVariable = ctx.systemPrompt.variable("harness_flow_panel", (assemblyCtx) => {
      try {
        // B16（2026-09-25 用户拍板「不启动驾驭工程预设时不注入任何驾驭工程内容」）：预设门禁——
        // 用 dsh 官方 agentPresets.composedPreset（读 live scope chain，子代理随父组合）判定会话预设；
        // 非 harness 一律返回空文本（dsh 对空 context 段过滤）。合成测试环境无该服务时回退旧行为（真机必有）。
        const ap = ctx.get?.("agentPresets");
        if (!ap || typeof ap.composedPreset !== "function") {
          if (!globalThis.__harnessB16Warned) { globalThis.__harnessB16Warned = true; try { console.warn("[harness-flow] B16 诊断：agentPresets 服务不可达，预设门禁回退为旧行为（每进程仅告警一次）"); } catch {} }
        }
        if (ap && typeof ap.composedPreset === "function") {
          let pid = undefined;
          try { pid = ap.composedPreset(assemblyCtx?.agent?.ctx ?? assemblyCtx?.agent ?? assemblyCtx); } catch {}
          if (pid !== "harness") return "";
        }
        const sid = assemblyCtx?.agent?.session?.id;
        if (typeof sid !== "string" || sid === "") return "";
        const st = store.peek(sid);
        if (!st) return "";
        return renderStateBlock(st);
      } catch {
        return "";
      }
    });
    return () => {
      try { disposeRoute(); } catch {}
      try { disposeTool(); } catch {}
      for (const d of guardDisposers) { try { d(); } catch {} }
      try { disposeContext(); } catch {}
      try { disposeVariable(); } catch {}
    };
  }, "harness-flow: state route + model tool + per-turn context injection");
}

export { NODES, NODE_IDS, PRESETS, PRESET_IDS, TREE_FIELDS, TOOL_OUTPUT_SCHEMA, TOOL_PARAMS, apply, inject, name, composedPresetOf, makeTool, makeToolGuards };
