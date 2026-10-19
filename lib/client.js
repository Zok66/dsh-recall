window.__ModuleLoader__.load({
	id: "dsh-recall",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		// 本模块**不需要** react：按钮走原生 DOM 注入，不渲染 React 组件。
		// 也正因如此没有额外依赖——浏览器半边是单文件加载的，宿主不会替它打包
		// 本包内的其他 .js，所以 DOM 逻辑全部内联在本文件里。

		/* ───────────── 用户消息动作条的 DOM 注入（撤回按钮） ─────────────
		 *
		 * 为什么不用官方插槽：
		 *   宿主只给「助手回复」开了动作条插槽（conversation.chat.assistant-actions），
		 *   用户消息那侧的 actions 是 UserStyleBubble 里硬编码的 MessageIconActions，
		 *   没有 extraActions 入口，第三方插件没有任何官方途径把按钮放进用户消息动作条。
		 *
		 * 但这不是 v1.x 那种「改写框架文件」：
		 *   只在页面 DOM 里插一个按钮，磁盘上任何框架文件都不动；
		 *   插件被 remove 后宿主不再加载本模块，按钮随页面卸载消失。
		 */

		/** 宿主动作条里「复制」按钮的识别特征（中英文都认）。 */
		const COPY_HINTS = ["复制", "copy", "Copy", "Copied", "复制成功"]
		/** 本模块插入按钮的标记，用于去重与清理。 */
		const BTN_ATTR = "data-dsh-recall-btn"

		function isCopyButton(el) {
			if (!el || el.tagName !== "BUTTON") return false
			const label = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")
			return COPY_HINTS.some((hint) => label.includes(hint))
		}

		function makeIcon() {
			const ns = "http://www.w3.org/2000/svg"
			const svg = document.createElementNS(ns, "svg")
			// 不写死 width/height：宿主 CSS 有
			// `.action svg{width:calc(15px + var(--dsh-content-font-delta,0px))}`，
			// 交给它算，图标才和复制按钮一模一样大。兜底路径另行设置内联尺寸。
			//
			// 坐标系与描边对齐宿主图标（dsh-client-ui-primitives 的 outline 系列）：
			// viewBox 用 0 0 16 16、stroke-width 用 1。用 24 网格 + 2px 描边会明显
			// 比复制图标更粗更黑，手机上看着就是「深一块」。
			svg.setAttribute("viewBox", "0 0 16 16")
			svg.setAttribute("fill", "none")
			svg.setAttribute("stroke", "currentColor")
			svg.setAttribute("stroke-width", "1")
			svg.setAttribute("stroke-linecap", "round")
			svg.setAttribute("stroke-linejoin", "round")
			svg.setAttribute("aria-hidden", "true")

			// 回旋箭头（16×16 网格）。
			//
			// ⚠ 几何与位移**不是**凭感觉写的：把图标渲染成 512px 位图量包围盒，
			// 再与宿主复制图标（同为 viewBox 16、1px 描边）逐项对齐：
			//     复制图标  vc=8.234  hc=7.734  vh=13.41  w=13.47  L=1.00  R=14.47
			//     本图标    vc=8.234  hc=7.750  vh=13.41  w=13.50  L=1.00  R=14.50
			// 垂直中心、上下高度、左右边界全部重合。
			//
			// v2.1.1 的两个坑（都已修）：
			//   ① 垂直中心偏低 0.9 单位 → 并排看就是「偏下、不平行」；
			//   ② 曾想用 scale() 放大来对齐尺寸，但 scale 会把 stroke-width
			//      一起放大（1px→1.09px），描边反而又变粗。所以这里**只做平移**，
			//      放大是通过路径坐标本身实现的。
			// 改动前请先重跑包围盒测量，别直接改数字。
			const arrow = document.createElementNS(ns, "path")
			arrow.setAttribute("d", "M7.6 1.9 2.8 5.3l4.8 3.4")
			const curve = document.createElementNS(ns, "path")
			curve.setAttribute("d", "M2.8 5.3h8.0a4.5 4.5 0 0 1 0 9.0H7.3")
			const group = document.createElementNS(ns, "g")
			group.setAttribute("transform", "translate(-1.30,0.16)")

			group.appendChild(arrow)
			group.appendChild(curve)
			svg.appendChild(group)
			return svg
		}

		/**
		 * 造一个撤回按钮，外观**完全复用**宿主动作条里复制按钮的样式。
		 *
		 * 为什么直接抄 className 而不是写内联样式：
		 *   宿主的按钮样式来自 CSS Module（.xxx_action），里面包含了
		 *   前景色 var(--dsw-alias-label-tertiary)、尺寸随
		 *   --dsh-content-font-delta 的 calc()、hover 背景、svg 15px 等一整套规则。
		 *   自己用内联样式复刻，必然出现颜色偏深、大小对不上、
		 *   手机端 hover 行为不同等偏差（v2.1.0 就踩了这个坑）。
		 *   抄类名则完全由宿主 CSS 接管，天然统一；类名带 hash 也没关系，
		 *   因为它就是从同一条动作条上的兄弟按钮读出来的。
		 *
		 * @param {() => void} onClick
		 * @param {Element} copyButton - 同一条动作条里的复制按钮，用来取类名。
		 */
		function makeRecallButton(onClick, copyButton) {
			const button = document.createElement("button")
			button.type = "button"
			button.setAttribute(BTN_ATTR, "")
			button.setAttribute("aria-label", "撤回这一轮")
			button.setAttribute("title", "撤回这一轮")

			// 继承复制按钮的类名：颜色、尺寸、hover、svg 大小全部跟随宿主。
			const classes = typeof copyButton?.className === "string" ? copyButton.className.trim() : ""
			const icon = makeIcon()
			if (classes !== "") {
				button.className = classes
			} else {
				// 极端兜底：拿不到类名时，自己补齐尺寸与前景色，别用深色也别走样。
				Object.assign(button.style, {
					width: "28px",
					height: "28px",
					padding: "6px",
					border: "none",
					borderRadius: "6px",
					background: "transparent",
					color: "var(--dsw-alias-label-tertiary, currentColor)",
					cursor: "pointer",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					verticalAlign: "middle",
				})
				// 没有宿主 CSS 时，图标也不会是 0×0 或默认大尺寸。
				icon.setAttribute("width", "15")
				icon.setAttribute("height", "15")
			}

			button.addEventListener("click", (event) => {
				event.preventDefault()
				event.stopPropagation()
				onClick()
			})
			button.appendChild(icon)
			return button
		}

		/**
		 * 在最后一条用户消息的动作条里、复制按钮左边，确保撤回按钮就位。
		 * @returns {boolean} 本次是否新插入了按钮。
		 */
		function ensureUserRecallButton(onClick) {
			try {
				const rows = document.querySelectorAll('[data-chat-flow-kind="user"]')
				// 撤回语义只作用于「最近这一轮」，所以按钮只该出现在最后一条用户消息上。
				// 新消息出现后，旧位置上的按钮必须先清掉，否则会残留多个。
				const lastRow = rows.length === 0 ? null : rows[rows.length - 1]
				for (const stale of document.querySelectorAll("[" + BTN_ATTR + "]")) {
					if (lastRow === null || !lastRow.contains(stale)) stale.remove()
				}
				if (lastRow === null) return false

				let actionBar = null
				let copyButton = null
				for (const candidate of lastRow.querySelectorAll("button")) {
					if (!isCopyButton(candidate)) continue
					copyButton = candidate
					actionBar = candidate.parentElement
					break
				}
				if (!actionBar || !copyButton) return false

				// 幂等：已插过就不重复插；React 重渲染后顺带保序。
				const existing = actionBar.querySelector("[" + BTN_ATTR + "]")
				if (existing) {
					if (existing.nextSibling !== copyButton) actionBar.insertBefore(existing, copyButton)
					return false
				}
				actionBar.insertBefore(makeRecallButton(onClick, copyButton), copyButton)
				return true
			} catch {
				return false
			}
		}

		/**
		 * 跟随 React 重渲染：用 MutationObserver 兜住动作条被重建的情况。
		 * @returns {() => void} 停止函数。
		 */
		function watchUserRecallButton(onClick) {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
				return () => {}
			}
			let pending = false
			const run = () => {
				pending = false
				ensureUserRecallButton(onClick)
			}
			const kick = () => {
				if (pending) return
				pending = true
				// rAF 合并同一帧内的多次变更；后台标签页降级为 setTimeout。
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(run)
				else setTimeout(run, 16)
			}
			run()
			const observer = new MutationObserver(kick)
			observer.observe(document.body, { childList: true, subtree: true })
			return () => observer.disconnect()
		}

		/**
		 * 取「屏幕上正在显示」的会话 id。
		 *
		 * ⚠ 不能用 retainedBy.mainView 猜（v2.1.3 及之前的写法）：
		 *   那是「主视图保留计数」，多会话并存/列表快照滞后时找到的可能是
		 *   另一个会话（实测：屏幕看 B，撤回却打到了 A），或一个都找不到
		 *   （点击毫无反应，还会静默不报错）。
		 *
		 * 可靠来源：宿主 conversation 视图容器自带
		 *   <div data-conversation-region="chat" data-conversation-session="<sessionId>">
		 * 它由宿主 React 树直接渲染，值就是屏幕上这个聊天视图的会话 id。
		 * 取最后一个匹配（与「按钮挂最后一条用户消息」同一套取法）。
		 * @returns {string|undefined}
		 */
		function currentSessionId() {
			try {
				const regions = document.querySelectorAll(
					'[data-conversation-region="chat"][data-conversation-session]',
				)
				for (let i = regions.length - 1; i >= 0; i -= 1) {
					const id = regions[i].getAttribute("data-conversation-session")
					if (typeof id === "string" && id !== "") return id
				}
			} catch {
				/* 忽略 */
			}
			return undefined
		}

		/** 观察器停止函数（插件卸载时用）。 */
		let stopWatching = null

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

		// cordis 服务依赖（不是包名）：只列 apply 里真正用到的。
		//   sessions      → ctx.sessions.list / binding(id) / fork()
		//   uiWorkspace   → openSession(childId) 切到新分支
		//   uiConversation→ 取会话的 conversation 绑定与草稿服务
		// 注意：不再依赖 slots——按钮走 DOM 注入，不注册任何插槽。
		const inject = ["sessions", "uiWorkspace", "uiConversation"]

		function apply(ctx) {
			// 按钮走 DOM 注入，放进「最后一条用户消息」的动作条、复制按钮左边
			// （与 v1.x 一致的观感）。之所以不用官方插槽：宿主只给助手回复开了
			// assistant-actions，用户消息侧的 actions 是硬编码的，没有扩展点。
			//
			// 但这仍然是「零侵入」的：只往页面 DOM 插按钮，不改磁盘上任何框架
			// 文件；插件被 remove 后宿主不再加载本模块，按钮随页面卸载消失。
			const triggerRecall = () => {
				try {
					const sessionId = currentSessionId()
					if (typeof sessionId !== "string") {
						console.warn("[recall] 取不到当前会话，撤回已忽略")
						return
					}
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
			}

			try {
				stopWatching = watchUserRecallButton(triggerRecall)
				console.log("[recall] 撤回按钮已注入用户消息动作条（不改写任何框架文件） " + MARK)
			} catch (e) {
				console.warn("[recall] 按钮注入失败(忽略):", e?.message ?? e)
			}

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
