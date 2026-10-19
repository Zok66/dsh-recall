// dsh-recall — dsh 的「撤回」完整实现（对话 + 文件）。
//
// 架构（v2.2：宿主补丁 + 自愈，回到实测可用的方案）：
//   · 按钮渲染：正则改写 dsh-client-ui-chat/lib/client.js，把撤回按钮注入到
//     用户消息的 React 组件树内（client-patch.js）。这是唯一被实测证明
//     「点击一定有效」的方案——按钮是 React 组件的一部分，走 React 合成事件。
//     v2.0~v2.1 试过的「官方插槽」（位置在 AI 回复下，用户不要）和
//     「DOM 注入」（App WebView 里点击无反应，原因不明但实测复现）都放弃了。
//   · 卸载自愈：每次启动检查补丁标记，被「环境安装与修复」覆盖就自动补回；
//     uninstall.js 提供干净还原（带基线校验，防降级）。
//   · 撤回语义：fork 干净分支 + 回填文字附件 + 显式请求文件还原
//     （lib/snapshot-store.js + /api/recall.restore，普通「分支」不经过它）。
//
// 全程 best-effort：任何异常都吞掉，绝不影响 dsh 正常对话。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGET, MARK, hasPatch, applyClientPatch } from './client-patch.js'
import { mountAttachmentRoute } from './attachment-route.js'
import { snapshotTurn, restoreTurn, listTurns, readMeta, SNAPSHOT_ROOT } from './snapshot-store.js'

/** 本插件自己的安装目录（绝对路径），撤回删新增文件时必须排除掉。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 每个会话最后快照的轮次 seq，避免重复快照。 */
const lastSnapshotted = new Map()

export const name = 'dsh-recall'

/* ────────────────────────── ① 前端补丁（启动自愈） ────────────────────────── */

function ensurePatch() {
  try {
    if (hasPatch()) return
    console.log('[recall] 检测到前端补丁缺失，正在重新注入…')
    const changed = applyClientPatch()
    console.log(changed ? '[recall] 前端撤回按钮已注入' : '[recall] 补丁已就绪，无需改动')
  } catch (e) {
    console.warn('[recall] 补丁失败(忽略):', e?.message ?? e)
  }
}

/* ────────────────────────── ② 每轮开始前的文件快照 ────────────────────────── */

async function onSessionEvent(session, event) {
  try {
    if (event?.type !== 'turn/start') return
    const sessionId = session?.id
    const cwd = session?.header?.cwd
    if (typeof sessionId !== 'string' || typeof cwd !== 'string') return
    const turnSeq = typeof event.seq === 'number' ? event.seq : undefined
    if (turnSeq === undefined) return
    if (lastSnapshotted.get(sessionId) === turnSeq) return
    lastSnapshotted.set(sessionId, turnSeq)
    // 快照走异步 IO：早期版本同步遍历+读写，实测 200 文件/22MB 工作区
    // 会阻塞主线程 232ms，直接卡住这一轮的响应。
    const r = await snapshotTurn(sessionId, turnSeq, cwd)
    if (r !== null) {
      const extra = r.oversize > 0 ? `，另有 ${r.oversize} 个超限文件仅登记不备份` : ''
      console.log(
        `[recall] ${sessionId} turn#${turnSeq} 已快照 ${r.files} 个文件 (${r.bytes} 字节)${extra}`,
      )
    }
  } catch (e) {
    console.warn('[recall] 快照失败(忽略):', e?.message ?? e)
  }
}

/* ────────────────────────── ③ 撤回时的文件还原 ────────────────────────── */

/**
 * 执行一次撤回的文件还原（由前端显式请求，绝不隐式触发）。
 *
 * 为什么不监听 session/created：
 *   框架自带的「分支」和本插件的「撤回」都走 sessions.fork，子会话都带
 *   header.parentSession，主机侧无法从事件本身区分两者。靠 parentSession
 *   猜测会导致用户点普通「分支」时工作区文件被意外回退/删除。
 *   因此文件还原只走 /api/recall.restore 这一条显式通道。
 *
 * @param {string} parentId - 被撤会话 id。
 * @param {number} turnSeq - 撤回边界事件 seq（= 该轮「开始前」快照的 key）。
 * @param {string} cwd - 工作区根目录。
 * @returns {Promise<{ok:boolean, restored?:number, removed?:number, skipped?:number, failed?:number, reason?:string}>}
 */
export async function performRecallRestore(parentId, turnSeq, cwd) {
  if (typeof parentId !== 'string' || !parentId) return { ok: false, reason: 'bad-session' }
  if (typeof cwd !== 'string' || !cwd) return { ok: false, reason: 'bad-cwd' }

  const turns = listTurns(parentId)
  if (turns.length === 0) return { ok: false, reason: 'no-snapshot' }

  // 优先用前端传来的精确轮次；它不存在时退回「不小于该 seq 的最早快照」。
  let pick
  if (Number.isSafeInteger(turnSeq) && turns.includes(turnSeq)) {
    pick = turnSeq
  } else {
    const numeric = Number.isSafeInteger(turnSeq) ? turnSeq : 0
    const candidates = turns.filter((t) => t >= numeric).sort((a, b) => a - b)
    pick = candidates.length > 0 ? candidates[0] : turns[turns.length - 1]
  }

  const meta = readMeta(parentId, pick)
  if (meta === null) return { ok: false, reason: 'no-meta' }

  // ⚠ 必须保护插件自身目录：插件源码常直接装在用户工作区里。
  //   不保护会把「本轮新增的插件文件」当成 AI 产物删掉（v1.x 实测踩过）。
  const r = await restoreTurn(parentId, pick, cwd, {
    removeAdded: true,
    protect: [PLUGIN_ROOT, SNAPSHOT_ROOT],
  })
  if (r.ok) {
    console.log(
      `[recall] 撤回还原: 父会话 ${parentId} turn#${pick} → 还原 ${r.restored}, 删除新增 ${r.removed}, 跳过 ${r.skipped}, 失败 ${r.failed}`,
    )
    // 注：不删父会话。撤回文案承诺「原会话保留在列表中可回看」。
  }
  return { ...r, pick }
}

/* ────────────────────────── 插件入口 ────────────────────────── */

export function apply(ctx) {
  ensurePatch()
  mountAttachmentRoute(ctx, performRecallRestore)
  ctx.on('session/event', onSessionEvent)
  console.log('[recall] 已启用：撤回按钮（仅最后一条消息）+ 附件回填 + 文件快照与还原')
  console.log('[recall] 补丁目标:', TARGET, '标记:', MARK)
}

/** 供诊断使用：本插件信息。 */
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')
).version
export function status() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
  return {
    name,
    version: pkgVersion,
    mode: 'host-patch + self-heal',
    rewritesFrameworkFiles: true, // v2.2 起如实承认：补丁方式改写前端文件，卸载请先跑 lib/uninstall.js
    patched: hasPatch(),
  }
}
