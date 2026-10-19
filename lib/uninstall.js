// uninstall.js — 让「卸载插件」真的能恢复到装之前的干净前端。
//
// 问题（主人实测发现的）：
//   插件是「改写 DSH 安装目录里的前端文件」来加撤回按钮的。
//   `dsh plugin remove` 只会摘掉插件本身，**不会**把改过的 client.js 还原，
//   于是卸载后按钮还挂在那里——虽然点了没反应（宿主不再注入 __dshRecall），
//   但看着就像没卸干净，也没法自己消掉。
//
// 本模块给出可执行的还原路径（三条都行）：
//   ① 卸载前先跑：  node lib/uninstall.js
//   ② 只看状态：    node lib/uninstall.js --status
//   ③ 演练不写盘：  node lib/uninstall.js --dry-run
//
// 还原逻辑刻意保守：
//   - 只认 .orig-recall 备份，且**先验证**「备份 + 补丁 逐字节 === 当前文件」；
//   - 验证不过（多半是 DSH 升级过、备份已过期）就**拒绝还原**并说明原因，
//     绝不把前端降级成旧版本；
//   - 还原前把当前带补丁的版本另存一份，出问题能救回来。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { applyPatch } from './client-patch.js'

/** 自动定位 chat 前端包（与 client-patch.js 同一套解析顺序）。 */
function resolveTarget() {
  try {
    const selfReq = createRequire(path.join(process.cwd(), 'package.json'))
    const chatRoot = selfReq.resolve('@deepseek-ai/dsh-client-ui-chat')
    const chat = chatRoot.replace(/lib[\\/]index\.js$/, 'lib/client.js')
    if (fs.existsSync(chat)) return chat
  } catch {
    /* 走兜底 */
  }
  return '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
}

export const TARGET = resolveTarget()
/** 打补丁前的干净备份（首次打补丁时由 client-patch.js 创建）。 */
export const BACKUP = TARGET + '.orig-recall'
/** 还原前把带补丁版本另存到这里，便于反悔。 */
export const RESCUE = TARGET + '.recall-before-uninstall'
export const MARK_PREFIX = '@@DSH_RECALL_PATCH'

/**
 * 检查当前安装状态，不做任何改动。
 * @returns {{target:string, exists:boolean, patched:boolean, hasBackup:boolean,
 *            restorable:boolean, reason?:string}}
 */
export function inspect() {
  if (!fs.existsSync(TARGET)) {
    return { target: TARGET, exists: false, patched: false, hasBackup: false, restorable: false, reason: 'target-missing' }
  }
  const current = fs.readFileSync(TARGET, 'utf8')
  const patched = current.includes(MARK_PREFIX)
  const hasBackup = fs.existsSync(BACKUP)
  if (!patched) {
    return { target: TARGET, exists: true, patched: false, hasBackup, restorable: false, reason: 'not-patched' }
  }
  if (!hasBackup) {
    return { target: TARGET, exists: true, patched: true, hasBackup: false, restorable: false, reason: 'no-backup' }
  }
  const verdict = verifyBaseline(fs.readFileSync(BACKUP, 'utf8'), current)
  return {
    target: TARGET,
    exists: true,
    patched: true,
    hasBackup: true,
    restorable: verdict === true,
    ...verdict === true ? {} : { reason: verdict },
  }
}

/**
 * 还原前端为未打补丁的干净版本。
 * @param {{force?:boolean}} [opts] - force 跳过基线校验（不建议）。
 * @returns {{ok:boolean, action:string, detail?:string}}
 */
export function uninstall(opts = {}) {
  const state = inspect()
  if (!state.exists) return { ok: false, action: 'skip', detail: '前端文件不存在' }
  if (!state.patched) return { ok: true, action: 'already-clean', detail: '当前没有插件补丁，无需还原' }
  if (!state.hasBackup) {
    return {
      ok: false,
      action: 'refuse',
      detail: `找不到备份 ${path.basename(BACKUP)}，无法安全还原。可重装 DSH 覆盖该文件。`,
    }
  }

  if (opts.force !== true) {
    const verdict = verifyBaseline(fs.readFileSync(BACKUP, 'utf8'), fs.readFileSync(TARGET, 'utf8'))
    if (verdict !== true) {
      return {
        ok: false,
        action: 'refuse',
        detail: `备份与当前前端不是同一版本（${verdict}）。多半是 DSH 升级过，直接用旧备份会把前端降级；已拒绝还原。可重装 DSH 覆盖，或确认风险后加 --force。`,
      }
    }
  }

  try {
    if (!fs.existsSync(RESCUE)) fs.copyFileSync(TARGET, RESCUE)
    fs.copyFileSync(BACKUP, TARGET)
    return {
      ok: true,
      action: 'restored',
      detail: `已还原 ${path.basename(TARGET)}；带补丁的版本另存为 ${path.basename(RESCUE)}`,
    }
  } catch (error) {
    return { ok: false, action: 'error', detail: String(error?.message ?? error) }
  }
}

/**
 * 校验备份是否为当前文件的正确基线。
 *
 * 手段：用备份**重新打一遍补丁**，结果应当逐字节等于当前文件。
 * 这样既验证了同源，也验证了补丁规则没漂移。
 * @param {string} backup - 干净备份内容。
 * @param {string} current - 当前（带补丁）内容。
 * @returns {true|string} 通过返回 true，否则返回原因。
 */
export function verifyBaseline(backup, current) {
  try {
    const r = applyPatch(backup)
    if (r === undefined || r.changed !== true) return '备份结构不匹配当前补丁规则'
    return r.src === current ? true : '备份重新打补丁后与当前文件不一致'
  } catch (error) {
    return `校验过程异常：${String(error?.message ?? error)}`
  }
}

/* ────────────────────────── 命令行入口 ────────────────────────── */

const invokedDirectly =
  process.argv[1] !== undefined && /uninstall\.js$/.test(process.argv[1])

if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')

  if (argv.includes('--status')) {
    console.log(JSON.stringify(inspect(), null, 2))
    process.exit(0)
  }

  if (argv.includes('--dry-run')) {
    const s = inspect()
    console.log('[recall] 当前状态:', JSON.stringify(s, null, 2))
    console.log('[recall] 将执行: 用备份还原前端（--dry-run，不实际写入）')
    process.exit(s.restorable || s.reason === 'not-patched' ? 0 : 1)
  }

  const r = uninstall({ force })
  console.log(`[recall] ${r.action}: ${r.detail ?? ''}`)
  if (!r.ok) {
    console.log('[recall] 还原失败不影响 DSH 正常使用，但前端会保留撤回按钮。')
    process.exit(1)
  }
  console.log('[recall] 完成。请手动重启 dsh web 让前端重新加载。')
}
