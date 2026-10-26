#!/usr/bin/env node
/**
 * 只读采样：用户库资产名 + 本地分类 + 站方 `classifyBaseName`（知末详情页实测）。
 *
 * 用途：为 `src/shared/zhimoTaxonomyMap.ts` 与 `docs/28-知末分类映射-样本核准.md` 凑真实样本。
 *
 * 纪律：
 * - **只读**：本脚本只 `readdir` / `stat` 用户库，不写任何文件到库目录；输出只写到 `--out`。
 * - 不启动 Electron、不碰 Dexie、不改任何资产记录。
 * - 站方详情页 GET 走 `__NEXT_DATA__`（`docs/23` 已实测无需登录），串行 + 节流，单批上限默认 120。
 *
 * 用法：
 *   node scripts/sample-zhimo-classify.mjs --library "E:/ModVault/Library" --out .probe/zhimo-classify/samples.json
 *   node scripts/sample-zhimo-classify.mjs --no-fetch            # 只跑本地（不联网）
 *   node scripts/sample-zhimo-classify.mjs --limit 60 --delay 300
 *
 * ID 识别口径与 `src/shared/naming.ts: zhimoIdFromText()` 一致（本脚本是 .mjs，无法 import TS，
 * 故逐条复制三条正则；口径变更时**两处必须同步**）：
 *   ① `ID` 标记（6 位以上）→ ② `znzmo-<ID>` → ③ 裸 9–10 位数字
 */

import { readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'

// ── 与 src/shared/naming.ts 同口径的 ID 正则 ──────────────────────────
const ZHIMO_ID_TAIL_RE = /[\s_\-]*ID[\s_\-]?\d{6,}$/i
const ZHIMO_ID_MID_RE = /[\s_\-]?ID[\s_\-]?\d{6,}(?=[\s_\-.])/gi
const ZNZMO_ID_RE = /(?<![A-Za-z])znzmo[\s_\-]*(\d{6,})(?!\d)/gi
const BARE_ZHIMO_ID_RE = /(?<!\d)\d{9,10}(?!\d)/g

function rightmostMatch(re, s, group = 1) {
  re.lastIndex = 0
  let out = null
  for (const m of s.matchAll(re)) {
    if (m[group]) out = m[group]
  }
  re.lastIndex = 0
  return out
}

function idMarkerIdOf(s) {
  const digitsOf = (fragment) => /\d{6,}/.exec(fragment)?.[0] ?? null
  let mid = null
  ZHIMO_ID_MID_RE.lastIndex = 0
  for (const m of s.matchAll(ZHIMO_ID_MID_RE)) {
    const digits = digitsOf(m[0])
    if (digits) mid = digits
  }
  ZHIMO_ID_MID_RE.lastIndex = 0
  const tailMatch = ZHIMO_ID_TAIL_RE.exec(s)
  const tail = tailMatch ? digitsOf(tailMatch[0]) : null
  return mid ?? tail
}

function zhimoIdFromText(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  const explicit = idMarkerIdOf(s)
  if (explicit) return explicit
  const znzmo = rightmostMatch(ZNZMO_ID_RE, s)
  if (znzmo) return znzmo
  return rightmostMatch(BARE_ZHIMO_ID_RE, s, 0)
}

// ── 参数 ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    library: 'E:/ModVault/Library',
    out: '.probe/zhimo-classify/samples.json',
    limit: 120,
    delay: 300,
    fetch: true
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-fetch') opts.fetch = false
    else if (a === '--library') opts.library = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--limit') opts.limit = Number(argv[++i])
    else if (a === '--delay') opts.delay = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/sample-zhimo-classify.mjs [--library PATH] [--out PATH] [--limit N] [--delay MS] [--no-fetch]')
      process.exit(0)
    } else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

// ── 只读遍历：叶子目录 = 含文件的目录 ────────────────────────────────
const BIG_KINDS = ['模型', '材质', 'HDRI']

async function listLeafDirs(root) {
  const out = []
  async function walk(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = entries.filter((e) => e.isFile())
    if (files.length > 0) {
      out.push({ dir, rel, fileCount: files.length, fileNames: files.map((f) => f.name) })
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      }
    }
  }
  await walk(root, '')
  return out
}

/**
 * 资产名里没 ID 时，从包内文件名兜（`znzmo-1180221079-1.skp` / `xxxID_1166965084.jpg`）。
 * 取**出现次数最多**的 ID；并列时取最右。返回 `{ id, source, candidates }`。
 */
