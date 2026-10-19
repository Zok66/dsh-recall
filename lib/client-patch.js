// client-patch.js — 给 dsh 聊天前端注入「撤回」按钮（幂等）。
//
// 为什么需要补丁而不是直接改代码：
//   dsh 的「环境安装与修复」会重新解包 /usr/local/lib/node_modules，
//   把手写改动全部覆盖。所以补丁必须在启动时重新打，才能持久。
//
// 补丁内容（v9）：
//   ① MessageIconActions 支持 onRecall/seq，渲染回旋箭头按钮
//   ② 按钮只挂在「最后一条用户消息」上（撤回后自动上移）
//   ③ UserMessageNodeView 把消息 seq 传给按钮
//   ④ 会话视图里实现 recallAt：fork 出干净新会话（文件还原由同插件负责）
//   ⑦⑧（v9 新增）useSyncExternalStore 全局订阅：最后一条用户消息变化时，
//      所有用户气泡即时重渲染，撤回按钮自动移挂到新消息上，无需重进会话。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// 自动定位 chat 前端包（避免写死绝对路径导致换机器要改代码）。
// 解析顺序：① 从本插件上下文解析 @deepseek-ai/dsh-client-ui-chat 包根 → 拼 lib/client.js；
//          ② 兜底写死当前 DSH 默认安装根（与 ① 同形）。
// 只要 chat 包在 node_modules 解析路径内（DSH 标准布局即满足），就能命中，无需改路径。
function resolveTarget() {
  const selfReq = createRequire(path.join(process.cwd(), 'package.json'))
  const seen = new Set()
  for (const tryReq of [selfReq]) {
    try {
      const chatRoot = tryReq.resolve('@deepseek-ai/dsh-client-ui-chat')
      const chat = chatRoot.replace(/lib[\\/]index\.js$/, 'lib/client.js')
      if (fs.existsSync(chat) && !seen.has(chat)) {
        seen.add(chat)
        return chat
      }
    } catch {
      /* 继续兜底 */
    }
  }
  const hard =
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
  return hard
}

export const TARGET = resolveTarget()
export const MARK = '@@DSH_RECALL_PATCH_v9@@'
// 任何历史版本的 recall 补丁标记前缀（升级时识别并清理旧补丁）
export const MARK_PREFIX = '@@DSH_RECALL_PATCH'

