/// <reference lib="dom" />
/**
 * **2026-10 回归**：保存封面把「透明球图」顶成「有底的封面缩略图」。
 *
 * 用户原话：「材质球渲染完成以后，显示上面现在不是无底的 PNG 了，它是有底的。」
 * 实测产物（`%APPDATA%/idbox/thumbs`）：
 * - `c6fefc91-…-8cd965b3.jpg` 480×480 **不透明 JPEG**（= 该资产 cover 的缩略图，salt 与
 *   `thumbFileSalt(coverAbs, st)` 逐一匹配）；
 * - 同 id 的透明球图 `c6fefc91-…-<ballHash>.png` **一个都没有**。
 *
 * 根因（本文件锁死的就是这一条）：
 * 1. `commitCover` → `regenThumbSweep` 旧实现无条件 `deleteThumb(id)`，它是**按 id 通配全删**
 *    （`shared/thumb.ts:isThumbOf`），会把同 id 的球图 `<id>-<hash>.png` 一起删掉
 *    ——`tests/ballCache.test.ts` 的「对照」用例本来就把这条特性写明；
 * 2. 紧接着 `commitCover` 把 `thumbPath` 写成新的封面缩略图（不透明）→ 卡片出现方形底色；
 * 3. 球队列的 `ballAttempted` 让本会话不再重渲 → 只有重启才自愈。
 *
 * 修复口径（产品拍板）：
 * - 球图适用的资产（`material` / `texture`）**永远**指向透明 PNG；
 * - 保存封面只允许精确删「上一张封面缩略图」，球图一个字节都不碰；
 * - 保存完**不需要重启**：若此前还没渲过球图，提交后立刻补渲一次。
 *
 * 走的是 store 的真实 action 路径（不抽副本），只有 WebGL 那一步被桩掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Asset, SaveBallThumbPayload } from '../src/shared/types'
import type { ModVaultApi } from '../src/preload/index'
import { ballThumbName } from '../src/shared/ballParams'

// ── 球图渲染桩：node 里没有 WebGL，只桩「渲出一帧 PNG」这一步 ──────────────
// ⚠️ 名字必须与 store 实际调用一致：球图走 renderBallToPng（透明 PNG）
const renderMock = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/components/MaterialBall', () => ({ renderBallToPng: renderMock }))

// ── node 环境缺 FileReader（Blob 有）：最小 shim，给 store 的 blobToBase64 用 ──
class FileReaderShim {
  result: string | null = null
  error: unknown = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob): void {
    void Promise.resolve()
      .then(async () => {
        const buf = new Uint8Array(await blob.arrayBuffer())
        this.result = 'data:image/png;base64,' + Buffer.from(buf).toString('base64')
        this.onload?.()
      })
      .catch((e: unknown) => {
        this.error = e
        this.onerror?.()
      })
  }
}
;(globalThis as unknown as { FileReader: unknown }).FileReader = FileReaderShim

// ── thumbs 目录（store 里所有缩略图读写都过 IPC → 这里由桩落到 tmp） ──────
let thumbsRoot = ''

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

async function writeThumb(name: string, body = 'x'): Promise<void> {
  await fs.mkdir(thumbsRoot, { recursive: true })
  await fs.writeFile(path.join(thumbsRoot, name), Buffer.from(body))
}

// ── IPC 边界桩（只实现被断言到的那几条） ────────────────────────────────
const modvault = {
  ensureThumb: vi.fn(async (_id: string, _coverAbs: string | null) => null as string | null),
  deleteThumb: vi.fn(async () => 0),
  /** 精确删单张：真实实现见 `main/thumb.ts:deleteOneThumb`，这里等价落盘删除 */
  deleteOneThumb: vi.fn(async (_id: string, name: string) => {
    await fs.rm(path.join(thumbsRoot, name), { force: true })
    return true
  }),
  saveBallThumb: vi.fn(async (payload: SaveBallThumbPayload) => {
    const name = ballThumbName(payload.assetId, payload.slots ?? {}, payload.params)
    await writeThumb(name, 'png')
    return name
  }),
  setCoverImage: vi.fn(async () => ({ rel: 'albedo.cover.jpg', size: 500 })),
  pruneThumbs: vi.fn(async () => 0)
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

