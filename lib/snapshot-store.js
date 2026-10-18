// snapshot-store.js — 文件快照核心：按「会话 + 轮次」保存工作区文件副本。
//
// 设计目标：让 dsh 的「撤回」不只是回退对话，还能把 AI 改过的文件一起还原。
//
// 存储布局：
//   ~/.dsh/.recall-snapshots/<sessionId>/<turnSeq>/<相对路径>
//   每条快照另有 meta.json 记录：轮次、时间、文件清单与哈希。
//
// 关键约束：
//   - 只快照「工作区内」的普通文件，跳过 .git / node_modules / 快照目录自身；
//   - 单文件大小上限，避免把几个 G 的视频也塞进来；
//   - 总占用上限，超出时从最旧的轮次开始清理；
//   - 全部操作 best-effort：任何失败都不抛给 dsh 主流程。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const SNAPSHOT_ROOT = path.join(
  process.env.DSH_HOME || '/root/.dsh',
  '.recall-snapshots',
)

const MAX_FILE_BYTES = 8 * 1024 * 1024 // 单文件 8MB 上限
const MAX_TOTAL_BYTES = 512 * 1024 * 1024 // 单会话总计 512MB
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.recall-snapshots',
  '__pycache__',
  '.venv',
  'dist',
  'build',
  '.next',
])

function hashOf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex')
}

/** 递归列出工作区内的候选文件（相对路径 + 绝对路径 + 大小）。 */
function listFiles(root, depth = 0) {
  const out = []
  if (depth > 12) return out
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(root, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      out.push(...listFiles(abs, depth + 1))
    } else if (e.isFile()) {
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (st.size > MAX_FILE_BYTES) continue
      out.push({ abs, rel: path.relative(root, abs), size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

function sessionDir(sessionId) {
  return path.join(SNAPSHOT_ROOT, sessionId)
}

/** 该会话已保存的所有轮次（按 turnSeq 升序）。 */
export function listTurns(sessionId) {
  const dir = sessionDir(sessionId)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number(e.name))
    .sort((a, b) => a - b)
}

function totalBytes(sessionId) {
  let sum = 0
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else {
        try {
          sum += fs.statSync(abs).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(sessionDir(sessionId))
  return sum
}

function pruneOldest(sessionId, keepTurnSeq) {
  const turns = listTurns(sessionId).filter((t) => t !== keepTurnSeq)
  for (const t of turns) {
    if (totalBytes(sessionId) <= MAX_TOTAL_BYTES) return
    try {
      fs.rmSync(path.join(sessionDir(sessionId), String(t)), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * 为某会话的某一轮建立文件快照。
 * 若该轮已有快照则直接返回（幂等）。
 * @returns {{turn:number, files:number, bytes:number}|null}
 */
export function snapshotTurn(sessionId, turnSeq, cwd) {
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  if (!Number.isSafeInteger(turnSeq) || turnSeq < 0) return null
  if (!fs.existsSync(cwd)) return null

  const dest = path.join(sessionDir(sessionId), String(turnSeq))
  const metaPath = path.join(dest, 'meta.json')
  if (fs.existsSync(metaPath)) return null // 已有快照，幂等跳过

  const files = listFiles(cwd)
  let bytes = 0
  const manifest = []
  try {
    fs.mkdirSync(dest, { recursive: true })
    for (const f of files) {
      let buf
      try {
        buf = fs.readFileSync(f.abs)
      } catch {
        continue
      }
      const relDest = path.join(dest, 'files', f.rel)
      try {
        fs.mkdirSync(path.dirname(relDest), { recursive: true })
        fs.writeFileSync(relDest, buf)
      } catch {
        continue
      }
      bytes += buf.length
      manifest.push({ rel: f.rel, size: f.size, sha1: hashOf(buf) })
    }
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          sessionId,
          turnSeq,
          cwd,
          createdAt: Date.now(),
          fileCount: manifest.length,
          bytes,
          files: manifest,
        },
        null,
        2,
      ),
    )
  } catch {
    return null
  }
  pruneOldest(sessionId, turnSeq)
  return { turn: turnSeq, files: manifest.length, bytes }
}

/** 读取某轮快照的 meta。 */
export function readMeta(sessionId, turnSeq) {
  const p = path.join(sessionDir(sessionId), String(turnSeq), 'meta.json')
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把某轮快照还原到当前工作区。
 *  - 快照里有、现在被改过或被删的 → 写回原内容；
 *  - 快照里没有、但快照之后新建的文件 → 删除（这才是「当没执行过」）；
 *    ⚠ 默认关闭删除，避免误删用户自己新建的文件；由 opts.removeAdded 打开。
 * @returns {{restored:number, removed:number, skipped:number, failed:number, ok:boolean}}
 */
export function restoreTurn(sessionId, turnSeq, cwd, opts = {}) {
  const meta = readMeta(sessionId, turnSeq)
  if (meta === null) return { restored: 0, removed: 0, skipped: 0, failed: 0, ok: false }
  const root = path.resolve(cwd ?? meta.cwd)
  const srcRoot = path.join(sessionDir(sessionId), String(turnSeq), 'files')
  let restored = 0
  let removed = 0
  let skipped = 0
  let failed = 0

  // 快照时刻的文件清单（相对路径集合）
  const known = new Set((meta.files ?? []).map((f) => f.rel))

  for (const f of meta.files ?? []) {
    const src = path.join(srcRoot, f.rel)
    const dst = path.join(root, f.rel)
    try {
      if (!fs.existsSync(src)) {
        skipped += 1
        continue
      }
      const want = fs.readFileSync(src)
      let same = false
      try {
        same = hashOf(fs.readFileSync(dst)) === f.sha1
      } catch {
        same = false
      }
      if (same) {
        skipped += 1
        continue
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, want)
      restored += 1
    } catch {
      failed += 1
    }
  }

  // 删除「快照时不存在、现在存在」的文件（即本轮新增）
  if (opts.removeAdded === true) {
    for (const f of listFiles(root)) {
      if (known.has(f.rel)) continue
      try {
        fs.rmSync(f.abs, { force: true })
        removed += 1
      } catch {
        failed += 1
      }
    }
  }

  return { restored, removed, skipped, failed, ok: true }
}

/** 丢弃某会话全部快照（还原成功后调用）。 */
export function dropSession(sessionId) {
  try {
    fs.rmSync(sessionDir(sessionId), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 统计信息，便于自检/展示。 */
export function stats(sessionId) {
  const turns = listTurns(sessionId)
  return { turns, bytes: totalBytes(sessionId), root: sessionDir(sessionId) }
}