const recallImpl = `
// ${MARK} 撤回实现（v9）：只允许撤最后一条用户消息，文字与附件一起回填
															const recallAtImpl = (seq) => {
																if (!(typeof seq === "number" && seq > 0)) return;
																const snap = chat.getSnapshot();
																const computeBoundary = () => {
																	// 撤回语义：切面必须落在「被撤消息所在轮之前、最近一个已闭合 turn」上，
																	// 让新会话日志天然闭合，避免 fork 把上一轮 turn/start/step/start 也带进来，
																	// 生成一个开了没关的孤儿轮（前端渲染成空折叠壳「已完成，用时 X」）。
																	const turns = [...snap.timeline.turns.values()];
																	const target = turns.find((t) => {
																		const tail = t.data.get("turn-tail");
																		return tail !== void 0 && tail.closing !== null && tail.closing.finalNode.seq === seq;
																	});
																	if (target !== void 0) {
																		const cut = target.data.get("turn-tail").closing.finalNode.seq;
																		return cut > 0 ? cut : 0;
																	}
																	// 兜底：被撤的不是某轮结尾的用户消息（如未完成轮里的当前输入），
																	// 回退到「所有 turn-end 中小于 seq 的最大者」，仍保证日志闭合。
																	let best = -1;
																	for (const t of turns) {
																		const tail = t.data.get("turn-tail");
																		if (tail !== void 0 && tail.closing !== null) {
																			const c = tail.closing.finalNode.seq;
																			if (c < seq && c > best) best = c;
																		}
																	}
																	return best >= 0 ? best : 0;
																};
																const userNodes = [...snap.nodes.values()].filter((n) => n.kind === "user");
																const lastUser = userNodes.at(-1);
																if (lastUser === void 0) return;
																const lastSeq = lastUser.anchorSeq ?? lastUser.data?.seq;
																if (lastSeq !== seq && lastUser.data?.seq !== seq) {
																	if (typeof window !== "undefined") window.alert("只能撤回最后一条用户消息。更早的消息可用「分支」另开新会话。");
																	return;
																}
																const confirmed = typeof window !== "undefined" && typeof window.confirm === "function"
																	? window.confirm("撤回将生成一个不含这条消息及其之后内容的新分支会话，消息原文与附件会回到输入框供你改动重发；工作区文件也会还原到这一轮开始前。原会话保留在列表中可回看。是否继续？")
																	: true;
																if (!confirmed) return;
																const recalledText = lastUser && Array.isArray(lastUser.data?.content)
																	? lastUser.data.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\\n")
																	: (typeof lastUser?.data?.text === "string" ? lastUser.data.text : "");
																// 被撤消息里的附件块（图片 / 普通文件），用于撤回后重新放回输入框。
																const recalledAttachments = lastUser && Array.isArray(lastUser.data?.content)
																	? lastUser.data.content.filter((b) => b && (b.type === "image" || b.type === "file") && b.attachment !== void 0 && b.attachment !== null).map((b) => ({ kind: b.type, ref: b.attachment }))
																	: [];
																// 草稿附件归属 conversation 服务（createDrafts / releaseDraftAttachments）；
																// 注意本作用域里的 conversation 是聊天绑定对象，不是服务，别混用。
																const conversationService = () => (typeof ctx.get === "function" ? ctx.get("conversation") : void 0);
																const fillDraft = (sid) => {
																	if (!recalledText) return;
																	// 持久层照旧：新 fork 出的子会话 store 尚未建立，建立时会从 localStorage 水合。
																	if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
																		try {
																			const key = "dsh.conversation." + sid;
																			const raw = localStorage.getItem(key);
																			if (raw !== null) {
																				try {
																					const prev = JSON.parse(raw);
																					if (prev !== null && typeof prev === "object") {
																						prev.draft = recalledText;
																						localStorage.setItem(key, JSON.stringify(prev));
																					}
																				} catch (_) {}
																			} else {
																				localStorage.setItem(key, JSON.stringify({ draft: recalledText, view: null, viewRequest: null }));
																			}
																		} catch (_) {}
																	}
																	// v2.3.1 修复：撤回会话第一条用户消息时（fork 失败兜底同理），目标会话是
																	// 运行中的会话，草稿 store 早已物化、不会再回头看 localStorage——只写
																	// localStorage 等于没人读，输入框纹丝不动（实测复现）。这里补上输入壳
																	// setDraft（应用切换工作区迁移草稿用的正规通道）：壳已在运行则即时生效，
																	// 还没物化则由 waitShell 轮询等就绪。仅当前草稿为空时回填，不覆盖已输入内容。
																	waitShell(sid).then((shell) => {
																		if (shell === void 0) return;
																		try {
																			const snap = shell.snapshot;
																			if (snap === void 0 || snap.phase === "adjudicating" || snap.phase === "submitting") return;
																			if (typeof shell.setDraft === "function" && snap.draft === "") shell.setDraft(recalledText);
																		} catch (_) {}
																	}).catch(() => {});
																};
																// 把从主机侧取回的附件字节包装成浏览器 File，再走输入框自己的 addFiles 通道，
																// 这样附件会像手动拖拽/选择一样进入草稿（图片有预览、普通文件走上传）。
																const shellOf = (sid) => {
																	try {
																		const service = conversationService();
																		// input.shell(id) 直接按会话 id 取输入壳，不依赖 scope 已物化（新分支刚建时更可靠）。
																		const byId = service?.input?.shell?.(sid);
																		if (byId !== void 0) return byId;
																	} catch (_) {}
																	try {
																		const actx = ctx.sessions.scope(sid);
																		if (actx === void 0) return void 0;
																		return actx.get("conversation")?.input?.for?.(actx);
																	} catch (_) {
																		return void 0;
																	}
																};
																// 新分支会话的 scope 是异步物化的：短暂轮询等它就绪再回填，避免 addFiles 丢在空气里。
																const waitShell = (sid) => new Promise((resolve) => {
																	let tries = 0;
																	const tick = () => {
																		const shell = shellOf(sid);
																		if (shell !== void 0) return resolve(shell);
																		tries += 1;
																		if (tries > 50) return resolve(void 0);
																		setTimeout(tick, 100);
																	};
																	tick();
																});
																const refillAttachments = (sid) => {
																	if (recalledAttachments.length === 0) return Promise.resolve(0);
																	return (async () => {
																		const files = [];
																		// 统计「拿不回字节」的附件数，回填后如实告知，避免静默丢附件。
																		let lostCount = 0;
																		for (const item of recalledAttachments) {
																			const ref = item.ref;
																			if (ref === void 0 || typeof ref !== "object") continue;
																			const fallbackExt = item.kind === "image" ? String(ref.mediaType ?? "image/png").replace(/^image\\//, "") : "bin";
																			const name = typeof ref.name === "string" && ref.name !== "" ? ref.name : "recalled." + fallbackExt;
																			try {
																				let blob = null;
																				// 图片走会话自带的附件读取（带引用校验，快）；普通文件只能走主机侧路由。
																				if (item.kind === "image" && typeof ref.attachmentId === "string" && typeof session?.readAttachment === "function") {
																					const res = await session.readAttachment(ref.attachmentId);
																					if (res !== void 0 && res.ok === true) {
																						const bytes = res.value?.data;
																						const mediaType = res.value?.attachment?.mediaType ?? ref.mediaType ?? "image/png";
																						if (bytes !== void 0) blob = new Blob([bytes], { type: mediaType });
																					}
																				}
																				if (blob === null && typeof ref.attachmentId === "string") {
																					const query = "sessionId=" + encodeURIComponent(sessionId) + "&attachmentId=" + encodeURIComponent(ref.attachmentId);
																					// 相对路径跟随平台约定（支持子路径部署）；万一不在根路径，再退回同源绝对路径。
																					for (const url of ["api/recall.attachment?" + query, "/api/recall.attachment?" + query]) {
																						try {
																							const response = await fetch(url);
																							if (response.ok) {
																								blob = await response.blob();
																								break;
																							}
																						} catch (_) {}
																					}
																				}
																				if (blob === null) {
																					lostCount += 1;
																					continue;
																				}
																				const type = blob.type !== "" ? blob.type
																					: (item.kind === "image" ? (ref.mediaType ?? "image/png") : "application/octet-stream");
																				files.push(new File([blob], name, { type }));
																			} catch (_) {}
																		}
																		const warnLost = () => {
																			if (lostCount > 0 && typeof window !== "undefined") window.alert("撤回时 " + lostCount + " 个附件未能取回（附件可能已过期或被清理），文字已照常放回输入框。");
																		};
																		if (files.length === 0) {
																			warnLost();
																			return 0;
																		}
																		const shell = await waitShell(sid);
																		if (shell === void 0) {
																			warnLost();
																			return 0;
																		}
																		const draft = shell.snapshot;
																		if (draft === void 0 || draft.phase === "adjudicating" || draft.phase === "submitting") return 0;
																		const service = conversationService();
																		if (service === void 0) return 0;
																		let drafts;
																		try {
																			drafts = service.createDrafts(sid, files);
																			if (shell.addFiles([], drafts.map((d) => d.id)) !== true) {
																				service.releaseDraftAttachments(drafts);
																				return 0;
																			}
																		} catch (_) {
																			if (drafts !== void 0) service.releaseDraftAttachments(drafts);
																			return 0;
																		}
																		warnLost();
																		return drafts.length;
																	})();
																};
																if (userNodes.length <= 1) {
																	// v5：撤回会话里唯一一条用户消息时，新分支必然是空白会话（界面会崩），
																	// 不 fork，直接把原文与附件放回当前会话输入框。
																	fillDraft(sessionId);
																	refillAttachments(sessionId);
																	if (typeof window !== "undefined") window.alert("已把这条消息放回输入框。它是当前会话的第一条用户消息，无法在保留会话内容的同时把它从会话里移除；如需完全重来，请新建会话。");
																	return;
																}
																// v8：撤回必须显式请求主机还原文件。
																// 只靠子会话 header.parentSession 无法区分「撤回」和框架自带「分支」
																// （两者都走 sessions.fork），会导致用户点普通分支时文件被意外回退。
																// 做法：fork 成功后显式 POST /api/recall.restore，主机只处理端点请求。
																const requestRestore = (parentSessionId, snapshotSeq) => {
																	const query = "sessionId=" + encodeURIComponent(parentSessionId) + "&turnSeq=" + encodeURIComponent(String(snapshotSeq));
																	const urls = ["api/recall.restore?" + query, "/api/recall.restore?" + query];
																	const attempt = (idx) => {
																		if (idx >= urls.length) return;
																		try {
																			fetch(urls[idx], { method: "POST" }).catch(() => attempt(idx + 1));
																		} catch (_) {
																			attempt(idx + 1);
																		}
																	};
																	attempt(0);
																};
																// 撤回边界（事件 seq）同时就是本轮快照 key，传给主机侧做精确还原。
																const boundary = computeBoundary();
																// v9.1 修复：撤回前先停止父会话的活跃 turn，否则「消息撤了、AI 还在继续执行这条消息」。
																try {
																	if (session?.getSnapshot?.()?.running === true && typeof session?.cancel === "function") {
																		session.cancel().catch(() => {});
																	}
																} catch (_) {}

																// v5 边界：atSeq = 被撤消息前一个事件（事件日志从 0 连续，fork 校验要求边界真实存在）。
																// 新分支保留之前全部对话、不含被撤消息，且必含更早的用户消息，永不空白。
																try {
																	ctx.sessions.fork({
																		sessionId,
																		atSeq: boundary,
																		increaseTitle: true,
																	}).then((childId) => {
																		// 只有撤回这一条路径会请求文件还原；普通「分支」不会。
																		requestRestore(sessionId, boundary);
																		if (typeof childId === "string" && childId.length > 0) {
																			fillDraft(childId);
																			ctx.uiWorkspace.openSession(childId);
																			refillAttachments(childId);
																		}
																	}).catch((err) => {
																		fillDraft(sessionId);
																		refillAttachments(sessionId);
																		if (typeof window !== "undefined") window.alert("已把这条消息放回输入框（未能新建分支会话" + (err && err.message ? "：" + err.message : "") + "）。");
																	});
																} catch (e) {
																	fillDraft(sessionId);
																	refillAttachments(sessionId);
																	if (typeof window !== "undefined") window.alert("已把这条消息放回输入框（未能新建分支会话" + (e && e.message ? "：" + e.message : "") + "）。");
																}
															};
															if (typeof window !== "undefined") window.__dshRecall = recallAtImpl;
`.replace(/\n/g, '\n\t\t\t\t\t\t\t')

