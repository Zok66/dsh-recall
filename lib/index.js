// dsh-recall — dsh 的「撤回」完整实现（对话 + 文件）。
//
// 一个插件做三件事：
//   ① 前端补丁：给消息渲染注入回旋箭头按钮，只挂在最后一条用户消息上；
//   ② 撤回语义：fork 出干净的新会话（思考/工具/产物全丢弃）；
//   ③ 文件还原：每轮开始前快照工作区，撤回时把被改过的文件还原、把新增的删掉。
//
// 为什么补丁要在启动时重打：
//   dsh 的「环境安装与修复」会重新解包 node_modules，覆盖手写改动。
//   本插件每次启动检查补丁标记，缺失就自动补回，实现自愈。
//
// 全程 best-effort：任何异常都吞掉，绝不影响 dsh 正常对话。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGET, MARK, hasPatch, applyClientPatch } from './client-patch.js'
import { mountAttachmentRoute } from './attachment-route.js'
import {
  snapshotTurn,
  restoreTurn,
  listTurns,
  readMeta,
  SNAPSHOT_ROOT,
} from './snapshot-store.js'

/** 本插件自己的安装目录（绝对路径），撤回删新增文件时必须排除掉。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 每个会话最后快照的轮次 seq，避免重复快照。 */
const lastSnapshotted = new Map()

/* ────────────────────────── ① 前端补丁 ────────────────────────── */

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

/* ────────────────────────── ② 文件快照 ────────────────────────── */

function onSessionEvent(session, event) {
  try {
    if (event?.type !== 'turn/start') return
    const sessionId = session?.id
    const cwd = session?.header?.cwd
    if (typeof sessionId !== 'string' || typeof cwd !== 'string') return
    const turnSeq = typeof event.seq === 'number' ? event.seq : undefined
    if (turnSeq === undefined) return
    if (lastSnapshotted.get(sessionId) === turnSeq) return
    lastSnapshotted.set(sessionId, turnSeq)
    const r = snapshotTurn(sessionId, turnSeq, cwd)
    if (r !== null) {
      console.log(
        `[recall] ${sessionId} turn#${turnSeq} 已快照 ${r.files} 个文件 (${r.bytes} 字节)`,
      )
    }
  } catch (e) {
    console.warn('[recall] 快照失败(忽略):', e?.message ?? e)
  }
}

/* ────────────────────────── ③ 撤回时还原文件 ────────────────────────── */

function onSessionCreated(session) {
  try {
    const header = session?.header
    if (header === null || typeof header !== 'object') return
    const parentId = header.parentSession
    if (typeof parentId !== 'string' || !parentId) return
    const cwd = header.cwd
    if (typeof cwd !== 'string' || !cwd) return

    const turns = listTurns(parentId)
    if (turns.length === 0) return

    // 撤回第 N 轮 ⇒ inheritedEventCount = 第 N-1 轮 turn/end.seq + 1。
    // 目标快照 = 所有 key >= inherit 中最小的那个（正是被撤轮开始前的状态）。
    const inherit =
      typeof session.inheritedEventCount === 'number' ? Number(session.inheritedEventCount) : 0
    const candidates = turns.filter((t) => t >= inherit).sort((a, b) => a - b)
    const pick = candidates.length > 0 ? candidates[0] : turns[turns.length - 1]

    const meta = readMeta(parentId, pick)
    if (meta === null) return
    // ⚠ 必须保护插件自身目录：插件源码常直接装在用户工作区里（本插件就装在
    // /sdcard/Zorrose-DSHA/日常/dsh-recall）。撤销时不加保护会把「本轮新增的插件
    // 文件」当成 AI 产物删掉，导致 dsh 下次启动报 ERR_MODULE_NOT_FOUND（实测踩过）。
    const r = restoreTurn(parentId, pick, cwd, {
      removeAdded: true,
      protect: [PLUGIN_ROOT, SNAPSHOT_ROOT],
    })
    if (r.ok) {
      console.log(
        `[recall] 撤回还原: 父会话 ${parentId} turn#${pick} → 还原 ${r.restored}, 删除新增 ${r.removed}, 跳过 ${r.skipped}, 失败 ${r.failed}`,
      )
      // 注：不再 dropSession(parentId)。撤回文案承诺「原会话保留在列表中可回看」，
      // 且子会话只是进度分支，删父会话会让主人误以为历史丢失、界面错乱。快照目录保留无害。
    }
  } catch (e) {
    console.warn('[recall] 还原失败(忽略):', e?.message ?? e)
  }
}

/* ────────────────────────── 插件入口 ────────────────────────── */

export const name = 'dsh-recall'

export function apply(ctx) {
  ensurePatch()
  mountAttachmentRoute(ctx)
  ctx.on('session/event', onSessionEvent)
  ctx.on('session/created', onSessionCreated)
  console.log('[recall] 已启用：撤回按钮（仅最后一条消息）+ 附件回填 + 文件快照与还原')
}

/** 供诊断使用：当前补丁状态。 */
export function status() {
  return { target: TARGET, mark: MARK, patched: hasPatch() }
}
