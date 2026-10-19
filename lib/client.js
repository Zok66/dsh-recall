window.__ModuleLoader__.load({
	id: "dsh-recall",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		// 只用平台 seed 表里的模块（PLATFORM_MODULES）：
		//   react / react/jsx-runtime 是其中两项，其余模块不可 require。
		const react = require("react")
		const jsx = require("react/jsx-runtime")

		/**
		 * dsh-recall 的浏览器半边。
		 *
		 * 与旧实现的关键区别：**不再改写 DSH 安装目录里的前端文件**。
		 * 旧版靠正则往 dsh-client-ui-chat/lib/client.js 里注字符串，
		 * 天然有「卸载后残留」的问题。现在走 DSH 官方的双面包机制
		 * （package.json 的 dsh.client + 本文件），插件被 remove 时
		 * 宿主根本不会加载本模块，按钮自然消失，无需任何清理脚本。
		 *
		 * 撤回按钮挂在 conversation.chat.assistant-actions（list 型插槽），
		 * 每个助手回复末尾的动作条上多一个回旋箭头，只对「最后一条用户消息」
		 * 所在的轮生效——语义与旧版一致：撤回去等于回到这一轮开始前。
		 */

		const MARK = "@@DSH_RECALL_CLIENT_V1@@"

		/** 主会话的撤回实现：fork 干净分支 + 回填文字附件 + 显式请求文件还原。 */
		function makeRecall(ctx, sessionId, session, chat, conversation) {
			return function recallAt(seq) {
				if (!(typeof seq === "number" && seq > 0)) return
				const snap = chat.getSnapshot()

				// 找到被撤用户节点：seq 是「这一轮末尾助手回复」的 seq，
				// 需要回退到该轮对应的那条用户消息。
				const userNodes = [...snap.nodes.values()].filter((n) => n.kind === "user")
				const lastUser = userNodes.at(-1)
				if (lastUser === undefined) return
				const lastSeq = lastUser.anchorSeq ?? lastUser.data?.seq
				if (userNodes.length <= 1) {
					// 会话里只有一条用户消息：新分支必然空白，界面会错乱。
					// 不 fork，只把内容放回当前输入框。
					const text = textOf(lastUser)
					fillDraft(sessionId, text)
					refillAttachments(ctx, sessionId, session, conversation, lastUser)
					if (typeof window !== "undefined") {
						window.alert(
							"已把这条消息放回输入框。它是当前会话的第一条用户消息，无法在保留会话内容的同时把它从会话里移除；如需完全重来，请新建会话。",
						)
					}
					return
				}

				const confirmed =
					typeof window !== "undefined" && typeof window.confirm === "function"
						? window.confirm(
								"撤回将生成一个不含这条消息及其之后内容的新分支会话，消息原文与附件会回到输入框供你改动重发；工作区文件也会还原到这一轮开始前。原会话保留在列表中可回看。是否继续？",
							)
						: true
				if (!confirmed) return

				// 撤回切面：被撤消息所在轮「之前」最近一个已闭合 turn 的末尾事件。
				// 让新会话日志天然闭合，避免把上一轮的 turn/start 也带进来。
				const boundary = computeBoundary(snap, lastSeq)

				ctx.sessions
					.fork({ sessionId, atSeq: boundary, increaseTitle: true })
					.then((childId) => {
						if (typeof childId !== "string" || childId.length === 0) return
						// 只有撤回这条路径会请求文件还原；框架自带「分支」不经过这里。
						requestRestore(sessionId, boundary)
						fillDraft(childId, textOf(lastUser))
						ctx.uiWorkspace.openSession(childId)
						refillAttachments(ctx, childId, session, conversation, lastUser)
					})
					.catch((err) => {
						// fork 失败：退化为「只回填到当前会话」，别让内容丢掉。
						fillDraft(sessionId, textOf(lastUser))
						refillAttachments(ctx, sessionId, session, conversation, lastUser)
						if (typeof window !== "undefined") {
							window.alert(
								"已把这条消息放回输入框（未能新建分支会话" +
									(err && err.message ? "：" + err.message : "") +
									"）。",
							)
						}
					})
			}
		}

		/** 取一条用户消息里的纯文本。 */
		function textOf(node) {
			if (node !== undefined && Array.isArray(node.data?.content)) {
				return node.data.content
					.filter((b) => b && b.type === "text" && typeof b.text === "string")
					.map((b) => b.text)
					.join("\n")
			}
			return typeof node?.data?.text === "string" ? node.data.text : ""
		}

		/**
		 * 撤回切面：落在此轮之前最近一个已闭合 turn 的末尾事件上。
		 * @param {any} snap - 聊天快照。
		 * @param {number} seq - 被撤用户消息的 seq。
		 * @returns {number} 事件 seq（fork 的 atSeq）。
		 */
		function computeBoundary(snap, seq) {
			const turns = [...snap.timeline.turns.values()]
			const target = turns.find((t) => {
				const tail = t.data.get("turn-tail")
				return tail !== undefined && tail.closing !== null && tail.closing.finalNode.seq === seq
			})
			if (target !== undefined) {
				const cut = target.data.get("turn-tail").closing.finalNode.seq
				return cut > 0 ? cut : 0
			}
			// 兜底：被撤的不是某轮结尾的消息时，回退到「所有 turn-end 中小于 seq 的最大者」。
			let best = -1
			for (const t of turns) {
				const tail = t.data.get("turn-tail")
				if (tail !== undefined && tail.closing !== null) {
					const c = tail.closing.finalNode.seq
					if (c < seq && c > best) best = c
				}
			}
			return best >= 0 ? best : 0
		}

		/** 把文字写回目标会话的持久化草稿（刷新后仍在）。 */
		function fillDraft(sessionId, text) {
			if (!text || typeof window === "undefined" || typeof localStorage === "undefined") return
			try {
				const key = "dsh.conversation." + sessionId
				const raw = localStorage.getItem(key)
				if (raw !== null) {
					const prev = JSON.parse(raw)
					if (prev !== null && typeof prev === "object") {
						prev.draft = text
						localStorage.setItem(key, JSON.stringify(prev))
					}
				} else {
					localStorage.setItem(key, JSON.stringify({ draft: text, view: null, viewRequest: null }))
				}
			} catch (_) {
				/* 忽略存储异常 */
			}
		}

		/** 显式请求主机侧还原这一轮的工作区文件（普通「分支」不会调它）。 */
		function requestRestore(parentSessionId, turnSeq) {
			const query =
				"sessionId=" + encodeURIComponent(parentSessionId) + "&turnSeq=" + encodeURIComponent(String(turnSeq))
			for (const url of ["api/recall.restore?" + query, "/api/recall.restore?" + query]) {
				try {
					const p = fetch(url, { method: "POST" })
					if (p !== undefined && typeof p.catch === "function") p.catch(() => {})
					return
				} catch (_) {
					/* 试下一个地址 */
				}
			}
		}

		/** 输入壳：优先按 id 取，退回操作会话 scope。 */
		function shellOf(ctx, sessionId) {
			try {
				const service = ctx.get("conversation")
				const byId = service?.input?.shell?.(sessionId)
				if (byId !== undefined) return byId
			} catch (_) {
				/* 继续尝试 scope */
			}
			try {
				const actx = ctx.sessions.scope(sessionId)
				if (actx === undefined) return undefined
				return actx.get("conversation")?.input?.for?.(actx)
			} catch (_) {
				return undefined
			}
		}

		/** 新分支的 scope 是异步物化的：短轮询等输入壳就绪。 */
		function waitShell(ctx, sessionId) {
			return new Promise((resolve) => {
				let tries = 0
				const tick = () => {
					const shell = shellOf(ctx, sessionId)
					if (shell !== undefined) return resolve(shell)
					tries += 1
					if (tries > 50) return resolve(undefined)
					setTimeout(tick, 100)
				}
				tick()
			})
		}

		/**
		 * 把被撤消息里的附件重新放回输入框。
		 *
		 * 图片走会话自带的附件读取（带引用校验）；普通文件走主机侧只读路由。
		 * 拿回字节后包装成 File，经 createDrafts + addFiles 进入草稿栏——
		 * 和用户手动拖拽/选择文件完全同一条通道。
		 */
		async function refillAttachments(ctx, sessionId, session, conversation, userNode) {
			const items =
				userNode !== undefined && Array.isArray(userNode.data?.content)
					? userNode.data.content
							.filter((b) => b && (b.type === "image" || b.type === "file") && b.attachment != null)
							.map((b) => ({ kind: b.type, ref: b.attachment }))
					: []
			if (items.length === 0) return

			const files = []
			let lost = 0
			for (const item of items) {
				const ref = item.ref
				if (ref === undefined || typeof ref !== "object") continue
				const ext =
					item.kind === "image" ? String(ref.mediaType ?? "image/png").replace(/^image\//, "") : "bin"
				const name = typeof ref.name === "string" && ref.name !== "" ? ref.name : "recalled." + ext
				try {
					let blob = null
					if (
						item.kind === "image" &&
						typeof ref.attachmentId === "string" &&
						typeof session?.readAttachment === "function"
					) {
						const res = await session.readAttachment(ref.attachmentId)
						if (res !== undefined && res.ok === true && res.value?.data !== undefined) {
							const mediaType = res.value.attachment?.mediaType ?? ref.mediaType ?? "image/png"
							blob = new Blob([res.value.data], { type: mediaType })
						}
					}
					if (blob === null && typeof ref.attachmentId === "string") {
						const query =
							"sessionId=" +
							encodeURIComponent(sessionId) +
							"&attachmentId=" +
							encodeURIComponent(ref.attachmentId)
						for (const url of ["api/recall.attachment?" + query, "/api/recall.attachment?" + query]) {
							try {
								const response = await fetch(url)
								if (response.ok) {
									blob = await response.blob()
									break
								}
							} catch (_) {
								/* 试下一个地址 */
							}
						}
					}
					if (blob === null) {
						lost += 1
						continue
					}
					const type =
						blob.type !== ""
							? blob.type
							: item.kind === "image"
								? (ref.mediaType ?? "image/png")
								: "application/octet-stream"
					files.push(new File([blob], name, { type }))
				} catch (_) {
					lost += 1
				}
			}

			const warnLost = () => {
				if (lost > 0 && typeof window !== "undefined") {
					window.alert(
						"撤回时 " +
							lost +
							" 个附件未能取回（附件可能已过期或被清理），文字已照常放回输入框。",
					)
				}
			}

			if (files.length === 0) return warnLost()
			const shell = await waitShell(ctx, sessionId)
			if (shell === undefined) return warnLost()
			const draft = shell.snapshot
			if (draft === undefined || draft.phase === "adjudicating" || draft.phase === "submitting") {
				return warnLost()
			}
			const service = ctx.get("conversation")
			if (service === undefined) return warnLost()
			let drafts
			try {
				drafts = service.createDrafts(sessionId, files)
				if (shell.addFiles([], drafts.map((d) => d.id)) !== true) {
					service.releaseDraftAttachments(drafts)
					return warnLost()
				}
			} catch (_) {
				if (drafts !== undefined) service.releaseDraftAttachments(drafts)
				return warnLost()
			}
			warnLost()
		}

		/**
		 * 撤回按钮：挂在助手回复动作条上。
		 *
		 * 判定「这条回复能否撤回」不需要读聊天快照：
		 *   assistant-actions 插槽本身只为「轮末尾的助手回复」渲染，
		 *   而撤回语义是「撤掉这一轮及其用户消息」。所以只要拿到
		 *   这一轮对应的用户消息 seq 就能撤。
		 *
		 * 该 seq 由 inject 侧的 onRecall 在点击时现算（见 makeRecall），
		 * 按钮本身只负责渲染与触发，不做状态订阅——避免在第三方包里
		 * 复刻框架的响应式 hook。
		 */
		function RecallAction({ onRecall, t }) {
			if (typeof onRecall !== "function") return null
			return jsx.jsx("button", {
				type: "button",
				className: "dsh-recall-action",
				title: "撤回这一轮",
				"aria-label": "撤回这一轮",
				onClick: () => onRecall(),
				// 关键：框架把非最后一轮的动作条置 opacity:0，
				// 且手机上没有 hover。这里强制自身可见，避免按钮「看不见」。
				style: {
					background: "transparent",
					border: "none",
					cursor: "pointer",
					padding: "0 6px",
					color: "inherit",
					font: "inherit",
					display: "inline-flex",
					alignItems: "center",
					verticalAlign: "middle",
					opacity: 1,
					visibility: "visible",
					pointerEvents: "auto",
					minWidth: "28px",
					minHeight: "28px",
				},
				// react/jsx-runtime 的 jsx() 只接受单个 child；
				// 多个 child 必须用 jsxs + 数组，否则 React 会告警/渲染异常。
				children: jsx.jsxs(
					"svg",
					{
						width: "1em",
						height: "1em",
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
						"aria-hidden": "true",
					},
					[
						jsx.jsx("path", { key: "arrow", d: "M9 14L4 9l5-5" }),
						jsx.jsx("path", { key: "curve", d: "M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9" }),
					],
				),
			})
		}

		// cordis 服务依赖（不是包名）：只列 apply 里真正用到的。
		//   slots         → 注册 conversation.chat.assistant-actions 插槽
		//   sessions      → ctx.sessions.binding(id) / ctx.sessions.fork()
		//   uiWorkspace   → openSession(childId) 切到新分支
		//   uiConversation→ 取会话的 conversation 绑定与草稿服务
		const inject = ["slots", "sessions", "uiWorkspace", "uiConversation"]

		function apply(ctx) {
			ctx.slots.inject("conversation.chat.assistant-actions", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.assistant-actions",
						// ⚠ list 槽位必填 id —— 缺了 register() 直接抛错，
						// 整个客户端模块加载失败（v2.0 初版就是这么崩的）。
						id: "recall",
						order: 50,
						inject: (arg) => {
							// 插槽作用域会传入会话 id（也可能是 { sessionId } 形式的上下文）。
							const sessionId =
								typeof arg === "string" ? arg : (arg?.sessionId ?? arg?.session?.sessionId)
							return {
								sessionId,
								onRecall: () => {
									try {
										if (typeof sessionId !== "string") return
										const binding = ctx.sessions.binding(sessionId)
										if (binding === undefined) return
										const chat = ctx.uiConversation.binding(binding)
										const recall = makeRecall(
											ctx,
											sessionId,
											binding.session,
											chat,
											ctx.uiConversation,
										)
										// 点击时现算「最后一条用户消息」的 seq，避免状态不同步。
										const snap = chat.getSnapshot()
										const userNodes = [...snap.nodes.values()].filter((n) => n.kind === "user")
										const lastUser = userNodes.at(-1)
										if (lastUser === undefined) return
										recall(lastUser.anchorSeq ?? lastUser.data?.seq)
									} catch (e) {
										console.warn("[recall] 撤回触发失败:", e?.message ?? e)
									}
								},
							}
						},
					},
					RecallAction,
				),
			)
			console.log("[recall] 撤回按钮已通过官方插槽挂载（不改写任何框架文件） " + MARK)
			// 启动自检：向主机上报一次，便于在 Host 日志里确认
			// 「客户端半边确实被执行了」。纯诊断用，失败静默。
			try {
				fetch("api/recall.hello", { method: "POST" }).catch(() => {})
			} catch (_) {
				/* 忽略 */
			}
		}

		exports.apply = apply
		exports.inject = inject
		exports.MARK = MARK
		return module.exports
	},
})