function idOfAsset(name, fileNames) {
  const fromName = zhimoIdFromText(name)
  if (fromName) return { id: fromName, source: 'name', candidates: [fromName] }
  const counts = new Map()
  for (const f of fileNames) {
    const id = zhimoIdFromText(f)
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  if (counts.size === 0) return { id: null, source: null, candidates: [] }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return { id: sorted[0][0], source: 'file', candidates: sorted.map(([id]) => id) }
}

// ── 站方详情页 ──────────────────────────────────────────────────────
const DETAIL_URL = (id) => `https://su.znzmo.com/sumoxing/${id}.html`

async function fetchStation(id) {
  const res = await fetch(DETAIL_URL(id), {
    redirect: 'follow',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    }
  })
  const html = await res.text()
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return { ok: false, reason: `no __NEXT_DATA__ (HTTP ${res.status}, ${html.length}B)` }
  let json
  try {
    json = JSON.parse(m[1])
  } catch (e) {
    return { ok: false, reason: `__NEXT_DATA__ JSON parse failed: ${e.message}` }
  }
  const pp = json?.props?.pageProps ?? {}
  const resObj = pp.res ?? {}
  const classifyBaseName =
    typeof resObj.classifyBaseName === 'string' ? resObj.classifyBaseName.trim() : ''
  const path = Array.isArray(pp.breadcrumb_data)
    ? pp.breadcrumb_data.map((x) => String(x?.showName ?? '').trim()).filter(Boolean)
    : []
  if (!classifyBaseName) {
    return { ok: false, reason: 'detail page has no classifyBaseName', path, httpStatus: res.status }
  }
  return {
    ok: true,
    classifyBaseName,
    path,
    title: typeof resObj.title === 'string' ? resObj.title : null,
    type: resObj.type ?? null,
    channel: pp.channel ?? null,
    httpStatus: res.status
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv)
  const root = resolve(opts.library)
  const outPath = resolve(opts.out)

  const leaves = []
  for (const kind of BIG_KINDS) {
    const abs = join(root, kind)
    try {
      const s = await stat(abs)
      if (!s.isDirectory()) continue
    } catch {
      console.warn(`跳过不存在的大类目录: ${kind}`)
      continue
    }
    const subs = await listLeafDirs(abs)
    for (const s of subs) leaves.push({ kind, ...s })
  }

  const items = leaves.map((l) => {
    const parts = l.rel.split('/')
    const name = parts[parts.length - 1] ?? basename(l.dir)
    const idInfo = idOfAsset(name, l.fileNames)
    return {
      kind: l.kind,
      localCategory1: parts[0] ?? '',
      localCategory2: parts[1] ?? '',
      name,
      relPath: `${l.kind}/${l.rel}`,
      fileCount: l.fileCount,
      zhimoId: idInfo.id,
      zhimoIdSource: idInfo.source,
      zhimoIdCandidates: idInfo.candidates,
      station: null,
      stationError: null
    }
  })

  // 去重（同名同分类只留一条；真实库里存在 `现代壁灯` / `现代壁灯-2` 这类副本，保留，不合并）
  const withId = items.filter((i) => i.zhimoId)
  console.log(`叶子资产 ${items.length} 条；含知末 ID ${withId.length} 条`)

  let fetched = 0
  if (opts.fetch) {
    const targets = withId.slice(0, opts.limit)
    for (const it of targets) {
      try {
        const st = await fetchStation(it.zhimoId)
        if (st.ok) {
          it.station = {
            classifyBaseName: st.classifyBaseName,
            path: st.path,
            title: st.title,
            type: st.type,
            channel: st.channel
          }
          fetched++
        } else {
          it.stationError = st.reason
        }
      } catch (e) {
        it.stationError = `fetch failed: ${e.message}`
      }
      process.stdout.write(`\r站方详情 ${fetched}/${targets.length}  `)
      await sleep(opts.delay)
    }
    process.stdout.write('\n')
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    library: root,
    note:
      '只读采样。station = 站方详情页 __NEXT_DATA__.props.pageProps.res.classifyBaseName + breadcrumb_data；' +
      'stationError 非空 = 该条读不到站方分类（无 ID / 详情页无该字段 / 抓取失败）。',
    totals: {
      leafAssets: items.length,
      withZhimoId: withId.length,
      stationFetched: fetched,
      stationMissing: items.length - fetched
    },
    items
  }

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`写出 ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
