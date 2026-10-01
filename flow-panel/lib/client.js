// dsh-harness-flow · Client 半（浏览器 bundle，__ModuleLoader__ 形态，零构建）
// 顶栏「驾驭工程」按钮 → 按钮下方拉出小窗（按重要性与逻辑排序）：
//   ① 判型（工程/探索/复合——任务性质，最上）
//   ② 三档工作模式（整组预设；树上节点可点调旋钮，偏离预设=自定义）
//   ③ SVG 流程树（极简盒子 + 流程线 + 回传箭头 + 活动亮灯 + 回传行审查红点；探索模式=探索工作流标签）
//   ④ 任务三问 + 目标（①提问授权 ②学习需求 ③对话目标复述确认 + 项目总目标，未设默认与对话目标一致）
//   ⑤ 输出风格三档 ⑥ 留痕日志（可折叠 + 未读红点；外部=数字角标）
// 面板状态由 Host 半每轮注入模型上下文（systemPrompt.variable）。
// 门禁：仅 projectionValues.agentPreset === "harness"（字符串口径）会话渲染。

window.__ModuleLoader__.load({
	id: "dsh-harness-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

		// ── 阶段主线（与 Host 半 NODES 同源） ─────────────────────────────────
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
		const stageIndex = (id) => Math.max(0, NODES.findIndex((n) => n.id === id));
		// 工作模式三档：combo 必须与 host PRESETS.combo 同源（一致性机检 ⑨ 逐值核对）。
		// 为什么 client 也要这份数据：草稿态下点预设只暂存 path，而树/旋钮读的是组合字段——
		// 不在本地展开就会「点了工作模式但树不变」（2026-09-22 用户实测指出）。
		const PRESETS = [
			{ id: "simple", label: "简约", combo: { layering: "one", attackGate: "skip", auditGate: "skip", exploreAttackGate: "skip", exploreAuditGate: "skip", releaseGate: "user", reworkMode: "report" }, desc: "主代理直接干（设计/图形/UI 类工作也走这里）" },
			{ id: "standard", label: "一般", combo: { layering: "three", attackGate: "skip", auditGate: "skip", exploreAttackGate: "skip", exploreAuditGate: "skip", releaseGate: "user", reworkMode: "loop" }, desc: "立项后不再攻击，走流程（三层+返工循环）" },
			{ id: "full", label: "复杂", combo: { layering: "three", attackGate: "on", auditGate: "on", exploreAttackGate: "on", exploreAuditGate: "on", releaseGate: "user", reworkMode: "loop" }, desc: "完整流程（三层+攻击门+审核+返工循环）" }
		];
		const COMBO_FIELDS = ["layering", "attackGate", "auditGate", "exploreAttackGate", "exploreAuditGate", "releaseGate", "reworkMode"];
		// 按传入取值函数派生 path（口径与 host deriveCombo 一致：命中预设=预设 id，否则 custom）
		const derivePathFrom = (get) => {
			const hit = PRESETS.find((p) => COMBO_FIELDS.every((f) => p.combo[f] === get(f)));
			return hit ? hit.id : "custom";
		};
		const OUTPUT_STYLES = [
			{ value: "minimal", label: "A 极简", desc: "非必要不在对话框中赘述，所有必须的汇报只保留必须骨干，复杂结果及汇报大白话翻译再输出，输出内容尽可能只保留成果汇报以及能决定用户下一步决策的内容" },
			{ value: "normal", label: "B 普通", desc: "非必要不在对话框中赘述，复杂结果及汇报大白话翻译再输出，输出内容尽可能只保留成果汇报以及能决定用户下一步决策的内容" },
			{ value: "free", label: "C 无约束", desc: "无任何约束，模型自己稍微减少输出内容即可" }
		];
		// 辅助程度（2026-09-19 用户新增，默认质疑）
		const ASSIST_LEVELS = [
			{ value: "challenge", label: "质疑（默认）", desc: "用户主张当假设处理：涉及事实、数据、口径、可行性、验收的陈述先自查（能查的查、能测的测），把「已核实 / 与事实不符 / 无法核实」写进条款或交付说明；冲突当场指出并给依据，不顺着说。用户已明确拍板的偏好与产品决策照办，不反复纠缠" },
			{ value: "trust", label: "默认用户正确", desc: "按用户所述执行，不主动质疑、不替用户改口径；仅当你握有硬证据（实测数据 / 可复现反例 / 文件物证）且不纠正会导致返工级后果时，提示一次分歧并给出证据，用户坚持则照办并在交付注明" }
		];
		// 执行卡上限（2026-09-19 用户新增；实测一案自定 13 张卡致 3700 万 input tokens / 174 分钟）
		const CARD_CAPS = [
			{ value: "2", label: "2 张", desc: "最小拆分：适合单一交付物或强耦合的任务" },
			{ value: "4", label: "4 张（默认）", desc: "主控可自派的孙代理卡数上限=4；需要更多卡必须先冻结并逐级上报由用户裁定。一卡=一个可独立验收的交付物，禁止按知识点/章节/文件把同一件事切碎；返工卡不重复计数" },
			{ value: "6", label: "6 张", desc: "中等规模：确有多个可独立验收的交付物时使用" },
			{ value: "8", label: "8 张", desc: "大规模：成本显著上升，面板按 8 张计入预估倍率" },
			{ value: "none", label: "不限", desc: "由主控自行决定卡数（成本自负；面板按 8 张保守估）。仅在用户明示时使用" }
		];
		const JUDGE_LABEL = { engineering: "工程模式", exploration: "探索模式", compound: "复合模式" };
		const JUDGE_FULL = { engineering: "工程模式（目标明确，直接开工）", exploration: "探索模式（尽可能探索所有可能方向）", compound: "复合模式（先探索再驾驭）" };
		const JUDGE_DESC = {
			engineering: "适用于目标明确的任务，一般情况下通用",
			exploration: "更多为辅助用户探索思路，适用于目标完全不清晰的情况，要实际工作则转复合模式",
			compound: "先探索再工程，适用边界条件繁多且极其复杂的任务",
			unset: ""
		};
		// 判型 × 工作模式 说明矩阵（用户口径 2026-09-19）
		const MODE_DESC = {
			engineering: {
				simple: "适用很简单的任务（设计/图形/UI 类工作也走这里）",
				standard: "最常用的工作模式",
				full: "适用于明确目标的工程级任务"
			},
			exploration: {
				simple: "这玩意和 X 包的区别就是这玩意要花你的钱",
				standard: "正常探索任务都走这里，效果很好",
				full: "应该鸟用没有纯浪费钱，占位用的别管"
			},
			compound: {
				simple: "简单但你完全不知道怎么做的任务走适用",
				standard: "较为复杂且你完全毫无头绪的任务适用",
				full: "警告：复杂的工作流程不能直接保障产物质量，请谨慎使用"
			}
		};
		const MODE_DESC_CUSTOM = "自己决定工作流";
		const modeDesc = (judge, path) => path === "custom" ? MODE_DESC_CUSTOM : ((MODE_DESC[judge] ?? MODE_DESC.engineering)[path] ?? "");
		// 空态兜底：键集必须 ⊇ Host initState 的键（X-6/F15 类事故——首帧未 GET 前读到 undefined 会渲染出
		// 「AI 推荐：undefined」之类错帧；本轮架构攻击实测 v0.11.0 新增的 7 个推荐字段曾漏回填，已补齐）。
		const EMPTY_STATE = { version: 3, sessionId: "", judge: "unset", judgeProposal: "", judgeReason: "", layering: "three", attackGate: "skip", auditGate: "skip", exploreAttackGate: "skip", exploreAuditGate: "skip", missingPolicy: "unset", compoundPhase: "explore", releaseGate: "user", reworkMode: "loop", reworkMax: 2, askPolicy: "unset", learnNeed: "unset", learnNote: "", triageAsked: "unset", goalConfirmed: "unset", modeConfirmed: "unset", modeProposal: "", modeReason: "", askProposal: "", askReason: "", learnProposal: "", learnReason: "", reviewSheet: "on", outputStyle: "minimal", assistLevel: "challenge", cardCap: "4", freezeForQuestion: "clear", gateExplicit: [], path: "standard", projectGoal: "", conversationGoal: "", currentNode: "intent", visited: ["intent"], lastNote: "", logSeen: 0, logRead: 0, log: [], logArchivePath: "", updatedAt: 0 };

		// 会话树「首次见到」时间（计时起点）：宿主投影不提供会话创建时间（实测只有 updatedAt），
		// 故由面板本地记录——首次观察到该会话树时写一次 localStorage，之后读回；刷新/重启不丢。
		// key 前缀带插件名，避免与其他插件冲突；读失败（隐私模式等）返回 0，调用方显示「—」。
		const FIRST_SEEN_PREFIX = "dsh-harness-flow:firstSeen:";
		function firstSeenAt(sessionKey) {
			if (typeof sessionKey !== "string" || sessionKey === "") return 0;
			try {
				const key = FIRST_SEEN_PREFIX + sessionKey;
				const raw = window.localStorage.getItem(key);
				const n = raw ? Number(raw) : 0;
				if (Number.isFinite(n) && n > 0) return n;
				const now = Date.now();
				window.localStorage.setItem(key, String(now));
				return now;
			} catch { return 0; }
		}

		async function apiGet(sessionId) {
			const response = await fetch("/api/harness-flow/state?sessionId=" + encodeURIComponent(sessionId), { signal: AbortSignal.timeout(8000) });
			if (!response.ok) throw new Error("HTTP " + response.status);
			return await response.json();
		}
		async function apiPatch(sessionId, patch) {
			const response = await fetch("/api/harness-flow/state", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, patch, source: "ui" }),
				signal: AbortSignal.timeout(8000)
			});
			if (!response.ok) throw new Error("HTTP " + response.status);
			return await response.json();
		}
		// 预估即时预览（2026-09-22 用户要求「一点击就更改」）：把待应用草稿发给 host 试算，只回 est、不落盘。
		// 预估口径仍单源自 host（不在 client 复制估算权重，避免同源漂移）。
		async function apiPreview(sessionId, patch) {
			const response = await fetch("/api/harness-flow/state", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, patch, source: "ui", preview: true }),
				signal: AbortSignal.timeout(8000)
			});
			if (!response.ok) throw new Error("HTTP " + response.status);
			return await response.json();
		}

		// 字体整体加大：基准 15px
		const S = {
			chip: { display: "inline-flex", alignItems: "center", border: "none", cursor: "pointer", background: "transparent", borderRadius: "12px", padding: "4px 9px", fontSize: "14px", fontWeight: 500, lineHeight: "21px", color: "var(--dsw-alias-label-secondary, #666)" },
			chipActive: { background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))", color: "var(--dsw-alias-label-primary, #222)" },
			// 顶栏胶囊（参考用户给的样式：浅底细边圆角胶囊 + 图标 | 分隔线 + 下拉箭头）
			chipPill: { display: "inline-flex", alignItems: "stretch", border: "1px solid var(--dsw-alias-border-l3, #e0e0e4)", background: "var(--dsw-alias-bg-base, #fff)", borderRadius: "18px", padding: 0, cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,.06)", lineHeight: 1 },
			chipPillOn: { border: "1px solid var(--dsw-alias-border-l4, #c9c9cf)", boxShadow: "0 1px 6px rgba(0,0,0,.10)" },
			chipSeg: { display: "inline-flex", alignItems: "center", gap: "7px", padding: "5px 11px", fontSize: "13.5px", fontWeight: 500, color: "var(--dsw-alias-label-secondary, #5b5b63)" },
			chipArrow: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "30px", borderLeft: "1px solid var(--dsw-alias-border-l3, #e6e6ea)", color: "var(--dsw-alias-label-tertiary, #8a8a92)" },
			panel: { position: "fixed", width: "500px", overflowY: "auto", zIndex: 80, background: "var(--dsw-alias-bg-base, #fff)", border: "1px solid var(--dsw-alias-border-l3, #e5e5e5)", borderRadius: "14px", boxShadow: "0 8px 32px rgba(0,0,0,.16)", padding: "14px 16px", fontSize: "15px", lineHeight: "22px", color: "var(--dsw-alias-label-primary, #222)", textAlign: "left" },
			panelHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", fontWeight: 600, fontSize: "16px" },
			sectionLabel: { fontSize: "13.5px", color: "var(--dsw-alias-label-tertiary, #999)", margin: "10px 0 5px 0" },
			sectionTitle: { fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary, #222)", margin: "14px 0 6px 0" },
			qHead: { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 8px", fontSize: "14.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)", margin: "11px 0 4px 0" },
			qHint: { fontSize: "13px", fontWeight: 400, color: "var(--dsw-alias-label-tertiary, #999)", margin: "0 0 4px 0" },
			okTag: { fontSize: "13px", fontWeight: 400, color: "var(--dsw-alias-state-success-primary, #16a34a)", whiteSpace: "nowrap" },
			warnTag: { fontSize: "13px", fontWeight: 400, color: "var(--dsw-alias-state-warning-primary, #b45309)", whiteSpace: "nowrap" },
			knobMenu: { border: "1px solid var(--dsw-alias-border-l3, #d4d4d8)", borderRadius: "10px", padding: "9px 11px", margin: "6px 0 2px 0", fontSize: "13.5px", background: "var(--dsw-alias-bg-base, #fff)" },
			nodeRole: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #999)" },
			segRow: { display: "flex", gap: "6px" },
			segBtn: { flex: "1 1 0", border: "1px solid var(--dsw-alias-border-l3, #ddd)", background: "transparent", borderRadius: "10px", padding: "6px 9px", fontSize: "14.5px", cursor: "pointer", color: "var(--dsw-alias-label-secondary, #666)", textAlign: "center" },
			segBtnActive: { border: "1px solid var(--dsw-alias-state-business-primary, #2563eb)", color: "var(--dsw-alias-state-business-primary, #2563eb)", background: "var(--dsw-alias-state-business-tertiary, rgba(59,130,246,.08))", fontWeight: 600 },
			segDesc: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #999)", marginTop: "5px" },
			// 说明折叠（第 6 条）：平时只留一个「▸ 说明」，点击才从下方浮现灰字
			descToggle: { border: "none", background: "transparent", padding: 0, fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)", cursor: "pointer" },
			treeWrap: { border: "1px solid var(--dsw-alias-border-l3, #e5e5e5)", borderRadius: "10px", padding: "10px 10px 6px 10px", margin: "0 0 12px 0", background: "var(--dsw-alias-bg-subtle, rgba(0,0,0,.02))" },
			optRow: { marginTop: "4px", display: "flex", flexWrap: "wrap", gap: "3px" },
			optBtn: { border: "1px solid var(--dsw-alias-border-l3, #ddd)", background: "transparent", borderRadius: "8px", padding: "2px 9px", fontSize: "13px", cursor: "pointer", color: "var(--dsw-alias-label-secondary, #666)", lineHeight: "21px" },
			optBtnActive: { border: "1px solid var(--dsw-alias-state-business-primary, #2563eb)", color: "var(--dsw-alias-state-business-primary, #2563eb)", background: "var(--dsw-alias-state-business-tertiary, rgba(59,130,246,.08))", fontWeight: 600 },
			// 只读选项行（五问 ①② 回显）：仅光标区分，外观与可选项一致
			optBtnReadonly: { cursor: "not-allowed" },
			readonlyNotice: { fontSize: "12.5px", color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: "8px", padding: "4px 9px", marginTop: "5px" },
			loopBox: { border: "1.5px dashed var(--dsw-alias-border-l4, #bbb)", borderRadius: "10px", padding: "6px 10px", margin: "8px 0", fontSize: "13.5px" },
			loopBoxCut: { opacity: 0.45 },
			liveRow: { display: "flex", alignItems: "baseline", gap: "6px", fontSize: "13.5px", padding: "2px 0 2px 8px" },
			runDot: { flex: "none" },
			agentLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "330px" },
			goalBlock: { marginBottom: "9px" },
			goalLabel: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #999)", marginBottom: "2px" },
			goalText: { minHeight: "20px", whiteSpace: "pre-wrap", wordBreak: "break-word" },
			goalEdit: { width: "100%", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l3, #ddd)", borderRadius: "8px", padding: "7px 10px", fontSize: "14px", fontFamily: "inherit", resize: "vertical" },
			confirmBtn: { border: "1px solid var(--dsw-alias-state-business-primary, #2563eb)", background: "var(--dsw-alias-state-business-tertiary, rgba(59,130,246,.08))", borderRadius: "9px", padding: "2px 10px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer", color: "var(--dsw-alias-state-business-primary, #2563eb)", whiteSpace: "nowrap" },
			smallBtn: { border: "1px solid var(--dsw-alias-border-l3, #ddd)", background: "transparent", borderRadius: "9px", padding: "2px 9px", fontSize: "13px", cursor: "pointer", color: "var(--dsw-alias-label-secondary, #666)", marginLeft: "6px" },
			logRow: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			hint: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #999)", borderTop: "1px solid var(--dsw-alias-border-l3, #eee)", marginTop: "8px", paddingTop: "6px" },
			// 草稿应用条（⑤）：改动只暂存，点「应用」才落盘。
			// 第 3 条（2026-09-22 用户要求）：改为**常驻悬浮在面板内顶部**——面板滚动时始终可见，
			// 且 zIndex 高于内容（sticky 需在有滚动容器的面板里生效，故面板 padding 由内容自理）。
			draftBar: { position: "sticky", top: "0px", zIndex: 30, display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", border: "1px solid var(--dsw-alias-state-business-primary, #2563eb)", background: "#eff6ff", boxShadow: "0 3px 10px rgba(0,0,0,.10)", borderRadius: "10px", padding: "7px 11px", margin: "4px 0 8px 0", fontSize: "13.5px" },
			applyBtn: { border: "1px solid var(--dsw-alias-state-business-primary, #2563eb)", background: "var(--dsw-alias-state-business-primary, #2563eb)", color: "#fff", borderRadius: "8px", padding: "3px 12px", fontSize: "13.5px", fontWeight: 700, cursor: "pointer" },
			cancelBtn: { border: "1px solid var(--dsw-alias-border-l3, #d4d4d8)", background: "transparent", borderRadius: "8px", padding: "3px 12px", fontSize: "13.5px", cursor: "pointer", color: "var(--dsw-alias-label-secondary, #666)" },
			// 冻结旗（⑥）
			frozenTag: { fontSize: "13px", fontWeight: 700, color: "#92400e", background: "#fde68a", border: "1px solid #f59e0b", borderRadius: "8px", padding: "1px 8px", whiteSpace: "nowrap" },
			err: { color: "var(--dsw-alias-state-error-primary, #c33)", fontSize: "13px" },
			warn: { color: "var(--dsw-alias-state-warning-primary, #b45309)", fontSize: "13px" },
			reviewMenu: { border: "1.5px solid #ef4444", borderRadius: "10px", padding: "8px 10px", margin: "6px 0 2px 0", fontSize: "13.5px", background: "#fff" },
			autoBtn: { border: "1px solid var(--dsw-alias-border-l3, #d4d4d8)", background: "transparent", borderRadius: "9px", padding: "3px 11px", fontSize: "13px", fontWeight: 600, cursor: "pointer", color: "var(--dsw-alias-label-secondary, #666)" },
			autoBtnOn: { border: "1px solid #f59e0b", background: "linear-gradient(135deg, #fef3c7, #fde68a)", color: "#92400e" },
			autoTag: { fontSize: "13px", fontWeight: 700, color: "#92400e", background: "#fde68a", border: "1px solid #f59e0b", borderRadius: "8px", padding: "1px 8px", whiteSpace: "nowrap" },
			manualTag: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary, #999)", border: "1px solid var(--dsw-alias-border-l3, #d4d4d8)", borderRadius: "8px", padding: "1px 8px", whiteSpace: "nowrap" },
			estTag: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-state-business-primary, #2563eb)", background: "var(--dsw-alias-state-business-tertiary, rgba(59,130,246,.08))", border: "1px solid rgba(37,99,235,.35)", borderRadius: "8px", padding: "1px 8px", whiteSpace: "nowrap", cursor: "help" },
			// 分组分割线（2026-09-22 用户要求：各大部分之间画一条线，与「操作留痕」同款）
			sep: { borderTop: "1px solid var(--dsw-alias-border-l3, #eee)", margin: "11px 0 0 0" },
			tagInline: { fontSize: "13px", fontWeight: 400, color: "var(--dsw-alias-label-tertiary, #999)", flex: "0 1 auto", minWidth: 0 },
			valueText: { fontWeight: 500, color: "var(--dsw-alias-label-primary, #222)" },
			bodyText: { fontSize: "14px", fontWeight: 400, color: "var(--dsw-alias-label-secondary, #52525b)" },
			logToggle: { border: "none", background: "transparent", padding: 0, fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #666)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px" },
			logDot: { width: "6px", height: "6px", borderRadius: "50%", background: "#ef4444", display: "inline-block" },
			confirmBar: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", border: "1px solid #f59e0b", background: "#fffbeb", borderRadius: "10px", padding: "6px 10px", marginTop: "8px", fontSize: "12.5px" },
			goalBox: { border: "1px solid var(--dsw-alias-border-l3, #d4d4d8)", borderRadius: "8px", padding: "7px 10px", minHeight: "22px", background: "var(--dsw-alias-bg-base, #fff)", fontSize: "14.5px", whiteSpace: "pre-wrap", wordBreak: "break-word" },
			badge: { position: "absolute", top: "-6px", right: "-6px", minWidth: "17px", height: "17px", borderRadius: "9px", background: "#ef4444", color: "#fff", fontSize: "11px", fontWeight: 700, lineHeight: "18px", textAlign: "center", padding: "0 5px", boxSizing: "border-box", pointerEvents: "none", boxShadow: "0 0 0 2px var(--dsw-alias-bg-base, #fff)" }
		};
		const FLIP_CSS = "@keyframes harnessFlipL { 0% { transform: rotateY(-88deg); opacity: .15; } 100% { transform: rotateY(0deg); opacity: 1; } } @keyframes harnessFlipR { 0% { transform: rotateY(88deg); opacity: .15; } 100% { transform: rotateY(0deg); opacity: 1; } }";

		// ── 目标块 ──────────────────────────────────────────────────────────────
		function GoalBlock(props) {
			const { label, value, placeholder, onSave, tag, inlineHint } = props;
			const [draft, setDraft] = react.useState(value ?? "");
			const [saving, setSaving] = react.useState(false);
			react.useEffect(() => { setDraft(value ?? ""); }, [value]);
			const dirty = (draft ?? "") !== (value ?? "");
			const save = async () => {
				if (!dirty || saving) return;
				setSaving(true);
				try { await onSave(draft ?? ""); } finally { setSaving(false); }
			};
			return h("div", { style: { marginBottom: "10px" } },
				h("div", { style: { display: "flex", alignItems: "baseline", gap: "7px", flexWrap: "wrap" } },
					h("div", { style: { ...S.qHead, margin: "0 0 4px 0" } }, label),
					inlineHint ? h("span", { style: S.tagInline }, inlineHint) : null,
					tag ?? null,
					dirty ? h("span", { style: S.warnTag }, "未保存") : null),
				h("textarea", {
					style: S.goalEdit, rows: 2, value: draft, placeholder,
					onChange: (e) => setDraft(e.target.value),
					onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } }
				}),
				h("button", { style: { ...S.smallBtn, marginLeft: 0, marginTop: "4px" }, disabled: saving || !dirty, onClick: save }, saving ? "保存中…" : "保存"));
		}

		// 只读选项行（开局五问 ①② 用，2026-09-23 用户要求）：
		// 外观与可选项行一致（美观统一），但点击不改变任何值——从下方浮现提示，
		// 因为这两问的权威控件在面板顶部（「任务性质」「工作模式」），此处仅作回显。
		function ReadOnlyOptRow(props) {
			const { options, current, hint } = props;
			const [notice, setNotice] = react.useState(false);
			const timer = react.useRef(null);
			react.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
			const block = (e) => {
				e.stopPropagation();
				setNotice(true);
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => setNotice(false), 3600);
			};
			return h("div", null,
				h("div", { style: S.optRow },
					options.map((o) => h("button", {
						key: o.value,
						style: Object.assign({}, S.optBtn, current === o.value ? S.optBtnActive : null, S.optBtnReadonly),
						title: "仅供浏览——更改请到面板最上方的「" + hint + "」",
						onClick: block
					}, o.label))),
				notice ? h("div", { style: S.readonlyNotice }, "当前选项仅供浏览——更改请到面板最上方的「" + hint + "」处调整") : null);
		}

		// ── 节点下的选项组 ─────────────────────────────────────────────────────
		function OptRow(props) {
			const { options, current, onPick, disabled, disabledWhy } = props;
			if (disabled) return h("div", { style: { ...S.nodeRole, marginTop: "2px" } }, disabledWhy);
			return h("div", { style: S.optRow },
				options.map((o) => h("button", {
					key: o.value,
					style: current === o.value ? { ...S.optBtn, ...S.optBtnActive } : S.optBtn,
					title: o.hint ?? o.label,
					onClick: (e) => { e.stopPropagation(); if (current !== o.value) onPick(o); }
				}, o.label)));
		}

			// 说明折叠：平时隐藏，点击对应按钮后从下方浮现（2026-09-22 用户要求）。
			// 语义：①点「▸ 说明」手动开合；②点任一档位按钮时，该区块的说明自动展开一次（让用户看到新档位含义）；
			//       在组件外通过 pulse（每次递增的计数）触发——同值不重复触发，故连点同一区块只会展开一次。
			function CollapsibleDesc(props) {
				const { text, pulse } = props;
				const [open, setOpen] = react.useState(false);
				const last = react.useRef(pulse ?? 0);
				react.useEffect(() => {
					if ((pulse ?? 0) !== last.current) { last.current = pulse ?? 0; setOpen(true); }
				}, [pulse]);
				const hasText = typeof text === "string" && text.trim() !== "";
				if (!hasText) return null;
				return h("div", { style: { marginTop: "4px" } },
					h("button", {
						style: S.descToggle,
						onClick: (e) => { e.stopPropagation(); setOpen((v) => !v); },
						title: open ? "收起说明" : "展开说明"
					}, open ? "▾ 说明" : "▸ 说明"),
					open ? h("div", { style: S.segDesc }, text) : null);
			}

		// ── SVG 流程树（直线箭头 + 字嵌线内 + 跑马灯高亮 + 独立攻击/审计代理卡 + 复合翻面） ──
		// 布局：one=用户↔主代理；two=用户↔主代理↔子代理（工程=执行；探索=逐维调查）；
		// three=四层链（工程=下发条款/发卡·打回；探索=给初步维度/扩展维度后的调查任务）；
		// 攻击代理（主代理左）与审计代理（主代理右）为独立子代理卡，点卡即开关；简约（一层）不显示。
		// 复合模式：探索阶段=探索链 + 用户卡右「进入驾驭工程」卡（点卡翻面）；驾驭阶段=工程链 + 用户卡=探索成果（点卡翻回）。
		function SvgTree(props) {
			const { st, liveTree, onReviewDot, onNodeClick, onFlipCompound, awaitingUser, masterRunning: masterRunningProp, patch, stage, eff } = props;
			const one = eff("layering") === "one";
			const two = eff("layering") === "two";
			const childLayer = !one;
			const compoundEng = eff("judge") === "compound" && eff("compoundPhase") === "engineering";
			const exploring = eff("judge") === "exploration" || (eff("judge") === "compound" && !compoundEng);
			// 第 5 条（2026-09-23 用户要求两段分开调）：侧卡读**当前段**的开关。
			// 段判定与 host effectiveEdges 同源；gateField 供渲染与点击共用（顶层作用域，勿下沉到 if 块内）。
			const segKey = exploring ? "explore" : "engineer";
			const segTag = exploring ? "探索段" : "工程段";
			const gateField = (kind) => segKey === "explore" ? (kind === "attack" ? "exploreAttackGate" : "exploreAuditGate") : (kind === "attack" ? "attackGate" : "auditGate");
			const children = Array.isArray(liveTree) ? liveTree : [];
			const anyChildRunning = children.some((c) => c.running);
			const anyGrandRunning = children.some((c) => (c.children ?? []).some((g) => g.running));
			// 亮灯必须跟真实运行态：主代理亮 = 根会话自身 running（不是「有子代理在跑」）。
			// 旧实现给主代理传 anyChildRunning，致子代理干活时主代理也被点亮（2026-09-19 用户实测指出）。
			// 根会话 running 由 FlowChip 从 sessions store 的条目自述字段读入（与子代理同一来源）。
			const masterRunning = masterRunningProp === true ? true : masterRunningProp === false ? false : children.length > 0;
			const CX = 250, BW = 168, BH = 48, W = 600, HX = 84;
			const nodes = [];
			const lines = [];
			const mkBox = (y, label, lit, knob, extra) => nodes.push(Object.assign({ y, label, lit, knob }, extra ?? {}));
			const link = (yTop, yBottom, side, label, lit, arrow, review) => {
				const x = CX + (side === "L" ? -HX : HX);
				const mid = (yTop + BH + yBottom) / 2;
				lines.push({
					x1: x, y1: arrow === "down" ? yTop + BH : yBottom, x2: x, y2: arrow === "down" ? yBottom : yTop + BH,
					label, lit, labelX: x, labelY: mid + 3.5, arrow, review
				});
			};
			const hlink = (xFrom, xTo, y, label, lit, arrow, tone) => {
				lines.push({ x1: xFrom, y1: y, x2: xTo, y2: y, label, lit, tone, labelX: (xFrom + xTo) / 2, labelY: y + 3.5, arrow, small: true });
			};
			// ④ 四分支配置表（2026-09-19 重构）：原先四个分支各写一遍 mkBox/link，
			// 改一处逻辑要改四处——F16 就是漏了 one 分支。现改为「布局数据表 + 一段统一渲染」：
			// 每个布局只描述「有哪些节点、有哪些连线」，渲染逻辑共享一份；
			// 各分支的差异（阶段标签、节点数、高度）仍是各自独立可调的数据，不再复制代码。
			const userCard = (calm) => compoundEng
				? { label: "探索成果（点击返回探索模式）", lit: awaitingUser, knob: null, extra: calm ? { user: true, calm: true, flipBack: true, w: 300, x: CX - 150 } : { user: true, flipBack: true, w: 300, x: CX - 150 } }
				: { label: "用户", lit: awaitingUser, knob: null, extra: calm ? { user: true, calm: true } : { user: true } };
			const LAYOUTS = {
				// 简约：用户 ↔ 主代理（不派子代理）
				one: {
					H: 208,
					nodes: [
						{ y: 24, card: userCard(true) },
						{ y: 150, label: "主代理", lit: masterRunning, knob: "master" }
					],
					links: [
						{ yTop: 24, yBottom: 150, side: "L", label: "提需求 / 提修改", lit: false, arrow: "down" },
						{ yTop: 24, yBottom: 150, side: "R", label: "汇总上报", lit: children.length > 0, arrow: "up" }
					]
				},
				// 两层：父审核子（主代理直接管孙代理）；探索模式=主代理自己扩展维度后发维度调查卡
				two: {
					H: 296,
					nodes: [
						{ y: 20, card: userCard(true) },
						{ y: 120, label: "主代理", lit: masterRunning, knob: "master" },
						{ y: 240, label: exploring ? "孙代理（逐维调查）" : "子代理（执行）", lit: anyGrandRunning, knob: null }
					],
					links: [
						{ yTop: 20, yBottom: 120, side: "L", label: "提需求 / 提修改", lit: false, arrow: "down" },
						{ yTop: 20, yBottom: 120, side: "R", label: "汇总上报", lit: anyChildRunning, arrow: "up" },
						{ yTop: 120, yBottom: 240, side: "L", label: exploring ? "发维度调查卡 / 打回" : "发卡 / 打回", lit: false, arrow: "down" },
						{ yTop: 120, yBottom: 240, side: "R", label: exploring ? "维度调查汇报 / 核签" : "汇报 / 审查记录", lit: anyGrandRunning, arrow: "up", review: true }
					]
				},
				// 三层 · 探索链：主代理给初始维度 → 子代理扩展维度（写理由） → 孙代理逐维调查值
				explore: {
					H: 402,
					nodes: [
						{ y: 18, card: userCard(true) },
						{ y: 118, label: "主代理", lit: masterRunning, knob: "master" },
						{ y: 232, label: "子代理（扩展维度）", lit: anyChildRunning, knob: "control" },
						{ y: 346, label: "孙代理（逐维调查）", lit: anyGrandRunning, knob: null }
					],
					links: [
						{ yTop: 18, yBottom: 118, side: "L", label: compoundEng ? "探索结果 / 新探索要求" : "发要求", lit: false, arrow: "down" },
						{ yTop: 18, yBottom: 118, side: "R", label: "汇总上报", lit: anyChildRunning, arrow: "up" },
						{ yTop: 118, yBottom: 232, side: "L", label: "给初始维度（边界条件）", lit: false, arrow: "down" },
						{ yTop: 118, yBottom: 232, side: "R", label: "整合孙代理成果后汇报", lit: anyChildRunning, arrow: "up" },
						{ yTop: 232, yBottom: 346, side: "L", label: "扩展维度后的逐维调查卡", lit: false, arrow: "down" },
						{ yTop: 232, yBottom: 346, side: "R", label: "维度值与证据回传", lit: anyGrandRunning, arrow: "up", review: true }
					]
				},
				// 三层 · 工程链：下发条款 → 发卡执行
				engineer: {
					H: 402,
					nodes: [
						{ y: 18, card: userCard(false) },
						{ y: 118, label: "主代理", lit: masterRunning, knob: "master" },
						{ y: 232, label: "子代理（主控）", lit: anyChildRunning, knob: "control" },
						{ y: 346, label: "孙代理（执行）", lit: anyGrandRunning, knob: null }
					],
					links: [
						{ yTop: 18, yBottom: 118, side: "L", label: "提需求 / 提修改 / 审批条款", lit: false, arrow: "down" },
						{ yTop: 18, yBottom: 118, side: "R", label: "上报条款 / 汇总结果", lit: anyChildRunning, arrow: "up" },
						{ yTop: 118, yBottom: 232, side: "L", label: "下发条款", lit: false, arrow: "down" },
						{ yTop: 118, yBottom: 232, side: "R", label: "整理后汇报", lit: anyChildRunning, arrow: "up" },
						{ yTop: 232, yBottom: 346, side: "L", label: "发卡 / 打回", lit: false, arrow: "down" },
						{ yTop: 232, yBottom: 346, side: "R", label: "汇报 / 审查记录", lit: anyGrandRunning, arrow: "up", review: true }
					]
				}
			};
			const layout = one ? LAYOUTS.one : two ? LAYOUTS.two : exploring ? LAYOUTS.explore : LAYOUTS.engineer;
			let H = layout.H;
			for (const n of layout.nodes) {
				const label = n.card ? n.card.label : n.label;
				const lit = n.card ? n.card.lit : n.lit;
				const knob = n.card ? n.card.knob : n.knob;
				mkBox(n.y, label, lit, knob, n.card ? n.card.extra : undefined);
			}
			for (const c of layout.links) link(c.yTop, c.yBottom, c.side, c.label, c.lit, c.arrow, c.review);
			const masterY = one ? 150 : two ? 120 : 118;
			if (childLayer) {
				const aOn = eff(gateField("attack")) === "on";
				const dOn = eff(gateField("audit")) === "on";
				const sideW = 40, sideH = 150;
				const sideY = masterY + (BH - sideH) / 2;
				const aX = 6, dX = W - 6 - sideW;
				nodes.push({ x: aX, y: sideY, w: sideW, h: sideH, label: "攻击代理", vertical: true, off: !aOn, dashed: !aOn, toggle: "attack", active: aOn, tip: `攻击代理【${segTag}】${aOn ? "已启动（点击关闭）" : "未启动（点击启动）"}：**派发前**攻初步维度/条款草案 → 补充条款（先攻后派，仅主代理派出；两段独立开关）` });
				nodes.push({ x: dX, y: sideY, w: sideW, h: sideH, label: "审计代理", vertical: true, off: !dOn, dashed: !dOn, toggle: "audit", active: dOn, tip: `高危审计代理【${segTag}】${dOn ? "已启动（点击关闭）" : "未启动（点击启动）"}：**提交后**转发子代理成果 → 提交审计报告（不做修改）（仅主代理派出；两段独立开关）` });
				const midY = masterY + BH / 2;
				// 侧线：未启动=更浅灰（dim），启动=常色灰（normal）——蓝=激活只属于节点亮灯
				// 第 7 条（2026-09-23 用户要求「审计代理部分上下箭头互换位置，别的别动」）：
				// 仅交换审计侧两条线的**上下位置**（转发移到下方、提交移到上方），箭头方向与文案不动。
				hlink(CX - BW / 2, aX + sideW, midY - 11, "派发条款", false, "left", aOn ? "normal" : "dim");
				hlink(aX + sideW, CX - BW / 2, midY + 11, "补充条款", false, "right", aOn ? "normal" : "dim");
				hlink(CX + BW / 2, dX, midY + 11, "转发子代理内容", false, "right", dOn ? "normal" : "dim");
				hlink(dX, CX + BW / 2, midY - 11, "提交审计报告（不做修改）", false, "left", dOn ? "normal" : "dim");
			}
			if (eff("judge") === "compound" && !compoundEng) {
				const cW = 150, cH = 56, cX = CX + BW / 2 + 106, cY = 10;
				nodes.push({ x: cX, y: cY, w: cW, h: cH, label: "进入工程模式", compFlip: "engineering", tip: "点击进入工程模式（放行探索结果）" });
				hlink(CX + BW / 2, cX, cY + cH / 2, "放行探索结果", false, "right");
			}
			const OFFS = { off: "#a1a1aa", on: "#3f3f46" };
			// viewBox 600 渲染于 ~470px（0.78 缩放）——字号按 1.28 倍补偿；长标签自动降档防左右相撞
			const lineLabel = (c) => {
				const long = (c.label ?? "").length > 11;
				return h("text", {
					// 第 6 条（2026-09-23 用户：箭头/连线高亮「很难做好」，去掉）——标签不再随 lit 变蓝，
					// 只按「启用/停用」两态灰阶区分；高亮语义全部交给卡片。
					x: c.labelX, y: c.labelY, fontSize: long ? 13 : (c.small ? 15 : 16),
					fill: c.tone === "dim" ? "#b9b9c0" : "#71717a",
					textAnchor: "middle", style: { paintOrder: "stroke", stroke: "#fff", strokeWidth: 5, fontWeight: 600 }
				}, c.label);
			};
			const renderLines = lines.map((c, i) => h("g", { key: "l" + i },
				h("path", {
					// 第 6 条：连线颜色只由 tone（启用/停用）决定，不再有 lit 高亮态与蓝色发光。
					d: `M ${c.x1} ${c.y1} L ${c.x2} ${c.y2}`, fill: "none",
					stroke: c.tone === "dim" ? "#dcdce0" : "#a1a1aa", strokeWidth: 1.4,
					markerEnd: `url(#arr${c.tone === "dim" ? "Dim" : ""})`
				}),
				c.review
					? h("g", { style: { cursor: "pointer" }, onClick: () => onReviewDot() },
						h("rect", { x: c.labelX - 96, y: c.labelY - 24, width: 210, height: 42, fill: "transparent" }),
						lineLabel(c),
						h("circle", { cx: c.labelX + 76, cy: c.labelY - 12, r: 6, fill: eff("reviewSheet") === "on" ? "#ef4444" : "#16a34a", stroke: "#fff", strokeWidth: 1 }),
						h("title", null, "点击切换审查报告模式（A 子代理只读审查报告 / B 完全审查）"))
					: lineLabel(c)));
			const renderNodes = nodes.map((n, i) => {
				const x = n.x ?? (CX - BW / 2), y = n.y, w = n.w ?? BW, hh = n.h ?? BH;
				const label = n.label;
				const stroke = n.lit ? "#2563eb" : n.off ? "#e4e4e7" : "#a1a1aa";
				const click = n.toggle ? (e) => { e.stopPropagation(); stage(gateField(n.toggle), n.active ? "skip" : "on"); }
					: n.compFlip ? (e) => { e.stopPropagation(); onFlipCompound(n.compFlip); }
						: n.flipBack ? (e) => { e.stopPropagation(); onFlipCompound("explore"); }
							: n.knob ? (e) => { e.stopPropagation(); onNodeClick(n.knob); }
								: undefined;
				return h("g", {
					key: "n" + i,
					className: (n.knob || n.toggle || n.compFlip || n.flipBack) ? "hfNode" : null,
					style: Object.assign({},
						n.lit ? { filter: "drop-shadow(0 0 6px rgba(59,130,246,.55))" } : null,
						click ? { cursor: "pointer" } : null),
					onClick: click
				},
					h("rect", {
						x, y, width: w, height: hh, rx: 3,
						fill: n.lit ? "#eff6ff" : "#fff",
						stroke, strokeWidth: n.lit ? 1.8 : 1.2,
						strokeDasharray: n.dashed ? "4 3" : null
					}),
					// 激活高亮：蓝色实边框（不再用白色虚线绕框）+ 一个代表高光的白点沿边框顺时针绕行。
					// 白点用 SVG animateMotion 沿同一矩形路径循环——比虚线滚动更"活"、不遮挡文字。
					n.lit && !n.calm ? h("rect", {
						x, y, width: w, height: hh, rx: 3, fill: "none",
						stroke: "#2563eb", strokeWidth: 1.8, pointerEvents: "none"
					}) : null,
					n.lit && !n.calm ? h("circle", { r: 2.6, fill: "#ffffff", stroke: "#2563eb", strokeWidth: 0.8, pointerEvents: "none" },
						h("animateMotion", {
							dur: "2.6s", repeatCount: "indefinite",
							path: `M ${x} ${y} H ${x + w} V ${y + hh} H ${x} Z`
						})) : null,
					n.vertical
						? h("text", { x: x + w / 2, y: y + hh / 2, fontSize: 16, fontWeight: 600, fill: n.off ? "#c4c4c8" : "#3f3f46", textAnchor: "middle", style: { writingMode: "vertical-rl", letterSpacing: "1px", textOrientation: "upright" } }, label)
						: h("text", { x: x + w / 2, y: y + hh / 2 + 7, fontSize: 19, fontWeight: 600, fill: n.off ? "#c4c4c8" : n.lit ? "#1d4ed8" : "#3f3f46", textAnchor: "middle" }, label),
					n.tip ? h("title", null, n.tip) : null);
			});
			return h("div", { style: { position: "relative" } },
				h("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "auto", display: "block" } },
					h("defs", null,
						h("marker", { id: "arr", markerWidth: 7, markerHeight: 7, refX: 5.5, refY: 3, orient: "auto" }, h("path", { d: "M0,0 L6,3 L0,6 z", fill: "#a1a1aa" })),
						h("marker", { id: "arrLit", markerWidth: 7, markerHeight: 7, refX: 5.5, refY: 3, orient: "auto" }, h("path", { d: "M0,0 L6,3 L0,6 z", fill: "#2563eb" })),
						h("marker", { id: "arrDim", markerWidth: 7, markerHeight: 7, refX: 5.5, refY: 3, orient: "auto" }, h("path", { d: "M0,0 L6,3 L0,6 z", fill: "#dcdce0" }))),
					renderLines,
					renderNodes));
		}

		// ── 竖向工作树（SVG + 节点旋钮 + 实时孙代理列表 + 返工线 + 审查菜单） ───
		const LAYER_OPTS = [
			{ value: "three", label: "三层（主代理→主控→孙）", hint: "主代理写提示词→主控调度→孙代理干活" },
			{ value: "two", label: "两层（父审核子）", hint: "主代理直接管理孙代理并亲自验收" },
			{ value: "one", label: "一层（主代理直接干）", hint: "不派子代理，含设计/图形/UI 类工作" }
		];
		const KNOB_TITLES = { master: "旋钮 · 主代理（编排）", control: "旋钮 · 子代理（审查方式）" };
		function Tree(props) {
			const { st, liveTree, masterRunning, patch, stage, eff, awaitingUser } = props;
			const one = eff("layering") === "one";
			const childLayer = !one;
			const [showReview, setShowReview] = react.useState(false);
			const [knob, setKnob] = react.useState("");
			const [flip, setFlip] = react.useState(0);
			// 翻面动画跟草稿态走（eff）：点翻面卡 = 暂存阶段变更，树内容已按草稿渲染，
			// 动画若仍读落盘值（st）就会出现「树变了但没翻页」的割裂（2026-09-22 用户报同类缺陷时一并修）。
			const prevPhase = react.useRef(eff("compoundPhase"));
			react.useEffect(() => {
				if (prevPhase.current !== eff("compoundPhase")) {
					prevPhase.current = eff("compoundPhase");
					setFlip((k) => k + 1);
				}
			}, [eff("compoundPhase")]);
			const reviewRef = react.useRef(null);
			react.useEffect(() => {
				if (showReview && reviewRef.current && typeof reviewRef.current.scrollIntoView === "function") {
					reviewRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
				}
			}, [showReview]);
			const children = Array.isArray(liveTree) ? liveTree : [];
			const openKnob = (k) => { setShowReview(false); setKnob((v) => (v === k ? "" : k)); };
			const onFlip = (phase) => { stage("compoundPhase", phase); openKnob(""); };
			return h("div", { style: S.treeWrap },
				h("div", { style: { perspective: "1000px" } },
					h("div", {
						key: flip,
						style: flip > 0 ? { animation: `${eff("compoundPhase") === "engineering" ? "harnessFlipL" : "harnessFlipR"} .62s cubic-bezier(.2,.75,.25,1) both`, transformStyle: "preserve-3d" } : null
					},
						h(SvgTree, { st, liveTree, masterRunning, patch, stage, eff, awaitingUser, onReviewDot: () => { setKnob(""); setShowReview((v) => !v); }, onNodeClick: openKnob, onFlipCompound: (phase) => { openKnob(""); onFlip(phase); } }))),
				knob !== "" ? h("div", { style: S.knobMenu },
					h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, KNOB_TITLES[knob] ?? knob),
					knob === "master" ? h(OptRow, {
						options: LAYER_OPTS,
						current: eff("layering"),
						onPick: (o) => { stage("layering", o.value); if (o.value === "one") setKnob(""); }
					}) : null,
					knob === "control" ? h("div", null,
						h("div", { style: { ...S.qHint, margin: "0 0 3px 0" } }, "审查记录（子代理对孙产出的审查方式）"),
						h(OptRow, {
							options: [
								{ value: "on", label: "A 只读审查报告", hint: "省 token；孙代理的产出可能有问题且无法被检查到" },
								{ value: "off", label: "B 完全审查", hint: "费 token，但可检查到问题" }
							],
							current: eff("reviewSheet"),
							onPick: (o) => { stage("reviewSheet", o.value); }
						})) : null) : null,
				showReview ? h("div", { ref: reviewRef, style: S.reviewMenu },
					h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, "审查报告模式（「汇报 / 审查记录」回传行右上角红点）"),
					h(OptRow, {
						options: [
							{ value: "on", label: "A 子代理只读审查报告", hint: "省 token；孙代理的产出可能有问题且无法被检查到" },
							{ value: "off", label: "B 子代理完全审查孙代理产出", hint: "费 token，但可检查到问题" }
						],
						current: eff("reviewSheet"),
						onPick: (o) => { stage("reviewSheet", o.value); setShowReview(false); }
					}),
					eff("reviewSheet") === "on" ? h("div", { style: S.warn }, "⚠ A 模式风险：孙代理产出可能有问题且无法被检查到——仅用于省 token") : null) : null,
				!childLayer ? null : children.length === 0 ? h("div", { style: { ...S.nodeRole, marginTop: "4px" } }, "（暂无孙代理——派发后实时出现）")
					: h("div", { style: { marginTop: "4px" } }, children.map((child) => {
						const rows = [
							h("div", { key: "c-" + child.id, style: { ...S.liveRow, ...(child.running ? { color: "var(--dsw-alias-state-business-primary, #2563eb)", fontWeight: 600 } : {}) } },
								h("span", { style: { ...S.runDot, color: child.running ? "var(--dsw-alias-state-success-primary, #16a34a)" : "var(--dsw-alias-label-caption, #bbb)" } }, child.running ? "●" : "○"),
								h("span", { style: S.agentLabel, title: child.id }, child.label),
								child.running ? h("span", { style: S.nodeRole }, "↔ 传递中") : null)
						];
						for (const g of (child.children ?? [])) {
							rows.push(h("div", { key: "g-" + g.id, style: { ...S.liveRow, paddingLeft: "20px", ...(g.running ? { color: "var(--dsw-alias-state-business-primary, #2563eb)", fontWeight: 600 } : {}) } },
								h("span", { style: { ...S.runDot, color: g.running ? "var(--dsw-alias-state-success-primary, #16a34a)" : "var(--dsw-alias-label-caption, #bbb)" } }, g.running ? "●" : "○"),
								h("span", { style: S.agentLabel, title: g.id }, g.label),
								g.running ? h("span", { style: S.nodeRole }, "↔ 传递中") : null));
						}
						return rows;
					})),
				h("div", { style: { ...S.loopBox, ...(childLayer ? {} : S.loopBoxCut) } },
					childLayer
						? h("div", null,
							h("div", { style: { fontWeight: 600 } }, "返工循环线 · ", masterLayerText(eff("layering"))),
							h(OptRow, {
								options: [{ value: "loop", label: "循环打回", hint: "打回返工直到通过" }, { value: "limited", label: "限次", hint: `最多打回 ${eff("reworkMax")} 次后带缺陷报告上报` }, { value: "report", label: "直报", hint: "不打回，单次机会直接带缺陷报告上报" }],
								current: eff("reworkMode"),
								onPick: (o) => stage("reworkMode", o.value)
							}),
							eff("reworkMode") === "limited" ? h("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "3px" } },
								"限次 N=",
								h("button", { style: S.optBtn, onClick: (e) => { e.stopPropagation(); stage("reworkMax", Math.max(1, eff("reworkMax") - 1)); } }, "−"),
								h("span", { style: S.valueText }, eff("reworkMax")),
								h("button", { style: S.optBtn, onClick: (e) => { e.stopPropagation(); stage("reworkMax", Math.min(9, eff("reworkMax") + 1)); } }, "+"))
							: null)
						: h("div", null, "返工循环线已停用")));
		}

		// 返工线来自哪一层：按传入的 layering 判定（调用点传草稿合并值 eff("layering")，保证草稿期即时反映）
		const masterLayerText = (layering) => layering === "three" ? "孙→主控" : "子→主代理（父审核子）";

		// 草稿应用条用的「字段中文名 / 取值中文名」表（只用于 UI 展示，判定一律以服务端枚举为准）
		const FIELD_NAMES = { judge: "判型", layering: "编排", attackGate: "攻击代理(工程段)", auditGate: "审计代理(工程段)", exploreAttackGate: "攻击代理(探索段)", exploreAuditGate: "审计代理(探索段)", releaseGate: "放行", reworkMode: "返工", askPolicy: "提问授权", learnNeed: "学习需求", missingPolicy: "关键信息缺失", compoundPhase: "复合阶段", reviewSheet: "审查记录", outputStyle: "输出风格", assistLevel: "辅助程度", cardCap: "执行卡上限", path: "工作模式", freezeForQuestion: "冻结" };
		const LABELS = {
			judge: (v) => JUDGE_LABEL[v] ?? v,
			layering: (v) => (LAYER_OPTS.find((o) => o.value === v)?.label ?? v),
			attackGate: (v) => (v === "on" ? "开" : "关"),
			auditGate: (v) => (v === "on" ? "开" : "关"),
			exploreAttackGate: (v) => (v === "on" ? "开" : "关"),
			exploreAuditGate: (v) => (v === "on" ? "开" : "关"),
			releaseGate: (v) => (v === "auto" ? "全自动" : "需审核"),
			reworkMode: (v) => ({ loop: "循环打回", limited: "限次", report: "直报" }[v] ?? v),
			reviewSheet: (v) => (v === "on" ? "只读审查报告" : "完全审查"),
			missingPolicy: (v) => ({ A: "尝试推理", B: "留空", C: "编造", unset: "默认" }[v] ?? v),
			outputStyle: (v) => (OUTPUT_STYLES.find((o) => o.value === v)?.label ?? v),
			assistLevel: (v) => (ASSIST_LEVELS.find((o) => o.value === v)?.label ?? v),
			cardCap: (v) => (CARD_CAPS.find((o) => o.value === v)?.label ?? v),
			compoundPhase: (v) => (v === "engineering" ? "进入工程模式" : "回到探索模式"),
			path: (v) => (PRESETS.find((p) => p.id === v)?.label ?? v),
			askPolicy: (v) => ({ unlimited95: "无限提问", limited: "有限度提问", noAsk: "不开启", unset: "取消" }[v] ?? v),
			learnNeed: (v) => (v === "unset" ? "取消" : v),
			freezeForQuestion: (v) => (v === "frozen" ? "冻结中" : "已解除")
		};

		// ── 主面板（按钮下方拉出的小窗；按重要性与逻辑排序） ───────────────────
		// 2026-09-19 用户裁定：21 处控件原为「点一下立即落盘」且「再点一次=取消」，
		// 而这些开关是「预先放行」语义——想看别的档位点一下就直接改了模型行为。
		// 改为**草稿态**：点击只改本地高亮（待应用），底部浮出「应用 / 取消」条；点应用才落盘。
		// 附带收益：多次点击合并为一次 PATCH（日志不再被流水备注冲爆，治 A14）。
		function FlowPanel(props) {
			const { sessionId, anchor, onClose, liveTree, masterRunning, usageText, pushState, isSubagentView } = props;
			const [state, setState] = react.useState(EMPTY_STATE);
			const [error, setError] = react.useState("");
			const [edit, setEdit] = react.useState({ field: "", open: false, draft: "", saving: false });
			const [logOpen, setLogOpen] = react.useState(false);
			// 草稿态：{ field: value } 累计待应用的改动；空对象=无待应用
			const [draft, setDraft] = react.useState({});
			const [applying, setApplying] = react.useState(false);
			// 预估即时预览（用户 2026-09-22：「不要等确认修改之后才更改」）：点击控件立刻按草稿合并态试算，
			// 走 host 预览通道（preview:true，不落盘）；无草稿/点「取消」即回落已落盘值。
			const [estPreview, setEstPreview] = react.useState(null);
			const estSeq = react.useRef(0);
			const st = state ?? EMPTY_STATE;
			// 当前生效值 = 草稿优先（UI 高亮立刻响应），未改的取服务端值
			const eff = (field) => (Object.prototype.hasOwnProperty.call(draft, field) ? draft[field] : st[field]);
			const draftKeys = Object.keys(draft);
			const hasDraft = draftKeys.length > 0;

			// ③ 轮询合并（2026-09-19）：面板不再自建定时器——改为复用 FlowChip 的常驻轮询结果
			// （pushState）。原先两条定时器各问各的，最密到 1.5s 一次。
			react.useEffect(() => {
				if (pushState) { setState(pushState); setError(""); }
			}, [pushState]);
			// 首屏兜底：chip 的轮询尚未就绪时自取一次（此后不再自建定时器）
			react.useEffect(() => {
				let stopped = false;
				apiGet(sessionId).then((r) => { if (!stopped && r.ok) setState(r.state); }).catch(() => { if (!stopped) setError("面板通道不可用（host 未重启或插件未挂载）"); });
				return () => { stopped = true; };
			}, [sessionId]);

			// 打开面板即消除外部角标（agent 未读日志清零）
			react.useEffect(() => {
				const now = Date.now();
				apiPatch(sessionId, { logSeen: now }).then((r) => { if (r.ok) setState(r.state); }).catch(() => {});
			}, [sessionId]);

			const patch = async (p) => {
				try {
					const result = await apiPatch(sessionId, p);
					if (result.ok) { rememberEst(result); setState(result.state); setError(""); }
				} catch { setError("切换失败（通道不可用）"); }
			};
			// 高频/无副作用的项走立即落盘（日志已读水位等），不进草稿
			const patchNow = patch;
			// 落盘/试算回包里的预估记入共享读数：否则「应用」后会短暂回到旧值，等下一次轮询才修正
			const rememberEst = (r) => {
				if (!r || !r.ok || !r.est) return;
				const bag = (window.__harnessFlow ??= {});
				bag.estById = Object.assign(bag.estById ?? {}, { [sessionId]: r.est });
			};
			// 开关类控件走草稿：只改本地高亮，不动服务端
			// 语义：①点同组内不同值 → 暂存该值；②再点同一个暂存值 → 撤回该项（回到服务端值）；
			//      ③点回服务端值 → 视为无改动；④「取消选择」（unset）由 pickOrClear 显式传入
			// （stage 实现在下方：组合字段走 stageCombo 重派生 path，其余直存）
			const discardDraft = () => setDraft({});
			// 说明脉冲（第 6 条）：点档位按钮时把该区块的说明自动展开一次。
			// 用「每次点击递增的计数」，同区块连点也只展开一次（值变化才触发 useEffect）。
			const [descPulse, setDescPulse] = react.useState({});
			const pulse = (key) => setDescPulse((p) => ({ ...p, [key]: (p[key] ?? 0) + 1 }));
			// 预设（工作模式三档）暂存：展开成组合字段进草稿——树/旋钮/预估立刻按新组合渲染。
			// 语义：①点别的预设 → 组合与 path 一起暂存；②再点当前已生效（含暂存）的预设 → 撤回；
			//       ③无草稿且服务端就是它 → 无改动。
			const stagePreset = (id) => {
				const preset = PRESETS.find((p) => p.id === id);
				if (!preset) return;
				pulse("path");   // 点工作模式 → 说明浮现一次（第 6 条）
				setDraft((d) => {
					const get = (f) => (Object.prototype.hasOwnProperty.call(d, f) ? d[f] : st[f]);
					const isEffective = get("path") === id && COMBO_FIELDS.every((f) => get(f) === preset.combo[f]);
					const next = { ...d };
					const hasAny = COMBO_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(d, f)) || Object.prototype.hasOwnProperty.call(d, "path");
					if (isEffective) {
						if (!hasAny) return next;              // 服务端本就是它且无草稿 → 无改动
						for (const f of COMBO_FIELDS) delete next[f];
						delete next.path;                      // 撤回 → 回到服务端值
						return next;
					}
					for (const f of COMBO_FIELDS) {
						if (preset.combo[f] === st[f]) delete next[f]; else next[f] = preset.combo[f];
					}
					if (id === st.path) delete next.path; else next.path = id;
					return next;
				});
			};
			// 立即生效的组合字段变更（不进草稿）：用于「全自动」这类**审核权让渡**开关——
			// 用户切到全自动后模型必须马上按新口径工作，等「应用」会造成「面板显示全自动但模型仍在等确认」。
			// 落盘时按当前值重派生 path，保证预设/自定义组合归属正确。
			const stageNow = (field, value) => {
				const probe = Object.assign({}, st, { [field]: value });
				const derived = derivePathFrom((f) => probe[f]);
				const patchBody = { [field]: value, path: derived, note: `UI 立即生效：${FIELD_NAMES[field] ?? field} → ${LABELS[field]?.(value, st) ?? value}` };
				return patch(patchBody);
			};
			// 组合字段（树上旋钮 / 顶栏全自动开关）变更：改该字段后按合并态重派生 path，
			// 否则「改了编排但 path 还写着旧预设 id」——自定义组合徽标与 modeDesc 都会错。
			const stageCombo = (field, value) => {
				setDraft((d) => {
					const next = { ...d };
					const staged = Object.prototype.hasOwnProperty.call(d, field);
					if (staged && d[field] === value) delete next[field];
					else if (!staged && st[field] === value) delete next[field];
					else next[field] = value;
					const get = (f) => (Object.prototype.hasOwnProperty.call(next, f) ? next[f] : st[f]);
					const derived = derivePathFrom(get);
					if (derived === st.path) delete next.path; else next.path = derived;
					return next;
				});
			};
			const stage = (field, value) => {
				pulse(field);   // 点档位 → 该区块说明浮现一次（第 6 条）
				if (COMBO_FIELDS.includes(field)) { stageCombo(field, value); return; }
				setDraft((d) => {
					const next = { ...d };
					const staged = Object.prototype.hasOwnProperty.call(d, field);
					if (staged && d[field] === value) delete next[field];
					else if (!staged && st[field] === value) delete next[field];
					else next[field] = value;
					return next;
				});
			};
			const applyDraft = async () => {
				if (!hasDraft || applying) return;
				setApplying(true);
				try {
					// 合并成一次 PATCH：一次落盘、一组日志（不再逐项刷备注）
					const payload = { ...draft, note: `UI 应用 ${draftKeys.length} 项改动` };
					const result = await apiPatch(sessionId, payload);
					if (result.ok) { rememberEst(result); setState(result.state); setDraft({}); setError(""); }
				} catch { setError("应用失败（通道不可用）"); } finally { setApplying(false); }
			};
			// 预估即时试算：草稿一变就按「已落盘状态 + 草稿」求预估（host 试算副本，不落盘）。
			// 序号防竞态（连点多下时只认最后一次）；清空草稿/请求失败即回落服务端值，避免显示过期数字。
			react.useEffect(() => {
				if (!hasDraft) { setEstPreview(null); return undefined; }
				const seq = ++estSeq.current;
				apiPreview(sessionId, draft).then((r) => {
					if (estSeq.current === seq && r.ok && r.est) setEstPreview(r.est);
				}).catch(() => { if (estSeq.current === seq) setEstPreview(null); });
				return undefined;
			}, [draft]);
			// 冻结旗（⑥）：模型提问落旗后启用——置/清冻结走立即落盘（它本身是状态而非配置）
			const freezeOn = st.freezeForQuestion === "frozen";
			// 草稿摘要（供应用条展示：改了哪几项）
			const draftSummary = draftKeys.map((k) => {
				const v = draft[k];
				const label = LABELS[k]?.(v, st) ?? String(v);
				return `${FIELD_NAMES[k] ?? k}→${label}`;
			}).join("　");
			const fmtTs = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
			const stLog = Array.isArray(st.log) ? st.log : [];
			const unseen = stLog.filter((e) => (e.ts ?? 0) > (st.logRead ?? 0)).length;
			const toggleLog = () => {
				const next = !logOpen;
				setLogOpen(next);
				if (next) patchNow({ logRead: Date.now() });
			};
			// 已选按钮再点一次 = 取消（回 unset）
			const pickOrClear = (field, o, opts) => {
				// 再点已选项 = 取消选择（草稿里的 unset），点别项 = 换选；一律只改草稿
				stage(field, eff(field) === o.value ? "unset" : o.value);
			};
			const auto = eff("releaseGate") === "auto";
			const proposal = st.judgeProposal;
			const data = window.__harnessFlow ?? {};
			const estDraft = estPreview;   // 草稿试算值（有草稿时优先显示，见上面的预览 effect）
			const est = estDraft ?? ((data.estById ?? {})[sessionId] ?? { tokenX: 1, timeX: 1, note: "结构估算" });
			const panelStyle = {
				...S.panel,
				top: anchor.top,
				left: "calc(50% - 250px)",
				maxHeight: "min(780px, calc(100vh - " + (anchor.top + 12) + "px))"
			};
			const autoTag = auto ? h("span", { style: S.autoTag }, "🚀 全自动") : h("span", { style: S.manualTag }, "🖐 需审核");
			return h("div", { style: panelStyle, onClick: (e) => e.stopPropagation() },
				h("style", null, FLIP_CSS),
				h("div", { style: S.panelHead },
					h("span", null, isSubagentView ? "驾驭工程 · 面板（子代理层 · 显示根会话设置）" : "驾驭工程 · 代理树"),
					h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
						h("button", {
							style: auto ? { ...S.autoBtn, ...S.autoBtnOn } : S.autoBtn,
							title: auto ? "当前：全自动——用户审核权全部交由主代理（判型/工作模式/条款放行均由主代理判断并留痕）。点击切回「需审核」" : "当前：需审核——条款/判型等你确认。点击开启全自动（审核权全部交由主代理）",
							// 第 4 条（2026-09-23 用户要求「改完之后马上就是自动的，不要再让我说」）：
							// 全自动=审核权让渡，属**立即生效的开关**，不进草稿条（否则模型仍按旧值等你确认）。
							onClick: () => { const next = auto ? "user" : "auto"; stageNow("releaseGate", next); }
						}, auto ? "全自动" : "需审核"),
						h("button", { style: S.smallBtn, onClick: onClose }, "×"))),
				error !== "" ? h("div", { style: S.err }, error) : null,
				// ── 顶部悬浮区（第 3 条：始终浮在面板内容上方，滚动也不丢）──
				// 冻结条（⑥）与应用条（⑤）同层级：冻结=模型在等你答复；应用=你有未落盘改动。
				freezeOn ? h("div", { style: { ...S.draftBar, borderColor: "#f59e0b", background: "#fffbeb" } },
					h("span", { style: S.frozenTag }, "⏸ 提问冻结中"),
					h("span", { style: { ...S.qHint, margin: 0, flex: "1 1 auto", minWidth: 0 } }, "模型提出了待你答复的问题——答复前它不会派子代理/发卡/推进阶段。若问题已答复或不再需要冻结，点右侧解除。"),
					h("button", { style: S.cancelBtn, onClick: () => patchNow({ freezeForQuestion: "clear", note: "UI 解除提问冻结（用户已答复）" }) }, "解除冻结")) : null,
				hasDraft ? h("div", { style: S.draftBar },
					h("span", { style: { fontWeight: 700, color: "var(--dsw-alias-state-business-primary, #2563eb)" } }, `待应用 ${draftKeys.length} 项`),
					h("span", { style: { ...S.qHint, margin: 0, flex: "1 1 auto", minWidth: 0 } }, draftSummary),
					h("button", { style: S.applyBtn, disabled: applying, onClick: applyDraft }, applying ? "应用中…" : "应用"),
					h("button", { style: S.cancelBtn, disabled: applying, onClick: discardDraft }, "取消")) : null,
				// ── 任务性质（判型；全自动下由主代理判断） ──
				// 判型值行与徽标：草稿期以「待应用：<新值>」预览（与预估的「待应用试算」同范式），
				// 避免「按钮已高亮、灰字已换，而这行还写着旧值」的自相矛盾（2026-09-22 用户报灰字不同步时一并修）。
				// 徽标（✅已定稿/AI 建议待确认/⚠未判型）按已落盘状态显示——它回答的是「有没有定过稿」。
					h("div", { style: { marginBottom: "4px" } },
						h("div", { style: { ...S.sectionTitle, margin: "4px 0 4px 0", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
							h("span", null, "任务性质"),
							st.judge !== "unset" ? h("span", { style: S.okTag }, "✅ 已定稿") : proposal ? h("span", { style: S.warnTag }, "AI 建议待确认") : h("span", { style: S.warnTag }, "⚠ 未判型")),
						Object.prototype.hasOwnProperty.call(draft, "judge")
							? h("div", { style: S.bodyText }, "待应用：", h("span", { style: S.valueText }, eff("judge") === "unset" ? "取消判型（回到未判型）" : (JUDGE_FULL[eff("judge")] ?? eff("judge"))))
							: st.judge !== "unset"
								? h("div", { style: S.bodyText }, "已定稿：", h("span", { style: S.valueText }, JUDGE_FULL[st.judge] ?? st.judge))
								: proposal
									? h("div", { style: S.bodyText }, "AI 建议：", h("span", { style: S.valueText }, JUDGE_LABEL[proposal] ?? proposal), "——", h("span", { style: S.qHint }, st.judgeReason), " ", h("span", { style: S.warnTag }, auto ? "全自动：主代理将自行定稿" : "你在对话里确认后定稿"))
									: h("div", { style: { ...S.qHint, margin: "0 0 4px 0", color: "var(--dsw-alias-state-warning-primary, #b45309)" } }, "代理澄清需求后将给出判型建议与理由（也可直接手动定）"),
						h("div", { style: { ...S.segRow, margin: "0 0 4px 0" } },
							[
								{ value: "engineering", label: "工程模式", hint: "适用于目标明确的任务，一般情况下通用" },
								{ value: "exploration", label: "探索模式", hint: "更多为辅助用户探索思路，适用于目标完全不清晰的情况；要实际工作则转复合模式" },
								{ value: "compound", label: "复合模式", hint: "先探索再工程，适用边界条件繁多且极其复杂的任务" }
							].map((o) => h("button", {
								key: o.value,
								style: eff("judge") === o.value ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
								title: o.hint,
								onClick: () => stage("judge", o.value)
							}, o.label))),
						h(CollapsibleDesc, { text: JUDGE_DESC[eff("judge")] ?? JUDGE_DESC.unset, pulse: descPulse.judge })),
				h("div", { style: { marginBottom: "8px" } },
					h("div", { style: { ...S.sectionTitle, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
						h("span", null, "工作模式"),
						h("span", { style: S.estTag, title: (est.estSummary ? "结构分解：" + est.estSummary + " ｜ " : "") + (est.note ?? "") + (estDraft ? " ｜ 当前为待应用草稿的试算值（未落盘），点「应用」正式生效。" : "") }, `预估 token ×${est.tokenX}｜时间 ×${est.timeX}${estDraft ? "（待应用试算）" : ""}`)),
					h("div", { style: S.segRow },
						PRESETS.map((p) => h("button", {
							key: p.id,
							style: eff("path") === p.id ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
							title: p.desc,
							onClick: () => stagePreset(p.id)
						}, p.label)),
						eff("path") === "custom" ? h("div", { style: { ...S.segBtn, ...S.segBtnActive, flex: "0 0 auto" } }, "自定义组合") : null),
					h(CollapsibleDesc, { text: modeDesc(eff("judge"), eff("path")), pulse: descPulse.path }),
					// 用量读数（第 5 条）：去掉「实际消耗」字样、把括号里的「整棵树」提出来当标签
					usageText ? h("div", {
						style: { ...S.qHint, margin: "4px 0 0 0" },
						title: "整棵对话树（根 + 全部子代理）的真实用量；三列分开是因为未命中与缓存单价差约 10 倍，混算会误导。只统计当前已加载的会话。"
					}, h("span", { style: { fontWeight: 600 } }, "整棵树："), usageText) : null),
				// ── 流程树 ──
				h("div", { style: S.sep }),
				h(Tree, { st, liveTree, masterRunning, patch, stage, eff, awaitingUser: eff("triageAsked") !== "asked" && eff("conversationGoal") === "" }),
				// ── 任务问询 + 目标 ──
				h("div", { style: { marginBottom: "10px", ...S.sep } },
					h("div", { style: { ...S.sectionTitle, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
						h("span", null, "开局五问（第一轮只问这五个，未答不能开工；每个都先给 AI 推荐）"),
						st.triageAsked === "asked"
							? h("span", { style: S.okTag }, "✅ 可以开工")
							: h("span", { style: S.warnTag }, "→ 未完成不开工")),
					// 第 7 条：勾标前移到标题最前（统一性）；第 8 条：① ② 显示已选项
					// ①② 只读回显（2026-09-23 用户要求）：外观与可选项行一致，点击弹「仅供浏览」提示——
					// 权威控件在面板顶部「任务性质 / 工作模式」，两处都能改会造成口径分裂。
					h("div", { style: S.qHead },
						eff("judge") === "unset" ? h("span", { style: S.warnTag }, "⚠") : h("span", { style: S.okTag }, "✅"),
						"① 任务性质（判型）",
						eff("judge") === "unset" && proposal ? h("span", { style: S.tagInline }, `建议：${JUDGE_LABEL[proposal] ?? proposal}${st.judgeReason ? "——" + st.judgeReason : ""}`) : null),
					h(ReadOnlyOptRow, {
						options: [{ value: "engineering", label: "工程模式" }, { value: "exploration", label: "探索模式" }, { value: "compound", label: "复合模式" }],
						current: eff("judge"),
						hint: "任务性质"
					}),
					h("div", { style: S.qHead },
						st.modeConfirmed === "confirmed" ? h("span", { style: S.okTag }, "✅") : h("span", { style: S.warnTag }, "⚠"),
						"② 工作模式",
						st.modeConfirmed !== "confirmed" && st.modeProposal !== ""
							? h("span", { style: S.tagInline }, `AI 推荐：${PRESETS.find((p) => p.id === st.modeProposal)?.label ?? st.modeProposal}${st.modeReason ? "——" + st.modeReason : ""}`) : null,
						st.modeConfirmed !== "confirmed"
							? h("button", { style: S.confirmBtn, onClick: () => patch({ modeConfirmed: "confirmed", note: "UI 确认工作模式（用户已在对话确认）" }) }, "确认此模式")
							: null),
					h(ReadOnlyOptRow, {
						options: PRESETS.map((p) => ({ value: p.id, label: p.label })).concat(eff("path") === "custom" ? [{ value: "custom", label: "自定义组合" }] : []),
						current: eff("path"),
						hint: "工作模式"
					}),
					h("div", { style: S.qHead },
						st.askPolicy === "unset" ? h("span", { style: S.warnTag }, "⚠") : h("span", { style: S.okTag }, "✅"),
						"③ 项目相关提问授权",
						st.askPolicy === "unset" && st.askProposal !== "" ? h("span", { style: S.tagInline }, `AI 推荐：${st.askProposal === "unlimited95" ? "无限提问" : st.askProposal === "limited" ? "有限度提问" : "不开启"}${st.askReason ? "——" + st.askReason : ""}`) : null),
					h(OptRow, {
						options: [
							{ value: "unlimited95", label: "无限提问直至完全理解用户需求", hint: "内置 95% 置信度" },
							{ value: "limited", label: "只允许有限度的提问" },
							{ value: "noAsk", label: "不开启" }
						],
						current: eff("askPolicy"),
						onPick: (o) => pickOrClear("askPolicy", o, { label: "开局五问③（提问授权）" })
					}),
					h("div", { style: S.qHead },
						st.learnNeed === "unset" ? h("span", { style: S.warnTag }, "⚠") : h("span", { style: S.okTag }, "✅"),
						"④ 学习需求",
						h("span", { style: S.tagInline }, "UI 美学 / PPT / 论文去 AI 味一般需要 B")),
					h(OptRow, {
						options: [
							{ value: "A", label: "A 电脑中有" },
							{ value: "B", label: "B 无装载·补齐能力缺口" },
							{ value: "C", label: "C 不清楚" },
							{ value: "D", label: "D 用户补充" }
						],
						current: eff("learnNeed"),
						onPick: (o) => pickOrClear("learnNeed", o, { label: "开局五问④（学习需求）" })
					}),
					eff("learnNeed") === "D" ? h("div", { style: { margin: "4px 0" } },
						h("textarea", { style: S.goalEdit, rows: 2, value: (st.learnNote ?? ""), placeholder: "D 补充内容：说明已有能力/资料位置或具体要求（≤300 字）", onChange: (e) => setEdit((p) => ({ ...p, draft: e.target.value, field: "learnNote" })) }),
						h("button", { style: { ...S.smallBtn, marginLeft: 0, marginTop: "3px" }, onClick: () => patch({ learnNote: edit.draft, note: "UI 补充学习需求 D" }) }, "保存补充")) : null,
					// 第 7 条：⑤ 勾标前移；「对话目标」不再单独挂确认（确认按钮在本行，目标块只负责编辑）
					h("div", { style: S.qHead },
						st.goalConfirmed === "confirmed" ? h("span", { style: S.okTag }, "✅") : h("span", { style: S.warnTag }, "⚠"),
						"⑤ 目标确认",
						st.goalConfirmed !== "confirmed"
							? h("button", { style: S.confirmBtn, onClick: () => patch({ goalConfirm: "confirmed", note: "UI 确认目标（用户已在对话确认）" }) }, "确认目标")
							: h("span", { style: S.valueText }, "已确认")),
					h(GoalBlock, {
						label: "对话目标", value: st.conversationGoal, placeholder: "本轮对话要拿到什么（直接输入，回车或点保存）",
						onSave: (v) => patch({ conversationGoal: v, note: "UI 更新对话目标" })
					}),
					h(GoalBlock, {
						label: "项目总目标", inlineHint: "未设时默认与当前对话目标一致（两者也可以相同）",
						value: st.projectGoal, placeholder: "做成什么 + 做到什么程度（直接输入，回车或点保存）",
						onSave: (v) => patch({ projectGoal: v, note: "UI 更新项目总目标" })
					}),
					// 第 7 条：附项勾标前移；第 4 条：标题去掉「（附）」；2026-09-23：去掉尾部灰字说明（口径见 SKILL/注入块）
					h("div", { style: S.qHead },
						st.missingPolicy === "unset" ? h("span", { style: S.warnTag }, "⚠") : h("span", { style: S.okTag }, "✅"),
						"关键信息缺失"),
					h(OptRow, {
						options: [
							{ value: "A", label: "A 尝试自己寻找/推理", hint: "做不到就降级为留空（默认）" },
							{ value: "B", label: "B 留空" },
							{ value: "C", label: "C 编造", hint: "用户授权后编造补齐，风险自担" }
						],
						current: eff("missingPolicy"),
						onPick: (o) => pickOrClear("missingPolicy", o, { label: "关键信息缺失口径" })
					})),
				// ── 输出风格 ──
				// 标题行统一 flex + gap（2026-09-23 用户指出：辅助程度/卡上限标题后的灰字紧贴标题、排版不齐）
				h("div", { style: { marginBottom: "8px", ...S.sep } },
					h("div", { style: { ...S.sectionTitle, margin: "11px 0 6px 0", display: "flex", alignItems: "baseline", gap: "8px" } }, "输出风格"),
					h("div", { style: S.segRow },
						OUTPUT_STYLES.map((o) => h("button", {
							key: o.value,
							style: eff("outputStyle") === o.value ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
							title: o.desc,
							onClick: () => stage("outputStyle", o.value)
						}, o.label))),
					h(CollapsibleDesc, { text: OUTPUT_STYLES.find((o) => o.value === eff("outputStyle"))?.desc ?? "", pulse: descPulse.outputStyle })),
				// ── 辅助程度（主代理对用户主张的默认态度；默认质疑） ──
				h("div", { style: { marginBottom: "8px", ...S.sep } },
					h("div", { style: { ...S.sectionTitle, margin: "11px 0 6px 0", display: "flex", alignItems: "baseline", gap: "8px" } },
						h("span", null, "辅助程度"),
						h("span", { style: S.tagInline }, "主代理对用户主张的默认态度")),
					h("div", { style: S.segRow },
						ASSIST_LEVELS.map((o) => h("button", {
							key: o.value,
							style: eff("assistLevel") === o.value ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
							title: o.desc,
							onClick: () => stage("assistLevel", o.value)
						}, o.label))),
					h(CollapsibleDesc, { text: ASSIST_LEVELS.find((o) => o.value === eff("assistLevel"))?.desc ?? "", pulse: descPulse.assistLevel })),
				// ── 执行卡上限（抑制孙代理扇出致成本爆炸；三层/两层生效） ──
				h("div", { style: { marginBottom: "8px", ...S.sep } },
					h("div", { style: { ...S.sectionTitle, margin: "11px 0 6px 0", display: "flex", alignItems: "baseline", gap: "8px" } },
						h("span", null, "执行卡上限"),
						h("span", { style: S.tagInline }, eff("layering") === "one" ? "一层编排不派卡，不适用" : "主控可自派的孙代理卡数上限（超发需上报）")),
					h("div", { style: S.segRow },
						CARD_CAPS.map((o) => h("button", {
							key: o.value,
							style: eff("cardCap") === o.value ? { ...S.segBtn, ...S.segBtnActive } : S.segBtn,
							title: o.desc,
							disabled: eff("layering") === "one",
							onClick: () => stage("cardCap", o.value)
						}, o.label))),
					h(CollapsibleDesc, { text: eff("layering") === "one" ? "一层编排下主代理亲自执行，不派孙代理" : (CARD_CAPS.find((o) => o.value === eff("cardCap"))?.desc ?? ""), pulse: descPulse.cardCap })),
				// ── 日志（可折叠 + 未读红点；面板内改动点开即消，未点开不影响外部角标） ──
				h("div", { style: S.hint },
					h("button", { style: S.logToggle, onClick: toggleLog },
						logOpen ? "▾ 操作留痕（点击收起）" : "▸ 操作留痕（点击展开）",
						unseen > 0 ? h("span", { style: S.logDot }) : null),
					logOpen ? h("div", { style: { marginTop: "4px" } },
						stLog.slice(-8).reverse().map((entry, i) => h("div", { key: i, style: S.logRow }, `${fmtTs(entry.ts)} ${entry.source === "ui" ? "[面板]" : "[代理]"} ${entry.text}`)),
						st.logArchivePath ? h("div", { style: { ...S.logRow, marginTop: "2px" } }, `全量日志已归档（不截断）→ ${st.logArchivePath}`) : null) : null,
					h("div", { style: { marginTop: "4px" } }, "面板状态每轮注入模型上下文并强约束执行；树上调整属预先放行，停用的线不得自行恢复。")),
				);
		}

		// ── 顶栏入口芯片（门禁：仅 harness preset 会话渲染；hooks 无条件调用） ──
		function FlowChip(props) {
			const { sessionId, useSessions } = props;
			const presetValue = typeof useSessions === "function"
				? useSessions((state) => state?.byId?.[sessionId]?.projectionValues?.agentPreset)
				: undefined;
			// ⑦ 面板状态按「根会话」存：子代理会话（孙代理/主控）要读写它所属根会话的那一份，
			// 否则会在子代理界面看到一份默认空状态、并在那里误建独立配置。
			// 上溯链路：条目自述 subagent.address.parentSessionId（dsh 客户端 session 条目字段）。
			// ⑩ 时间 / token 统计：从客户端投影读整棵树（根 + 全部后代）的真实用量。
			// 口径（用户 2026-09-19 拍板，三列分开——未命中与缓存单价差 10 倍，混算会误导）：
			//   未命中 uncachedInputTokens ｜ 缓存命中 cacheReadTokens ｜ 输出 outputTokens
			const usageJson = typeof useSessions === "function"
				? useSessions((state) => {
					const byId = state?.byId ?? {};
					// 从当前会话起上溯到根，再自根向下收集全部后代
					let root = sessionId; let guard = 0;
					while (guard++ < 20) {
						const p = byId?.[root]?.subagent?.address?.parentSessionId ?? byId?.[root]?.parentSessionId;
						if (typeof p !== "string" || p === "" || p === root) break;
						root = p;
					}
					const all = Object.keys(byId);
					const kidsOf = (id) => all.filter((k) => {
						const p = byId?.[k]?.subagent?.address?.parentSessionId ?? byId?.[k]?.parentSessionId;
						return p === id;
					});
					// 广度遍历整棵树
					const tree = [root]; const seen = new Set([root]);
					for (let i = 0; i < tree.length && i < 200; i++) {
						for (const c of kidsOf(tree[i])) if (!seen.has(c)) { seen.add(c); tree.push(c); }
					}
				let unc = 0, cache = 0, out = 0, created = 0, updated = 0, count = 0, missing = 0;
				for (const id of tree) {
					const e = byId?.[id];
					const u = e?.projectionValues?.tokenUsage;
					if (u) { unc += u.uncachedInputTokens ?? 0; cache += u.cacheReadTokens ?? 0; out += u.outputTokens ?? 0; count++; }
					else missing++;
					// 计时口径（2026-09-23 修：原只读 createdAt，而 dsh 会话条目实测只有 updatedAt
					// → created 恒 0 → 永远显示 0m，用户报「没见计时在工作」）：
					// 起点 = 树内最小的 createdAt（若宿主提供）；无 createdAt 时回退用最小的 updatedAt 作**下界**，
					// 面板据此显示「≥Xm」而不是假装精确，避免把「最后一次消息时间」当开始时间而少算。
					const c = e?.createdAt ?? e?.projectionValues?.createdAt;
					if (typeof c === "number" && c > 0 && (created === 0 || c < created)) created = c;
					const up = e?.updatedAt ?? e?.projectionValues?.updatedAt;
					if (typeof up === "number" && up > 0 && (updated === 0 || up < updated)) updated = up;
				}
				return JSON.stringify({ root, sessions: tree.length, counted: count, missing, unc, cache, out, created, updated, exact: created > 0 });
				})
				: "{}";
			let usageTree = {};
			try { usageTree = JSON.parse(usageJson ?? "{}"); } catch {}
			// 用量读数：不带「实际消耗」字样与整串括号——数字本身是主体，口径说明挪到 title 悬停。
			// 用时（2026-09-23 修：宿主投影只给 updatedAt、无会话创建时间 → 由面板自己记「首次见到」）：
			// 首次在面板里观察到该会话树的时刻 = 计时起点，持久化 localStorage（按会话 id），刷新不丢。
			// 不拿 updatedAt 冒充起点（那是「最后一次消息时间」，会算出「≥49h」这种误导值——实测踩到）。
			const usageText = (() => {
				const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(n ?? 0);
				if (!usageTree.counted) return "";
				const startAt = firstSeenAt(usageTree.root);
				const dur = (() => {
					if (!startAt) return "—";
					const mins = Math.max(0, Math.round((Date.now() - startAt) / 60000));
					return mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m` : `${mins}m`;
				})();
				const durTip = startAt ? "" : "（本机首次打开该面板时才开始计时）";
				return `未命中 ${k(usageTree.unc)} ｜ 命中 ${k(usageTree.cache)} ｜ 输出 ${k(usageTree.out)} ｜ 用时 ${dur}${durTip} ｜ 树内 ${usageTree.counted}${usageTree.missing ? "+" + usageTree.missing + "未载" : ""} 会话`;
			})();
			const rootId = typeof useSessions === "function"
				? useSessions((state) => {
					const byId = state?.byId ?? {};
					let cur = sessionId;
					let guard = 0;
					while (guard++ < 20) {
						const addr = byId?.[cur]?.subagent?.address;
						const parent = addr?.parentSessionId;
						if (typeof parent !== "string" || parent === "" || parent === cur) break;
						cur = parent;
					}
					return cur;
				})
				: sessionId;
			const liveTreeJson = typeof useSessions === "function"
				? useSessions((s) => {
					const root = s?.byId?.[sessionId];
					const direct = Array.isArray(root?.projectionValues?.subagentCatalog) ? root.projectionValues.subagentCatalog : [];
					const rows = direct.map((e) => {
						const c = s?.byId?.[e.id];
						const gc = Array.isArray(c?.projectionValues?.subagentCatalog) ? c.projectionValues.subagentCatalog : [];
						return {
							id: e.id,
							label: e.label ?? c?.displayTitle ?? c?.title ?? e.id,
							running: c?.running === true,
							children: gc.map((g) => {
								const g2 = s?.byId?.[g.id];
								return { id: g.id, label: g.label ?? g2?.displayTitle ?? g.id, running: g2?.running === true };
							})
						};
					});
					// 主代理（根会话）自身的运行态：与子代理同字段（会话条目自述 running）。
					// 旧实现只取子代理目录，主代理只能靠「有子代理在跑」代替——亮灯与实际不符。
					return JSON.stringify({ rows, masterRunning: root?.running === true });
				})
				: "[]";
			const [open, setOpen] = react.useState(false);
			const [anchor, setAnchor] = react.useState({ top: 80, center: 640 });
			let liveTree = [];
			let masterRunning = null;
			try {
				const parsed = JSON.parse(liveTreeJson ?? "[]");
				// 兼容旧形态（纯数组）：无 masterRunning 时回退到「有子代理在跑」
				if (Array.isArray(parsed)) { liveTree = parsed; } else { liveTree = Array.isArray(parsed?.rows) ? parsed.rows : []; masterRunning = typeof parsed?.masterRunning === "boolean" ? parsed.masterRunning : null; }
			} catch {}
			const presetId = typeof presetValue === "string" ? presetValue : (presetValue?.id ?? null);
			try { (window.__harnessFlow ??= {}).preset = presetId; } catch {}
			react.useEffect(() => {
				if (!open || typeof document === "undefined") return undefined;
				const close = () => setOpen(false);
				document.addEventListener("click", close);
				return () => document.removeEventListener("click", close);
			}, [open]);
			// 外部数字角标：agent 侧未读日志数（面板内改动不计入；打开面板即清零；面板关着时轻量轮询）
			const [badgeN, setBadgeN] = react.useState(0);
			const [estX, setEstX] = react.useState(null);
			// ③ 面板复用这份状态（面板打开时 chip 轮询本就常驻，无需第二条定时器）
			const [pushState, setPushState] = react.useState(null);
			react.useEffect(() => {
				// B16（2026-09-25）：轮询按预设门禁——非 harness 会话不打 /state（否则 host 会 load 出默认状态，
				// 变量 provider 便有缓存可渲染，面板块泄入非 harness 会话；gateOk 只管渲染管不住这条链）
				if (typeof sessionId !== "string" || sessionId === "" || presetId !== "harness") return undefined;
				let stopped = false;
				const tick = async () => {
					try {
						const r = await apiGet(sessionId);
						if (stopped || !r.ok) return;
						setPushState(r.state);   // ③ 同一份结果供面板复用
						setBadgeN(Math.max(0, Number(r.state?.unseenAgent ?? 0)));
						if (r.est) {
							setEstX(r.est);
							(window.__harnessFlow ??= {}).estById = Object.assign((window.__harnessFlow.estById ?? {}), { [sessionId]: r.est });
						}
						if (open) { try { await apiPatch(sessionId, { logSeen: Date.now() }); setBadgeN(0); } catch {} }
					} catch {}
				};
				tick();
				const timer = setInterval(tick, open ? 3000 : 5000);
				return () => { stopped = true; clearInterval(timer); };
			}, [sessionId, open, presetId]);
			const gateOk = typeof sessionId === "string" && sessionId !== "" && presetId === "harness";
			// 子代理界面：沿用根会话的面板状态（⑦），并在面板内提示这是哪一层
			const isSubagentView = typeof rootId === "string" && rootId !== sessionId;
			if (!gateOk) return null;
			const toggle = (e) => {
				e.stopPropagation();
				if (!open && typeof e.currentTarget.getBoundingClientRect === "function") {
					const rect = e.currentTarget.getBoundingClientRect();
					// 按钮已置顶居中：面板按按钮中心线水平居中，宽度 500 由自身控制
					const center = Math.round(rect.left + rect.width / 2);
					setAnchor({ top: Math.round(rect.bottom + 6), center });
				}
				setOpen(!open);
			};
			// 置顶居中：fixed + 水平居中（脱离头部槽位流），面板自其底边下拉
			// 图标：MC 马鞍贴图（16×16 原版像素画，base64 内嵌——零外链零依赖）
			const saddleIcon = h("img", {
				src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQBAMAAADt3eJSAAAAHlBMVEUAAADxi1ywmYjaZix/b2OnTiFVSEN/ORlRIQw1Fwoj1JBHAAAAAXRSTlMAQObYZgAAAE9JREFUeNpjIBZwlBdAGO2C5mC6o9hUFCjEXh5sbBwMZBQKlxobl04ASgRaBJtWABntraatoZ0MQDUV4a2VDRDdlRMgjJkTGFpgZqshrAEATKgTThuNjaAAAAAASUVORK5CYII=",
				width: 16, height: 16, alt: "", draggable: false,
				style: { flex: "none", display: "block", imageRendering: "pixelated", width: "16px", height: "16px" }
			});
			// 垂直对齐：头部槽位里放 0 宽占位测量中线 → 胶囊 fixed 居中、纵向与同行文字齐平
			const slotRef = react.useRef(null);
			const pillBtnRef = react.useRef(null);
			const [pillPos, setPillPos] = react.useState({ top: 12, left: 570 });
			react.useEffect(() => {
				const measure = () => {
					const el = slotRef.current;
					const btnEl = pillBtnRef.current;
					if (!el || !btnEl) return;
					const r = el.getBoundingClientRect();
					// 只量按钮本身：外壳在面板展开时高度=面板高，会把定位算飞
					const br = btnEl.getBoundingClientRect();
					if (r.height > 0 || r.top > 0) {
						// 纵横都取整：像素画贴图落在整数像素上才不丢边（亚像素会重采样）
						const nextTop = Math.max(2, Math.round(r.top + r.height / 2 - br.height / 2));
						// 窗口居中是网页端的定版位置；桌面端头部把标题/内置芯片簇排在窗口中央，
						// 居中会压住它们（真机实测：智能体团队芯片被盖）。
						// 碰撞检测：向居中位的胶囊横带采样，探测点上有**非本胶囊**的元素即判占用，
						// 占用时改为锚定槽位左侧收尾（槽位锚点 = 工具槽流内的真实位置）。
						const centerLeft = Math.round((window.innerWidth - br.width) / 2);
						let nextLeft = centerLeft;
						try {
							const wrap = btnEl.parentElement;
							const y = Math.max(1, Math.round(r.top + r.height / 2));
							let occupied = false;
							for (let x = centerLeft + 6; x <= centerLeft + br.width - 6; x += 10) {
								const stack = document.elementsFromPoint(x, y);
								if (stack.some((el) => el !== btnEl && !(wrap && wrap.contains(el)) && !(el.getAttribute && el.getAttribute("aria-hidden") === "true"))) { occupied = true; break; }
							}
							if (occupied) nextLeft = Math.max(2, Math.round(r.left - br.width - 8));
						} catch {}
						setPillPos((prev) => (prev.top === nextTop && prev.left === nextLeft ? prev : { top: nextTop, left: nextLeft }));
					}
				};
				measure();
				const timer = setInterval(measure, 2000);
				window.addEventListener("resize", measure);
				return () => { clearInterval(timer); window.removeEventListener("resize", measure); };
			}, []);
			return h(react.Fragment, null,
				h("span", { ref: slotRef, "aria-hidden": "true", style: { display: "inline-block", width: 0, height: "1em", verticalAlign: "baseline" } }),
				h("div", { style: { position: "fixed", top: pillPos.top, left: pillPos.left, zIndex: 75 } },
				h("button", {
					ref: pillBtnRef,
					style: { ...S.chipPill, ...(open ? S.chipPillOn : {}) },
					onClick: toggle,
					title: "驾驭工程面板：判型（工程·探索·复合）/ 工作模式三档（含预估倍率）/ 全自动开关 / 开局五问与目标 / 流程树 / 输出风格"
				},
					h("span", { style: S.chipSeg }, saddleIcon, h("span", null, "驾驭工程")),
					h("span", { style: S.chipArrow }, h("svg", { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none" },
						h("path", { d: open ? "M2.5 7.5 L6 4 L9.5 7.5" : "M2.5 4.5 L6 8 L9.5 4.5", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" })))),
				badgeN > 0 ? h("span", { style: S.badge }, badgeN > 99 ? "99+" : String(badgeN)) : null,
				open ? h(FlowPanel, { sessionId: rootId, anchor, liveTree, masterRunning, usageText, pushState, onClose: () => setOpen(false), isSubagentView }) : null));
		}

		// ── 插件装配 ───────────────────────────────────────────────────────────
		const inject = ["sessions", "slots"];
		function apply(ctx) {
			try {
				(window.__harnessFlow ??= {}).applied = true;
				const slots = ctx.slots ?? (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
				if (slots === undefined) { window.__harnessFlow.noSlots = true; return; }
				slots.inject("conversation.session.header.utilities", () => {
					(window.__harnessFlow ??= {}).slotInjectFired = true;
					slots.register({
						name: "conversation.session.header.utilities",
						id: "harness-flow-chip",
						order: -20
					}, FlowChip);
				});
				window.__harnessFlow.registered = true;
			} catch (error) {
				try { (window.__harnessFlow ??= {}).applyError = String((error && error.stack) || error); } catch {}
			}
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