const recallButton = `
					onRecall !== void 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: "撤回",
						side: "bottom",
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageIconActions_module_css_default.action,
							"aria-label": "撤回",
							onClick: () => onRecall(seq),
							children: (0, react_jsx_runtime.jsx)("svg", {
								width: "1em",
								height: "1em",
								viewBox: "0 0 24 24",
								fill: "none",
								stroke: "currentColor",
								strokeWidth: "2",
								strokeLinecap: "round",
								strokeLinejoin: "round",
								"aria-hidden": "true",
								children: [
									(0, react_jsx_runtime.jsx)("path", { d: "M9 14L4 9l5-5" }),
									(0, react_jsx_runtime.jsx)("path", { d: "M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9" })
								]
							})
						})
					}),
`.replace(/\n/g, '\n\t\t\t\t\t')

/** 在内存里对一段源码打补丁（不写盘）。导出供 uninstall 校验基线使用。 */
export function applyPatch(src) {
  if (src.includes(MARK)) return { changed: false, src }

  let out = src

  // ① 签名
  const sigOld =
    'function MessageIconActions({ text, time, clock, onBranch, branchUnavailable = false, className, extraActions, usageAction, t }) {'
  const sigNew =
    'function MessageIconActions({ text, time, clock, onBranch, branchUnavailable = false, className, extraActions, usageAction, onRecall, seq, t }) {'
  if (!out.includes(sigOld)) throw new Error('补丁①失败：MessageIconActions 签名未找到')
  out = out.replace(sigOld, sigNew)

  // ② 按钮
  const anchor = 'children: [\n\t\t\t\t\tclock === "start" ? clockEl : null,'
  if (!out.includes(anchor)) throw new Error('补丁②失败：按钮组锚点未找到')
  out = out.replace(anchor, anchor + '\n' + recallButton.replace(/^\n+/, ''))

  // ③ 只最后一条显示 + 传 seq（按钮随 __dshLastUserSeq 变化即时显隐/移挂）
  const actOld = `actions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text,
					time: data.time,
					clock: "start",
					className: MessageItem_module_css_default.actions,
					t
				})`
  const actNew = `actions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
					text,
					time: data.time,
					clock: "start",
					className: MessageItem_module_css_default.actions,
					onRecall: __dshRecallFor(node, data),
					seq: data.seq,
					t
				})`
  if (!out.includes(actOld)) throw new Error('补丁③失败：UserMessageNodeView actions 未找到')
  out = out.replace(actOld, actNew)

  // ④ inject 里注入 recallAtImpl
  const injOld = `const conversation = ctx.uiConversation.binding(binding);
						return {`
  if (!out.includes(injOld)) throw new Error('补丁④失败：inject 锚点未找到')
  out = out.replace(
    injOld,
    `const conversation = ctx.uiConversation.binding(binding);` + recallImpl + `\n						return {`,
  )

  // ⑤ ChatView 里实时计算「最后一条用户消息」并放进全局订阅 store：
  //    v8 的缺陷是挂在 window 上的普通变量，UserMessageNodeView 又是 memo 组件，
  //    新消息到达时旧气泡不会重渲染，撤回按钮残留。v9 把 seq 存进 useSyncExternalStore
  //    store，组件真正订阅它，seq 一变所有用户气泡立即重算显隐。
  const chatViewAnchor = `			const order = useChat((s) => s.order);`
  const chatViewPatch = `			const order = useChat((s) => s.order);
			// ${MARK} 最后一条用户消息的 seq（撤回按钮只挂在它上面，经 store 订阅分发）
			const __dshLastUserSeq = useChat((s) => {
				const ns = [...s.nodes.values()];
				for (let i = ns.length - 1; i >= 0; i--) {
					const n = ns[i];
					if (n.kind === "user") return n.anchorSeq ?? n.data?.seq ?? -1;
				}
				return -1;
			});
			{
				const __store = __dshRecallSeqStore();
				(0, react.useEffect)(() => {
					if (__store.lastSeq !== __dshLastUserSeq) {
						__store.lastSeq = __dshLastUserSeq;
						for (const fn of __store.listeners) fn();
					}
				});
			}`
  if (!out.includes(chatViewAnchor)) throw new Error('补丁⑤失败：ChatView order 锚点未找到')
  out = out.replace(chatViewAnchor, chatViewPatch)

  // ⑥ 把 recallAt 挂到 inject 返回值
  const forkEnd = `								}).then((childId) => {
									ctx.uiWorkspace.openSession(childId);
								}).catch(() => {});
							}`
  if (!out.includes(forkEnd)) throw new Error('补丁⑥失败：forkAt 尾部未找到')
  out = out.replace(forkEnd, forkEnd + `,\n							recallAt: recallAtImpl`)

  // ⑦（v9 新增）全局单例 store + 订阅式取按钮回调：
  //    __dshRecallSeqStore() 惰性建一个 { lastSeq, listeners } 单例；
  //    __dshRecallFor(node, data) 供每个用户气泡组件调用：先用
  //    useSyncExternalStore 订阅 lastSeq，再判断本条消息是否是最后一条，
  //    是则返回 window.__dshRecall，否则返回 undefined。lastSeq 一变，
  //    所有订阅组件同步重渲染，按钮即挂即撤，无需重进会话。
  const recallHelpers = `
// ${MARK} 撤回按钮响应式分发：全局 seq store + useSyncExternalStore 订阅
function __dshRecallSeqStore() {
	const g = typeof window !== "undefined" ? window : globalThis;
	if (!g.__dshRecallSeqStoreInstance) {
		g.__dshRecallSeqStoreInstance = { lastSeq: -1, listeners: new Set() };
	}
	return g.__dshRecallSeqStoreInstance;
}
function __dshRecallLastSeqSubscribe(fn) {
	const store = __dshRecallSeqStore();
	store.listeners.add(fn);
	return () => store.listeners.delete(fn);
}
function __dshRecallLastSeqRead() {
	return __dshRecallSeqStore().lastSeq;
}
function __dshRecallFor(node, data) {
	const last = (0, react.useSyncExternalStore)(__dshRecallLastSeqSubscribe, __dshRecallLastSeqRead);
	if (typeof window === "undefined" || typeof window.__dshRecall !== "function") return void 0;
	if (typeof last !== "number" || last < 0) return void 0;
	return (data.seq === last || node.anchorSeq === last) ? window.__dshRecall : void 0;
}
`

  // ⑧ 在 UserMessageNodeView 定义前注入 helpers（它调用 __dshRecallFor）
  const umvAnchor = `		/** User and admitted-steering keyed Chat renderer. */
		const UserMessageNodeView = `
  if (!out.includes(umvAnchor)) throw new Error('补丁⑧失败：UserMessageNodeView 前锚点未找到')
  out = out.replace(umvAnchor, recallHelpers.replace(/^\n+/, '').replace(/\n$/, '') + '\n' + umvAnchor)

  return { changed: true, src: out }
}

