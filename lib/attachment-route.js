// attachment-route.js — 撤回附件回填的主机侧读取路由。
//
// 为什么需要主机侧路由：
//   前端撤回时只能从会话快照里拿到 image/file 块的「引用」（attachmentId、name、mediaType…），
//   拿不到字节。图片可用 session.readAttachment 读回，但普通文件（file 块）没有任何前端 API
//   能读字节，只能由主机侧从 attachments 存储里读出来再交给浏览器，重新组装成 File 放回输入框。
//
// 安全边界：
//   路由挂在 connection 的认证栅栏后（fetch route），只对已登录的本地前端可用；
//   且只允许读取「该会话日志里真实引用过」的附件，不接受任意路径或任意 attachmentId。
//
// 全程 best-effort：任何异常都返回状态码，不影响 dsh 正常对话。


/** 主机侧路由：按会话 + 附件 id 取回原始字节。 */
export const ATTACHMENT_ROUTE = '/api/recall.attachment'

/** 主机侧路由：撤回时显式请求工作区文件还原（普通「分支」不会调用它）。 */
export const RESTORE_ROUTE = '/api/recall.restore'

/**
 * 从一段 content 数组里找目标附件引用。
 * @param {unknown} content - 消息内容块数组。
 * @param {string} attachmentId - 目标附件 id（字符串形式）。
 * @returns {{ kind: 'image' | 'file', ref: object } | undefined}
 */
function findInContent(content, attachmentId) {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const ref = block.attachment
    if (ref === null || typeof ref !== 'object') continue
    if (String(ref.attachmentId) !== attachmentId) continue
    if (block.type === 'image') return { kind: 'image', ref }
    if (block.type === 'file') return { kind: 'file', ref }
  }
  return undefined
}

/**
 * 在会话事件日志里定位一个被引用过的附件。
 * 只认几处 first-party 的内容字段，不做无限深度搜索，避免误命中。
 * @param {readonly any[]} events - 会话事件数组。
 * @param {string} attachmentId - 目标附件 id。
 * @returns {{ kind: 'image' | 'file', ref: object } | undefined}
 */
export function findAttachmentRef(events, attachmentId) {
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue

    const found = findInContent(data.content, attachmentId)
    if (found !== undefined) return found

    const messageContent = data.message?.content
    const inMessage = findInContent(messageContent, attachmentId)
    if (inMessage !== undefined) return inMessage

    if (Array.isArray(data.inserted)) {
      for (const message of data.inserted) {
        if (message === null || typeof message !== 'object') continue
        const inserted = findInContent(message.content, attachmentId)
        if (inserted !== undefined) return inserted
      }
    }
  }
  return undefined
}

const NO_STORE = { 'cache-control': 'no-store' }

/**
 * 处理一次「撤回文件还原」请求。
 *
 * 这是文件还原的唯一入口——普通「分支」不经过它，因此不会被误伤。
 * @param {Request} request - 入站请求（POST）。
 * @param {any} scope - 已注入 sessions / sessionQuery 的上下文。
 * @param {(parentId:string, turnSeq:number, cwd:string) => object} restore - 还原实现。
 * @returns {Promise<Response>} JSON 结果。
 */
async function handleRestoreRequest(request, scope, restore) {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, reason: 'method-not-allowed' }, { status: 405 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  const turnRaw = url.searchParams.get('turnSeq')
  if (typeof sessionId !== 'string' || sessionId === '') {
    return Response.json({ ok: false, reason: 'missing-sessionId' }, { status: 400 })
  }
  const turnSeq = Number.parseInt(turnRaw ?? '', 10)

  // 取会话 cwd：优先活会话，退回持久化读取。
  let cwd
  try {
    const live = scope.sessions.get(sessionId)
    if (live !== undefined && typeof live.header?.cwd === 'string') {
      cwd = live.header.cwd
    } else {
      const read = await scope.sessionQuery.readSession(sessionId)
      cwd = read.session?.cwd
    }
  } catch (error) {
    return Response.json(
      { ok: false, reason: 'session-unavailable', detail: String(error?.message ?? error) },
      { status: 404 },
    )
  }
  if (typeof cwd !== 'string' || cwd === '') {
    return Response.json({ ok: false, reason: 'no-cwd' }, { status: 400 })
  }

  try {
    const result = await restore(sessionId, turnSeq, cwd)
    return Response.json(result, { headers: NO_STORE })
  } catch (error) {
    return Response.json(
      { ok: false, reason: 'restore-failed', detail: String(error?.message ?? error) },
      { status: 500 },
    )
  }
}

