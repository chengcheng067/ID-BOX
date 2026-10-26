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
 *   node scripts/sample-zhimo-classify.mjs --caizhi 40           # 材质频道（caizhi）站方补采样，见下
 *
 * `--caizhi N`（2026-10-26 新增，**默认关闭，不影响既有口径**）：
 * 用户库里的「材质」资产全部来自贴图（tietu）频道，`docs/18` 的材质二级（caizhi）**0 条样本**。
 * 该模式从站方材质频道的分类页出发（`https://tietu.znzmo.com/caizhi/sl.html` 的
 * `__NEXT_DATA__.props.pageProps.categoryAll` 拿到全部一级/二级 + slug），
 * 按一级分组轮转进二级页 → 取商品详情链接 → 读 `res.classifyBaseName` + `breadcrumb_data`。
 * 输出结构里带 `stationLevel1/stationLevel2`（来自分类页），**只用于标注"从哪进来"**；
 * 可与详情页的 `classifyBaseName` 交叉核对。采样结果**不写库**，只写到 `--out`。
 *
 * ⚠️ **铁律：分类页列表混推荐商品，分类只能信详情页，不能信入口页。**
 * 2026-10-26 实测：40 条 caizhi 样本里有 8 条的详情 `classifyBaseName` ≠ 它所在二级页
 * （`墙纸`页出`墙砖`、`人物皮肤`页出`瓷砖/路面`、`蔬菜`页出`压纹皮革/涂料`、`书籍报刊`页出`玻璃屏幕/石材`）。
 * 因此不要把 `stationLevel1/stationLevel2` 当分类真值，一律以详情页为准。
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
    fetch: true,
    caizhi: 0,
    perCategory: 2,
    kinds: null
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-fetch') opts.fetch = false
    else if (a === '--library') opts.library = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--limit') opts.limit = Number(argv[++i])
    else if (a === '--delay') opts.delay = Number(argv[++i])
    else if (a === '--caizhi') opts.caizhi = Number(argv[++i])
    else if (a === '--per-category') opts.perCategory = Number(argv[++i])
    else if (a === '--kinds') opts.kinds = String(argv[++i]).split(/[,，\s]+/).filter(Boolean)
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法: node scripts/sample-zhimo-classify.mjs [--library PATH] [--out PATH] [--limit N] [--delay MS] [--no-fetch] [--kinds 模型,材质,HDRI]\n' +
          '      node scripts/sample-zhimo-classify.mjs --caizhi N [--per-category K] [--out PATH] [--delay MS]'
      )
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

// ── 材质频道（caizhi）站方补采样 ────────────────────────────────────
const CAIZHI_INDEX_URL = 'https://tietu.znzmo.com/caizhi/sl.html'
const CAIZHI_HOST = 'https://tietu.znzmo.com'

async function getHtml(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    }
  })
  return { status: res.status, finalUrl: res.url, html: await res.text() }
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

/**
 * 读材质频道分类树：`categoryAll` 里有全部一级 + 二级 + slug（`cname`）。
 * 返回按一级分组的二级列表，用于"每个一级轮转取一条二级"的均匀采样。
 */
function readCaizhiTree(html) {
  const json = nextData(html)
  const all = json?.props?.pageProps?.categoryAll
  if (!Array.isArray(all)) return []
  return all
    .map((g) => ({
      level1: String(g?.name ?? '').trim(),
      level2s: (Array.isArray(g?.secondCategoryTermList) ? g.secondCategoryTermList : [])
        .map((s) => ({ level2: String(s?.showName ?? '').trim(), cname: String(s?.cname ?? '').trim() }))
        .filter((s) => s.level2 && s.cname)
    }))
    .filter((g) => g.level1 && g.level2s.length > 0)
}