/** 检查是否已打补丁。 */
export function hasPatch() {
  try {
    return fs.readFileSync(TARGET, 'utf8').includes(MARK)
  } catch {
    return false
  }
}

/** 是否打了任意版本的 recall 补丁（含历史版本，用于升级判断）。 */
export function hasAnyRecallPatch() {
  try {
    return fs.readFileSync(TARGET, 'utf8').includes(MARK_PREFIX)
  } catch {
    return false
  }
}

/** 还原为未打补丁的干净 client（优先用首打时的 .orig-recall 备份）。返回是否还原成功。 */
export function restoreCleanTarget() {
  const bak = TARGET + '.orig-recall'
  try {
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, TARGET)
      return true
    }
    return false
  } catch {
    return false
  }
}

/** 打补丁（幂等）。返回是否真的改动了文件。 */
export function applyClientPatch() {
  if (!fs.existsSync(TARGET)) {
    console.warn('[recall] 前端文件不存在，跳过补丁:', TARGET)
    return false
  }
  // 升级路径：若已打过任意版本的 recall 补丁但不是当前 MARK，先还原干净副本再补，
  // 否则 applyPatch 的幂等守卫会直接跳过、旧切点残留。
  // 注意：还原用的是首打时的 .orig-recall 基线，若 DSH 升级换过前端文件且补丁缺失，
  // 基线可能与新版不符——这里再核一次锚点，applyPatch 内找不到锚点会抛错，不会写坏文件。
  if (hasAnyRecallPatch() && !fs.readFileSync(TARGET, 'utf8').includes(MARK)) {
    const ok = restoreCleanTarget()
    if (!ok) {
      console.warn('[recall] 检测到旧版补丁但无干净备份，无法安全升级，跳过。')
      return false
    }
    console.log('[recall] 已清理旧版 recall 补丁，准备应用新版本。')
  }
  const src = fs.readFileSync(TARGET, 'utf8')
  const result = applyPatch(src)
  if (!result.changed) return false
  const bak = TARGET + '.orig-recall'
  if (!fs.existsSync(bak)) fs.copyFileSync(TARGET, bak)
  fs.writeFileSync(TARGET, result.src)
  return true
}