// ── Dexie 桩（store 只在 action 执行期访问 db.assets） ────────────────────
const { db } = await import('../src/renderer/db')
const putCalls: Asset[] = []
const fakeTable = {
  put: vi.fn(async (a: Asset) => {
    putCalls.push(a)
    return a.id
  })
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ──────────────────────────────────────────────────────────────
const ID = 'c6fefc91-91ea-4a23-b7a8-674083e1cc00'
const SLOTS = { albedo: 'vh1sbjl_2K_Albedo.jpg', normal: 'vh1sbjl_2K_Normal.jpg' }
const BALL = ballThumbName(ID, SLOTS)

/** 与真实缺陷资产同形：「贴图」类 + 两张 PBR 图 + coverSource 不是 named */
function textureAsset(over: Partial<Asset> = {}): Asset {
  return {
    id: ID,
    name: '复古侘寂仿古砖_绿色复古砖ID_1187280434',
    kind: 'texture',
    source: '知末网',
    folder: 'E:\\ModVault\\Library\\材质\\砖材\\仿古砖\\复古侘寂仿古砖_绿色复古砖ID_1187280434',
    relFolder: '材质/砖材/仿古砖/复古侘寂仿古砖_绿色复古砖ID_1187280434',
    cover: 'vh1sbjl_2K_Albedo.jpg',
    coverSource: 'root',
    files: [
      { rel: 'vh1sbjl_2K_Albedo.jpg', name: 'vh1sbjl_2K_Albedo.jpg', ext: 'jpg', size: 10, kind: 'texture' },
      { rel: 'vh1sbjl_2K_Normal.jpg', name: 'vh1sbjl_2K_Normal.jpg', ext: 'jpg', size: 10, kind: 'texture' }
    ],
    size: 20,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: 'texture:复古侘寂仿古砖',
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '砖材',
    category2: '仿古砖',
    styles: [],
    ...over
  }
}

/** 模型资产：不该有球图（DEF-08），必须继续走旧的通配删路径 */
function modelAsset(): Asset {
  return {
    ...textureAsset({ id: '11111111-2222-4333-8444-555555555555', name: '侘寂壁灯' }),
    kind: 'model',
    cover: '预览图.jpg',
    files: [
      { rel: '预览图.jpg', name: '预览图.jpg', ext: 'jpg', size: 10, kind: 'texture' },
      { rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }
    ],
    size: 30
  }
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}

beforeEach(async () => {
  thumbsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-ballcover-'))
  putCalls.length = 0
  for (const fn of Object.values(modvault)) fn.mockClear()
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.deleteOneThumb.mockImplementation(async (_id: string, name: string) => {
    await fs.rm(path.join(thumbsRoot, name), { force: true })
    return true
  })
  modvault.saveBallThumb.mockImplementation(async (payload: SaveBallThumbPayload) => {
    const name = ballThumbName(payload.assetId, payload.slots ?? {}, payload.params)
    await writeThumb(name, 'png')
    return name
  })
  modvault.setCoverImage.mockResolvedValue({ rel: 'albedo.cover.jpg', size: 500 })
  renderMock.mockReset()
  renderMock.mockImplementation(async () => new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])]))
})

afterEach(async () => {
  if (thumbsRoot) await fs.rm(thumbsRoot, { recursive: true, force: true }).catch(() => {})
  thumbsRoot = ''
  useVault.setState({ assets: [], selectedId: null })
})

