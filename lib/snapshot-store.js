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

/**
 * 递归列出工作区内的文件（相对路径 + 绝对路径 + 大小）。
 *
 * 关键：**默认列出全部文件，不因为超过单文件上限而丢弃**。
 * 早期版本在这里直接跳过 >8MB 的文件，导致：
 *   ① 超大文件不在快照清单里 → 撤回时无法恢复，且**不报错**（静默丢改动）；
 *   ② 超大文件也不在「新增文件」清单里 → 本轮新建的超大文件撤不干净。
 * 现在改为「照常列出并标记 oversize」，由调用方分别决定存不存、删不删。
 * @param {string} root - 工作区根目录。
 * @param {number} depth - 递归深度（防御性上限）。
 * @returns {Array<{abs:string, rel:string, size:number, mtimeMs:number, oversize:boolean}>}
 */
async function listFiles(root, depth = 0) {
  const out = []
  if (depth > 24) return out
  let entries
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(root, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      out.push(...(await listFiles(abs, depth + 1)))
    } else if (e.isFile()) {
      let st
      try {
        st = await fs.promises.stat(abs)
      } catch {
        continue
      }
      out.push({
        abs,
        rel: path.relative(root, abs),
        size: st.size,
        mtimeMs: st.mtimeMs,
        oversize: st.size > MAX_FILE_BYTES,
      })
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
export async function snapshotTurn(sessionId, turnSeq, cwd) {
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  if (!Number.isSafeInteger(turnSeq) || turnSeq < 0) return null
  const cwdStat = await fs.promises.stat(cwd).catch(() => null)
  if (cwdStat === null || !cwdStat.isDirectory()) return null

  const dest = path.join(sessionDir(sessionId), String(turnSeq))
  const metaPath = path.join(dest, 'meta.json')
  const existing = await fs.promises.stat(metaPath).catch(() => null)
  if (existing !== null) return null // 已有快照，幂等跳过

  const files = await listFiles(cwd)
  let bytes = 0
  const manifest = []
  /** 超上限未备份的文件：只登记路径与大小，撤回时用于「不误删」判定。 */
  const oversizeManifest = []
  try {
    await fs.promises.mkdir(dest, { recursive: true })
    for (const f of files) {
      // 超过单文件上限：不备份字节（避免快照膨胀），但仍要登记路径，
      // 这样撤回时知道「它本来就在」，绝不会把它当成本轮新增删掉。
      if (f.oversize) {
        oversizeManifest.push({ rel: f.rel, size: f.size })
        continue
      }
      let buf
      try {
        buf = await fs.promises.readFile(f.abs)
      } catch {
        continue
      }
      const relDest = path.join(dest, 'files', f.rel)
      try {
        await fs.promises.mkdir(path.dirname(relDest), { recursive: true })
        await fs.promises.writeFile(relDest, buf)
      } catch {
        continue
      }
      bytes += buf.length
      manifest.push({ rel: f.rel, size: f.size, sha1: hashOf(buf) })
    }
    await fs.promises.writeFile(
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
          // 超上限未备份的文件（只记路径，撤回时不删它们）
          oversize: oversizeManifest,
        },
        null,
        2,
      ),
    )
  } catch {
    return null
  }
  pruneOldest(sessionId, turnSeq)
  return { turn: turnSeq, files: manifest.length, bytes, oversize: oversizeManifest.length }
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
 *  - opts.protect：受保护的绝对路径前缀（文件或目录）。删除新增文件时跳过它们。
 *    这是必须的：插件源码常常就装在用户工作区里（例如本插件就装在
 *    /sdcard/Zorrose-DSHA/日常/dsh-recall），若不保护，撤回会把插件自己
 *    当成「本轮新增文件」删掉，造成 dsh 下次启动直接找不到模块。
 * @returns {{restored:number, removed:number, skipped:number, failed:number, ok:boolean}}
 */
export async function restoreTurn(sessionId, turnSeq, cwd, opts = {}) {
  const meta = readMeta(sessionId, turnSeq)
  if (meta === null) return { restored: 0, removed: 0, skipped: 0, failed: 0, ok: false }
  const root = path.resolve(cwd ?? meta.cwd)
  const srcRoot = path.join(sessionDir(sessionId), String(turnSeq), 'files')
  let restored = 0
  let removed = 0
  let skipped = 0
  let failed = 0

  // 快照时刻的文件清单（相对路径集合）。
  // ⚠ 必须同时包含 oversize 里的路径：那些文件没备份字节，但它们
  // 「本来就在」，绝不能因为不在 files 里就被当成本轮新增删掉。
  const known = new Set([
    ...(meta.files ?? []).map((f) => f.rel),
    ...(meta.oversize ?? []).map((f) => f.rel),
  ])

  // 受保护前缀：删除前逐条比对，命中即跳过（不删、不计失败）。
  const protect = (Array.isArray(opts.protect) ? opts.protect : [])
    .filter((p) => typeof p === 'string' && p)
    .map((p) => path.resolve(p))
  const isProtected = (abs) =>
    protect.some((p) => abs === p || abs.startsWith(p + path.sep))

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

  // 删除「快照时不存在、现在存在」的文件（即本轮新增）。
  // listFiles 现在会列出全部文件（含超上限），保证本轮新建的大文件也能被撤干净。
  if (opts.removeAdded === true) {
    for (const f of await listFiles(root)) {
      if (known.has(f.rel)) continue
      // 受保护路径（插件自身目录等）永不删除。
      if (isProtected(f.abs)) {
        skipped += 1
        continue
      }
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