/**
 * 处理一次附件读取请求。
 * @param {Request} request - 入站请求。
 * @param {any} scope - 已注入 sessions / sessionQuery / attachments 的上下文。
 * @returns {Promise<Response>} 字节响应或失败状态。
 */
async function handleAttachmentRequest(request, scope) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  const attachmentId = url.searchParams.get('attachmentId')
  if (typeof sessionId !== 'string' || sessionId === '') {
    return new Response('missing sessionId', { status: 400 })
  }
  if (typeof attachmentId !== 'string' || attachmentId === '') {
    return new Response('missing attachmentId', { status: 400 })
  }

  // 优先用活会话的内存快照（撤回时父会话通常仍挂着），退回到持久化读取。
  let events
  try {
    const live = scope.sessions.get(sessionId)
    if (live !== undefined && typeof live.snapshotEvents === 'function') {
      events = live.snapshotEvents()
    } else {
      const read = await scope.sessionQuery.readSession(sessionId)
      events = read.events
    }
  } catch (error) {
    return new Response(`session unavailable: ${String(error?.message ?? error)}`, { status: 404 })
  }

  const found = findAttachmentRef(events, attachmentId)
  if (found === undefined) {
    return new Response('attachment is not referenced by this session', { status: 404 })
  }

  try {
    if (found.kind === 'image') {
      const stored = await scope.attachments.readImage(found.ref)
      const mediaType = stored.ref?.mediaType ?? found.ref?.mediaType ?? 'application/octet-stream'
      const body = new Uint8Array(stored.data)
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          'content-type': mediaType,
          'content-length': String(body.byteLength),
          ...NO_STORE,
        },
      })
    }

    // 普通文件用流式响应，避免把大文件整个读进内存（早期版本 concat 全部
    // chunk，几十 MB 的附件就能把主机进程内存顶起来）。
    const headers = { 'content-type': 'application/octet-stream', ...NO_STORE }
    const knownBytes = Number(found.ref?.bytes)
    if (Number.isSafeInteger(knownBytes) && knownBytes >= 0) {
      headers['content-length'] = String(knownBytes)
    }
    if (request.method === 'HEAD') return new Response(null, { headers })

    const iterator = scope.attachments.readFileStream(found.ref)
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const next = await iterator.next()
          if (next.done === true) {
            controller.close()
            return
          }
          controller.enqueue(new Uint8Array(next.value))
        } catch (error) {
          controller.error(error)
        }
      },
      async cancel() {
        try {
          await iterator.return?.()
        } catch {
          /* 忽略流关闭异常 */
        }
      },
    })
    return new Response(stream, { headers })
  } catch (error) {
    return new Response(`attachment read failed: ${String(error?.message ?? error)}`, { status: 500 })
  }
}

/**
 * 把附件读取路由与撤回还原路由挂到 connection 的认证栅栏上。
 * 服务未就绪时静默跳过（撤回的其它能力不受影响）。
 * @param {any} ctx - 插件上下文。
 * @param {(parentId:string, turnSeq:number, cwd:string) => object} [restore] - 还原实现。
 */
export function mountAttachmentRoute(ctx, restore) {
  try {
    ctx.inject(['connection', 'sessions', 'sessionQuery', 'attachments'], (scope) => {
      try {
        scope.effect(
          () =>
            scope.connection.fetch.register({
              path: ATTACHMENT_ROUTE,
              methods: ['GET', 'HEAD'],
              requestBody: 'buffered',
              fetch: (request) => handleAttachmentRequest(request, scope),
            }),
          'dsh-recall: attachment route',
        )
        console.log('[recall] 附件读取路由已注册:', ATTACHMENT_ROUTE)

        if (typeof restore === 'function') {
          scope.effect(
            () =>
              scope.connection.fetch.register({
                path: RESTORE_ROUTE,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: (request) => handleRestoreRequest(request, scope, restore),
              }),
            'dsh-recall: restore route',
          )
          console.log('[recall] 撤回还原路由已注册:', RESTORE_ROUTE)
        }
      } catch (error) {
        console.warn('[recall] 附件路由注册失败(忽略):', error?.message ?? error)
      }
    })
  } catch (error) {
    console.warn('[recall] 附件路由注入失败(忽略):', error?.message ?? error)
  }
}