describe('封面与球图的优先级（2026-10-23 契约变更）', () => {
  it('手动保存封面 → 球图**让位**给封面缩略图（旧契约"球图不许被顶掉"已作废）', async () => {
    // 契约演进说明（勿删这段历史）：
    // · 0.6.9 的原始缺陷是「通配删把球图删了、补回来的是封面 JPEG」，当时的修法是
    //   "球图 fresh 时保存封面 → 仍保留球图"；
    // · 2026-10-23 用户反馈「我在更换封面里选了包内 preview 图，卡片还是球」——
    //   说明那条修法**过度**了：用户显式指定封面时，球图必须让位。
    //   现在的判据在 `ballThumbTarget()`（`coverSource='manual'` 不再渲球），
    //   并且 `commitCover` 会把**即将落库的来源**传给 `regenThumbSweep`（否则判定读到旧值）。
    const coverThumb = `${ID}-8cd965b3.jpg`
    modvault.ensureThumb.mockResolvedValue(coverThumb)
    await writeThumb(BALL, 'ball-png')

    const a = textureAsset({ thumbPath: BALL, thumbStatus: 'ready' })
    useVault.setState({ assets: [a], selectedId: a.id })

    const ok = await useVault.getState().setCoverFromImage(a.id, {
      source: 'clipboard',
      data: 'x'
    })
    expect(ok).toBe(true)

    const saved = putCalls.at(-1)!
    // ① 卡片改指封面缩略图（用户看得见自己选的那张）
    expect(saved.thumbPath).toBe(coverThumb)
    expect(saved.thumbStatus).toBe('ready')
    // ② 该资产已无球图要保 → 走通配删（清掉旧球图文件，不留垃圾）
    expect(modvault.deleteThumb).toHaveBeenCalledWith(ID)
    // ③ 没有"当前缩略图仍是球图"这回事了
    expect(saved.thumbPath).not.toBe(BALL)
    // ④ 不触发额外的球图重渲
    expect(renderMock).not.toHaveBeenCalled()
    // ⑤ 封面本身照常落库
    expect(saved.cover).toBe('albedo.cover.jpg')
    expect(saved.coverSource).toBe('manual')
  })

  it('手动指定封面后 → 缩略图换成封面缩略图、**不再**补渲球图（2026-10-23 新契约）', async () => {
    const oldCoverThumb = `${ID}-deadbeef.jpg`
    const newCoverThumb = `${ID}-8cd965b3.jpg`
    modvault.ensureThumb.mockResolvedValue(newCoverThumb)
    await writeThumb(oldCoverThumb, 'old-cover')
    // 真实 `ensureThumb` 会把新缩略图写进 thumbs 目录；桩这里等价补上，便于验证"新的留下"
    await writeThumb(newCoverThumb, 'new-cover')

    // 真实缺陷现场的形态：thumbPath 是不透明的封面缩略图，磁盘上没有球图
    const a = textureAsset({ thumbPath: oldCoverThumb, thumbStatus: 'ready' })
    useVault.setState({ assets: [a], selectedId: a.id })

    const ok = await useVault.getState().setCoverFromImage(a.id, {
      source: 'clipboard',
      data: 'x'
    })
    expect(ok).toBe(true)

    // ★ 契约变更（2026-10-23 用户反馈「换了封面卡片还是球」）：`setCoverFromImage` 写的是
    // `coverSource='manual'` → `ballThumbTarget()` 返回 null → **不该再渲球**，
    // 缩略图必须是封面缩略图。此前这里断言"回到球图"，正是那条 bug 的另一种表现。
    await waitFor(() => useVault.getState().assets[0]?.thumbPath === newCoverThumb)
    expect(useVault.getState().assets[0]?.thumbPath).toBe(newCoverThumb)
    expect(useVault.getState().assets[0]?.thumbStatus).toBe('ready')
    expect(renderMock).not.toHaveBeenCalled()
    // 新封面缩略图留在磁盘上（旧的那张由通配删负责，桩不落盘所以这里不断言文件）
    expect(await exists(path.join(thumbsRoot, newCoverThumb))).toBe(true)
    // 非球图资产走**通配删**（与模型同一条分支：该资产已经没有球图要保）
    expect(modvault.deleteThumb).toHaveBeenCalledWith(ID)
    expect(modvault.deleteOneThumb).not.toHaveBeenCalled()
  })

  it('手动封面 + 封面缩略图生成失败 → 退化为占位，**绝不**把 thumbPath 留在球图上', async () => {
    modvault.ensureThumb.mockResolvedValue(null)
    await writeThumb(BALL, 'ball-png')

    const a = textureAsset({ thumbPath: BALL, thumbStatus: 'ready' })
    useVault.setState({ assets: [a], selectedId: a.id })
    await useVault.getState().setCoverFromImage(a.id, { source: 'clipboard', data: 'x' })

    const after = useVault.getState().assets[0]
    // 生成失败发生在任何删除之前 → 不动磁盘（旧球图文件成为孤儿，由 pruneThumbs 回收）
    expect(modvault.deleteThumb).not.toHaveBeenCalled()
    expect(modvault.deleteOneThumb).not.toHaveBeenCalled()
    expect(await exists(path.join(thumbsRoot, BALL))).toBe(true)
    // ★ 关键：不能再宣称"当前缩略图是球图"——那正是用户投诉的现象（换了封面还显示球）
    expect(after?.thumbPath).not.toBe(BALL)
    expect(after?.thumbStatus).not.toBe('ready')
  })

  it('模型资产（不该有球图）照旧走通配删 —— 守卫不是无差别跳过', async () => {
    const m = modelAsset()
    const coverThumb = `${m.id}-cafe0001.jpg`
    modvault.ensureThumb.mockResolvedValue(coverThumb)
    useVault.setState({ assets: [{ ...m, thumbPath: 'legacy-thumb.jpg', thumbStatus: 'ready' }] })

    await useVault.getState().setCoverFromImage(m.id, { source: 'clipboard', data: 'x' })

    expect(modvault.deleteThumb).toHaveBeenCalledWith(m.id)
    expect(modvault.deleteOneThumb).not.toHaveBeenCalled()
    expect(putCalls.at(-1)!.thumbPath).toBe(coverThumb)
    // 模型资产永远不会被塞进球队列
    expect(renderMock).not.toHaveBeenCalled()
  })
})
