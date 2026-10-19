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

/** 单轮快照的占用字节（递归累加文件大小）。 */
function turnBytes(sessionId, turnSeq) {
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
  walk(path.join(sessionDir(sessionId), String(turnSeq)))
  return sum
}

/**
 * 从最旧的轮次开始清理，直到会话总占用回到上限内。
 *
 * ⚠ 性能：早期实现把 totalBytes(全目录递归 statSync) 放进循环里，每删一轮
 *   就全量重扫一次 —— O(轮数²×文件数)。实测 50 轮 × 70 文件时单次 prune
 *   要 17.5 万次 statSync、耗时 1.15 秒，直接卡住 turn/start。
 *   现改为「先算每轮占用，再按序删除并减法维护总量」，statSync 量
 *   降为 O(轮数×文件数)，只有上限被真正超出时才执行。
 */
function pruneOldest(sessionId, keepTurnSeq) {
  // ⚠ 收敛性：早期实现把 keepTurnSeq（最新轮）排除在删除候选外——
  //   极端场景（单轮很大/总量持续增长）下其余轮删光仍超限，循环提前结束，
  //   快照总量**无上界**（实测 80 轮 × 7MB 涨到 560MB 不再下降）。
  //   且更早的轮被过早清光，撤回只剩最后一轮可用（能力退化）。
  //   现在：最新轮排最后参与清理——先删旧轮，确实还超限才删最新轮。
  //   代价是极端时撤回历史被清空，但换回「总量必有上界」这条硬约束。
  const turns = listTurns(sessionId)
  const sizes = new Map()
  let total = 0
  for (const t of turns) {
    const meta = readMeta(sessionId, t)
    const b = meta && Number.isSafeInteger(meta.bytes) ? meta.bytes : turnBytes(sessionId, t)
    sizes.set(t, b)
    total += b
  }
  if (total <= MAX_TOTAL_BYTES) return
  // 最新轮排最末：先删旧的，最后才动它
  // （比较器必须双参：单参写法 a===keep?1:0 语义错误，实测 keep 仍在中间被删）
  for (const t of [...turns].sort((a, b) => a - b).sort((a, b) => (a === keepTurnSeq ? 1 : 0) - (b === keepTurnSeq ? 1 : 0))) {
    if (total <= MAX_TOTAL_BYTES) return
    try {
      fs.rmSync(path.join(sessionDir(sessionId), String(t)), { recursive: true, force: true })
      total -= sizes.get(t) ?? 0
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
  // ⚠ 安全校验：sessionId 会被拼进快照存储路径，必须拦住路径穿越。
  //   只允许字母数字、连字符、下划线、点，且不允许包含 ../。
  //   宿主生成的会话 id 是 UUID 格式，此约束不影响正常使用。
  //   （实测：不拦的话 '../../tmp/evil' 能把快照写到快照根之外。）
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) || sessionId.includes('..')) return null
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

  // ⚠ 增量快照：工作区大部分文件在轮与轮之间是不变的，全量重备份会让
  //   快照占用随轮数线性膨胀（实测每轮重复备份同 70 个文件 = 7MB/轮，
  //   100 轮就是 700MB）。改为：与上一轮 sha1 相同的文件只登记清单
  //   （savedIn 指向字节实际所在的那一轮），不复制字节。
  //   还原时 resolveFileSource 向前回溯找字节所在轮。
  const turnsBefore = listTurns(sessionId).filter((t) => t < turnSeq)
  const prevTurn = turnsBefore.length > 0 ? turnsBefore[turnsBefore.length - 1] : null
  const prevMeta = prevTurn === null ? null : readMeta(sessionId, prevTurn)
  const prevHashes = new Map()
  for (const f of prevMeta?.files ?? []) prevHashes.set(f.rel, { sha1: f.sha1, turn: prevTurn })
  // 上上轮起的映射也并入（prev 轮可能自己就是增量轮，字节在更早的轮里）
  for (const t of turnsBefore) {
    const m = readMeta(sessionId, t)
    for (const f of m?.files ?? []) {
      if (!prevHashes.has(f.rel)) prevHashes.set(f.rel, { sha1: f.sha1, turn: f.savedIn ?? t })
    }
  }

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
      const sha1 = hashOf(buf)
      // 增量：与历史轮同内容 → 不复制字节，只登记字节所在轮
      const known = prevHashes.get(f.rel)
      if (known !== undefined && known.sha1 === sha1) {
        manifest.push({ rel: f.rel, size: f.size, sha1, savedIn: known.turn })
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
      manifest.push({ rel: f.rel, size: f.size, sha1, savedIn: turnSeq })
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

  /**
   * 增量快照下，文件字节可能存放在更早的轮里（savedIn 指向）。
   * 依次试 savedIn 轮；再沿该轮 meta 向前回溯（早期版本无 savedIn 时
   * 默认字节就在文件所登记的轮）。找不到返回 null。
   */
  const fileBytesCache = new Map()
  function readSnapshotFile(sessionId, turnSeq, f) {
    const cacheKey = f.sha1 + ':' + f.rel
    if (fileBytesCache.has(cacheKey)) return fileBytesCache.get(cacheKey)
    const chain = [f.savedIn ?? turnSeq, turnSeq]
    // 沿 meta 链回溯：savedIn → 该轮同 rel 的 savedIn → … 最多 24 跳
    let curTurn = f.savedIn ?? turnSeq
    let cur = f
    for (let hop = 0; hop < 24 && curTurn !== null; hop += 1) {
      const src = path.join(sessionDir(sessionId), String(curTurn), 'files', cur.rel)
      if (fs.existsSync(src)) {
        try {
          const buf = fs.readFileSync(src)
          if (hashOf(buf) === cur.sha1) {
            fileBytesCache.set(cacheKey, buf)
            return buf
          }
        } catch {
          /* 继续回溯 */
        }
      }
      // 本轮没有（或哈希不符）：沿该轮 meta 的同 rel 条目继续向前
      const m = readMeta(sessionId, curTurn)
      const next = (m?.files ?? []).find((x) => x.rel === cur.rel)
      if (next === undefined) break
      cur = next
      curTurn = next.savedIn ?? null
    }
    fileBytesCache.set(cacheKey, null)
    return null
  }

  for (const f of meta.files ?? []) {
    const dst = path.join(root, f.rel)
    try {
      const want = readSnapshotFile(sessionId, turnSeq, f)
      if (want === null) {
        skipped += 1
        continue
      }
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
      // 类型冲突处理：快照时是普通文件、现在被 AI 换成了目录（或反之）。
      // 直接 writeFileSync 会 EISDIR 失败；必须先移走现在的占位（挪到 .recall-conflict，
      // 不直接删——里面可能有 AI 生成的其他产物，留一手比删干净稳）。
      // （实测：不处理的话该文件还原失败计入 failed，目录原样残留。）
      let dstStat = null
      try {
        dstStat = fs.lstatSync(dst)
      } catch {
        dstStat = null
      }
      if (dstStat !== null && dstStat.isDirectory()) {
        const conflict = dst + '.recall-conflict'
        try {
          fs.rmSync(conflict, { recursive: true, force: true })
          fs.renameSync(dst, conflict)
        } catch {
          failed += 1
          continue
        }
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
  // ⚠ 空目录残留问题：listFiles 只列文件不列目录，删光目录里的文件后
  //   空目录会留在工作区（实测 newdir/inner.txt 删了、newdir/ 还挂着）。
  //   撤回语义是「当没执行过」，空目录也该一并清掉 —— 从最深处往上删空目录。
  // ⚠ 冲突备份豁免：上面类型冲突改名出来的 *.recall-conflict 目录及其内容
  //   也「不在快照清单里」，但不许被这里删掉 —— 那是特意留的 AI 产物。
  //   （实测：不豁免的话 nested.txt 会被当成本轮新增删掉，conflict 只剩空壳。）
  if (opts.removeAdded === true) {
    for (const f of await listFiles(root)) {
      if (known.has(f.rel)) continue
      // 受保护路径（插件自身目录等）永不删除。
      if (isProtected(f.abs)) {
        skipped += 1
        continue
      }
      // 冲突备份目录内的文件永不删除。
      if (f.abs.includes('.recall-conflict' + path.sep) || f.abs.endsWith('.recall-conflict')) {
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
    // 自底向上清空目录：跳过保护路径与快照里的既有目录。
    // ⚠ root 本身不删（工作区不能没了），但**要递归进去**清子目录 ——
    //   早期写成 `dir === root` 时直接 return，连子目录都没进去，
    //   实测 newdir/sub 清不掉。
    const dropEmpty = (dir, depth = 0) => {
      if (depth > 24) return
      if (isProtected(dir)) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isDirectory()) dropEmpty(path.join(dir, e.name), depth + 1)
      }
      // 工作区根本身永远保留；其余目录空了就删。
      // 本插件的冲突备份目录不算「本轮新增」，保留。
      if (dir === root) return
      try {
        if (fs.readdirSync(dir).length === 0 && !dir.endsWith('.recall-conflict')) {
          fs.rmdirSync(dir)
        }
      } catch {
        /* 非空或已被父层处理 */
      }
    }
    dropEmpty(root)
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