async function sampleCaizhi({ target, perCategory, delay }) {
  const index = await getHtml(CAIZHI_INDEX_URL)
  const groups = readCaizhiTree(index.html)
  if (groups.length === 0) throw new Error('材质频道分类树解析为空（categoryAll 缺失或结构变更）')
  await sleep(delay)

  // 按"第 n 个二级"轮转，保证每个一级至少被覆盖一次，再进入第二圈
  const picks = []
  const maxRounds = Math.max(...groups.map((g) => g.level2s.length))
  for (let round = 0; round < maxRounds; round++) {
    for (const g of groups) {
      const s = g.level2s[round]
      if (s) picks.push({ level1: g.level1, level2: s.level2, cname: s.cname })
    }
  }

  const items = []
  const seen = new Set()
  let pagesVisited = 0
  for (const pick of picks) {
    if (items.length >= target) break
    const page = await getHtml(`${CAIZHI_HOST}/caizhi/${pick.cname}.html`)
    pagesVisited++
    await sleep(delay)
    const ids = [
      ...new Set([...page.html.matchAll(/\/tietu\/(\d{6,})\.html/g)].map((m) => m[1]))
    ].filter((id) => !seen.has(id)).slice(0, perCategory)
    for (const id of ids) {
      if (items.length >= target) break
      seen.add(id)
      let detail = null
      let error = null
      try {
        const d = await getHtml(`${CAIZHI_HOST}/tietu/${id}.html`)
        const json = nextData(d.html)
        const pp = json?.props?.pageProps ?? {}
        const name =
          typeof pp?.res?.classifyBaseName === 'string' ? pp.res.classifyBaseName.trim() : ''
        const path = Array.isArray(pp?.breadcrumb_data)
          ? pp.breadcrumb_data.map((x) => String(x?.showName ?? '').trim()).filter(Boolean)
          : []
        if (name) {
          detail = {
            classifyBaseName: name,
            path,
            title: typeof pp?.res?.title === 'string' ? pp.res.title : null,
            finalUrl: d.finalUrl
          }
        } else {
          error = 'detail page has no classifyBaseName'
        }
      } catch (e) {
        error = `fetch failed: ${e.message}`
      }
      items.push({
        id,
        stationLevel1: pick.level1,
        stationLevel2: pick.level2,
        classificationPage: `${CAIZHI_HOST}/caizhi/${pick.cname}.html`,
        station: detail,
        stationError: error
      })
      await sleep(delay)
    }
  }
  return { groups: groups.length, picks: picks.length, pagesVisited, items }
}

/** 材质频道采样模式的主流程（与用户库采样完全分开，互不影响默认口径） */
async function mainCaizhi(opts) {
  const outPath = resolve(opts.out)
  const res = await sampleCaizhi({
    target: opts.caizhi,
    perCategory: opts.perCategory,
    delay: opts.delay
  })
  const readable = res.items.filter((i) => i.station).length
  const payload = {
    generatedAt: new Date().toISOString(),
    source: '站方材质频道（caizhi）实测——非用户库样本，与 docs/28 §3 的模型/贴图样本分开统计',
    indexUrl: CAIZHI_INDEX_URL,
    totals: {
      level1Groups: res.groups,
      level2Picks: res.picks,
      pagesVisited: res.pagesVisited,
      detailRequested: res.items.length,
      readableWithClassifyBaseName: readable
    },
    items: res.items
  }
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(
    `材质频道采样：访问二级页 ${res.pagesVisited} 个，详情 ${res.items.length} 条，读到 classifyBaseName ${readable} 条`
  )
  console.log(`写出 ${outPath}`)
}

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv)
  if (opts.caizhi > 0) {
    await mainCaizhi(opts)
    return
  }
  const root = resolve(opts.library)
  const outPath = resolve(opts.out)

  const leaves = []
  const wantKinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null
  for (const kind of BIG_KINDS) {
    if (wantKinds && !wantKinds.has(kind)) continue
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
    kindsFilter: opts.kinds ?? null,
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
