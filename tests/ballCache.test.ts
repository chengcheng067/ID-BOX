/// <reference lib="dom" />
/**
 * 材质球缓存的**跨层契约**测试（docs/12 §6.4，T04）。
 *
 * 覆盖四组：
 * ① `deleteOneThumb` 的三道校验（§4.1）——为什么不能复用按 id 通配全删的 `deleteThumb`；
 * ② 「先建新、再删旧」时序（§4.2）——走 store 的真实代码路径，不是抽出来的副本；
 * ③ `ballThumbIsFresh` 在参数变化后翻转 false（本次缺陷的直接回归）；
 * ④ `ensureMissingThumbs` 不会把材质球资产抢去生成封面缩略图（§4.3 竞态）。
 *
 * 两个测试环境约束（实测，写在这里免得下一个人踩）：
 * - `electron` 是 CJS，纯 node ESM 下 `import { nativeImage } from 'electron'` 直接抛
 *   `SyntaxError: Named export 'nativeImage' not found` → 必须整体 `vi.mock('electron')`，
 *   且 `app.getPath('userData')` 要指向 tmp 目录（`main/thumb.ts` 的 `thumbsDir()` 靠它）。
 * - vitest `environment: 'node'` 下 `typeof FileReader === 'undefined'`（`Blob` 存在），
 *   所以 `blobToBase64` 需要测试环境补一个最小 shim；这不是被测代码的替身，只是环境补齐。
 *
 * `window.modvault` 的类型沿用 `preload/index.ts` 的 `ModVaultApi`（与
 * `tests/storeFlow.test.ts` 同一口径），桩是**部分实现**——断言只用到被桩的那几条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Asset, BallSlots, SaveBallThumbPayload } from '../src/shared/types'
import type { ModVaultApi } from '../src/preload/index'
import { ballThumbName, type BallParamScales } from '../src/shared/ballParams'
import { deleteOneThumb, deleteThumb } from '../src/main/thumb'

// ── electron 桩（必须在 import main/thumb 之前就位：vi.mock 会被提升到文件顶部） ──
// ⚠️ `app.getPath('userData')` 必须返回 **userData 根**，不是 thumbs 目录：
// `main/paths.ts:21` 的 `thumbsDir()` 是 `path.join(userDataDir(), 'thumbs')`。
// 若这里直接返回 thumbs 目录，被测代码读写 `<root>/thumbs` 而测试把文件写在 `<root>`
// → `deleteOneThumb` 校验通过、`fs.rm(force:true)` 静默删到另一个目录 → exists() 断言全反。
const env = vi.hoisted(() => ({ userDataRoot: '', thumbsRoot: '' }))
vi.mock('electron', () => ({
  nativeImage: { createFromPath: () => null },
  app: { getPath: () => env.userDataRoot }
}))

// ── three.js 材质球组件桩：无头环境跑不了 WebGL，只桩「渲染产出 Blob」这一步 ──
// ⚠️ 名字必须与 store 的实际调用一致：球图走 renderBallToPng（透明 PNG）
const renderMock = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/components/MaterialBall', () => ({ renderBallToPng: renderMock }))

// ── node 环境缺 FileReader（Blob 有）：最小 shim，仅供 store 的 blobToBase64 用 ──
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

// ── IPC 边界桩（store 只用到这几条；其余走 ModVaultApi 的类型口径） ──
const modvault = {
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async (id: string, coverAbs: string | null) => null),
  deleteThumb: vi.fn(async () => 0),
  deleteOneThumb: vi.fn(async (id: string, name: string) => deleteOneThumb(id, name)),
  saveBallThumb: vi.fn(async (payload: SaveBallThumbPayload) => {
    const name = ballThumbName(payload.assetId, payload.slots ?? {}, payload.params)
    await fs.mkdir(env.thumbsRoot, { recursive: true })
    await fs.writeFile(path.join(env.thumbsRoot, name), Buffer.from('jpeg'))
    return name
  })
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

// ── Dexie 桩（store 只在 action 执行期访问 db.assets） ──
const { db } = await import('../src/renderer/db')
const putCalls: Asset[] = []
const fakeTable = {
  put: vi.fn(async (a: Asset) => {
    putCalls.push(a)
    return a.id
  })
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { useVault, ballThumbIsFresh, ensureMissingThumbs } = await import(
  '../src/renderer/store'
)

// ── 夹具 ───────────────────────────────────────────────────────
const ID = 'a1b2c3d4-1111-4222-8333-444455556666'
const SLOTS: BallSlots = { albedo: 'vh1sbjl_2K_Albedo.jpg', normal: 'vh1sbjl_2K_Normal.jpg' }
const DEFAULTS: BallParamScales = { roughness: 1, bump: 1, uv: 1, light: 1, metal: 0, alpha: 1 }
/** 调过参的一组（golden：340ed45f） */
const TUNED: BallParamScales = { roughness: 1.5, bump: 1, uv: 0.5, light: 1, metal: 0, alpha: 1 }

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 轮询等待条件成立。
 *
 * 默认 8 秒（原 3 秒）：本用例要等 store 的球图队列跑完，而队列是**串行 + 真实计时**；
 * 并行跑全量测试（CI / 多 worker 争 CPU）时 3 秒会偶发超时，制造"随机红"，
 * 削弱"全绿"的可信度。轮询间隔保持 10ms 不变（条件满足即刻返回，不会拖慢）。
 */
async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}

let seq = 0

/** 材质球资产（必须有 albedo 才会进球队列，`store.ts` 的 `ballSlotsOf`） */
function ballAsset(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `材质${n}`,
    kind: 'material',
    source: 'AmbientCG',
    folder: `E:\\ModVault\\Library\\贴图\\未分类\\未分类\\材质${n}`,
    relFolder: '贴图/未分类/未分类/材质' + n,
    cover: 'vh1sbjl_2K_Albedo.jpg',
    // ⚠️ 不能是 'named'：`renderBallThumbFor` 对官方渲染图优先早退（不渲球）
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
    dedupeKey: `material:材质${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...over
  }
}

beforeEach(async () => {
  env.userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-cache-'))
  // 与 `main/paths.ts:21` 的 thumbsDir() 同口径：被测代码算出的落盘目录必须就是这里
  env.thumbsRoot = path.join(env.userDataRoot, 'thumbs')
  putCalls.length = 0
  renderMock.mockReset()
  renderMock.mockImplementation(async () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]))
  for (const fn of Object.values(modvault)) fn.mockReset()
  modvault.pruneThumbs.mockImplementation(async () => 0)
  modvault.ensureThumb.mockImplementation(async () => null)
  modvault.deleteThumb.mockImplementation(async () => 0)
  modvault.deleteOneThumb.mockImplementation(async (id: string, name: string) =>
    deleteOneThumb(id, name)
  )
  modvault.saveBallThumb.mockImplementation(async (payload: SaveBallThumbPayload) => {
    const name = ballThumbName(payload.assetId, payload.slots ?? {}, payload.params)
    await fs.mkdir(env.thumbsRoot, { recursive: true })
    await fs.writeFile(path.join(env.thumbsRoot, name), Buffer.from('png'))
    return name
  })
})

afterEach(async () => {
  if (env.userDataRoot)
    await fs.rm(env.userDataRoot, { recursive: true, force: true }).catch(() => {})
  env.userDataRoot = ''
  env.thumbsRoot = ''
  useVault.setState({ assets: [], selectedId: null })
})

// ── ① deleteOneThumb 三道校验（docs/12 §4.1） ──────────────────
describe('main/thumb · deleteOneThumb 三道校验（§4.1，缺一不可）', () => {
  it('① 不是缩略图文件名 → false，且**不删任何文件**', async () => {
    const dir = env.thumbsRoot
    const name = ballThumbName(ID, SLOTS)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, name), Buffer.from('x'))
    await fs.writeFile(path.join(dir, 'not-a-thumb.jpg'), Buffer.from('y'))

    expect(await deleteOneThumb(ID, 'not-a-thumb.jpg')).toBe(false)
    // 无 `-` 分隔 → parseThumbFileName 返回 null（正则 `^(.+)-([0-9a-f]+)\.(jpg|png)$`）
    expect(await exists(path.join(dir, 'not-a-thumb.jpg'))).toBe(true)
    expect(await exists(path.join(dir, name))).toBe(true)
  })

  it('② 文件名可解析但 id 不匹配（跨资产）→ false，别人的缓存不受影响', async () => {
    const dir = env.thumbsRoot
    const other = 'ffffffff-0000-4000-8000-000000000000'
    const otherName = ballThumbName(other, SLOTS)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, otherName), Buffer.from('x'))

    expect(await deleteOneThumb(ID, otherName)).toBe(false)
    expect(await exists(path.join(dir, otherName))).toBe(true)
  })

  it('③ 文件名含路径分隔符（真穿越）→ 第四道 `path.basename` 拦下，目录外文件不受影响', async () => {
    const parent = path.dirname(env.thumbsRoot)
    await fs.mkdir(env.thumbsRoot, { recursive: true })
    // parseThumbFileName 的 `(.+)` 会吃掉分隔符：id = '../evil'、salt 合法 →
    // 若只靠 isWithinRoot（字符串前缀判定），path.join(dir, name) 解析到目录外仍判 true。
    const escapeName = '../evil-811c9dc5.jpg'
    await fs.writeFile(path.join(parent, 'evil-811c9dc5.jpg'), Buffer.from('x'))

    expect(await deleteOneThumb('../evil', escapeName)).toBe(false)
    expect(await exists(path.join(parent, 'evil-811c9dc5.jpg'))).toBe(true)

    // 绝对形态同样被拦（第四道先于落盘校验生效）
    expect(await deleteOneThumb('/etc/passwd', '/etc/passwd-811c9dc5.jpg')).toBe(false)
  })

  it('三道全过 → true，只删这一张（与 `ballThumb.ts` 的 isWithinRoot 同一道防线）', async () => {
    const dir = env.thumbsRoot
    const name = ballThumbName(ID, SLOTS)
    const otherName = ballThumbName(ID, { albedo: 'other.jpg' })
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, name), Buffer.from('x'))
    await fs.writeFile(path.join(dir, otherName), Buffer.from('y'))

    expect(await deleteOneThumb(ID, name)).toBe(true)
    expect(await exists(path.join(dir, name))).toBe(false)
    expect(await exists(path.join(dir, otherName))).toBe(true)
  })

  it('对照：`deleteThumb(id)` 是通配全删 —— 这正是必须新开一条通道的原因（§4.1）', async () => {
    const dir = env.thumbsRoot
    const ballName = ballThumbName(ID, SLOTS)
    const coverName = `${ID}-811c9dc5.jpg` // 同一 id 的封面 salt（官方渲染图 / 手动封面）
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, ballName), Buffer.from('x'))
    await fs.writeFile(path.join(dir, coverName), Buffer.from('y'))

    expect(await deleteThumb(ID)).toBe(2) // 全删：球图 + 封面缓存一起没
    expect(await exists(path.join(dir, ballName))).toBe(false)
    expect(await exists(path.join(dir, coverName))).toBe(false)
  })
})

// ── ② 先建新、再删旧（docs/12 §4.2）——走 store 的真实代码路径 ──
describe('store · 先建新再删旧（§4.2，不能反）', () => {
  it('新文件已落盘时旧文件仍在 → 删旧 → 只剩新（网格不闪灰格）', async () => {
    const dir = env.thumbsRoot
    const base = ballAsset({ renderParams: DEFAULTS })
    const oldName = ballThumbName(base.id, SLOTS, DEFAULTS)
    const newName = ballThumbName(base.id, SLOTS, TUNED)
    // ⚠️ 必须带 thumbPath：`persistRenderParams` 只有「旧 thumbPath 确实是球图」才登记
    // `ballStaleNames`（§4.1 场景 ①②）。夹具缺 thumbPath → 不登记 → deleteOneThumb
    // 根本不会被调用，这条时序断言就变成空跑。
    const a: Asset = { ...base, thumbPath: oldName, thumbStatus: 'ready' }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, oldName), Buffer.from('old'))

    const deleteCalls: Array<{ name: string; oldStillOnDisk: boolean }> = []
    modvault.deleteOneThumb.mockImplementation(async (id: string, name: string) => {
      deleteCalls.push({ name, oldStillOnDisk: await exists(path.join(dir, oldName)) })
      return deleteOneThumb(id, name)
    })

    useVault.setState({ assets: [a], selectedId: a.id })
    await useVault.getState().persistRenderParams(a.id, TUNED)
    expect(await waitFor(() => deleteCalls.length > 0)).toBe(true)

    // 时序：删除发生在「新文件已落盘」之后，且此刻旧文件**还在**
    expect(deleteCalls[0]!.name).toBe(oldName)
    expect(deleteCalls[0]!.oldStillOnDisk).toBe(true)
    expect(await exists(path.join(dir, newName))).toBe(true)
    expect(await exists(path.join(dir, oldName))).toBe(false)

    // 状态原子更新：thumbPath 指向新名，thumbStatus 保持 ready（§4.3）
    const saved = putCalls[putCalls.length - 1]!
    expect(saved.renderParams).toEqual(TUNED)
    expect(saved.thumbPath).toBe(newName)
    expect(saved.thumbStatus).toBe('ready')
  })

  it('渲染失败 → **不删旧球图**（登记保留，下次成功才删）', async () => {
    const dir = env.thumbsRoot
    const base = ballAsset({ renderParams: DEFAULTS })
    const oldName = ballThumbName(base.id, SLOTS, DEFAULTS)
    // 同上：必须登记待删才有「不删」可证——缺 thumbPath 时 deleteOneThumb 不会被调用，
    // `not.toHaveBeenCalled()` 会假通过（证明不了守卫）。
    const a: Asset = { ...base, thumbPath: oldName, thumbStatus: 'ready' }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, oldName), Buffer.from('old'))

    useVault.setState({ assets: [a], selectedId: a.id })
    renderMock.mockImplementation(async () => {
      throw new Error('无 GPU / WebGL 上下文创建失败')
    })
    await useVault.getState().persistRenderParams(a.id, TUNED)
    await new Promise((r) => setTimeout(r, 150))

    expect(modvault.deleteOneThumb).not.toHaveBeenCalled()
    expect(await exists(path.join(dir, oldName))).toBe(true)
    // 参数已落库（下次入队用新 hash），但网格此刻仍有图
    const saved = putCalls[putCalls.length - 1]!
    expect(saved.renderParams).toEqual(TUNED)
    expect(saved.thumbPath).toBe(oldName)
    expect(saved.thumbStatus).toBe('ready')
  })

  it('旧 thumbPath 是封面 salt（不是球图）→ 不登记待删（§4.1 场景 ①②）', async () => {
    const dir = env.thumbsRoot
    const coverSalt = `${ID}-811c9dc5.jpg`
    const a = ballAsset({
      id: ID,
      renderParams: DEFAULTS,
      thumbPath: coverSalt,
      thumbStatus: 'ready'
    })
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, coverSalt), Buffer.from('cover'))

    useVault.setState({ assets: [a], selectedId: a.id })
    await useVault.getState().persistRenderParams(a.id, TUNED)
    await new Promise((r) => setTimeout(r, 150))

    expect(modvault.deleteOneThumb).not.toHaveBeenCalled()
    expect(await exists(path.join(dir, coverSalt))).toBe(true)
  })
})

// ── ③ ballThumbIsFresh 在参数变化后翻转 false（本次缺陷的直接回归） ──
describe('store · ballThumbIsFresh 与参数（§3.4 / §6.4）', () => {
  it('未调参（renderParams undefined）→ 既有磁盘缓存仍判 fresh（方案 B 零重渲）', () => {
    // ⚠️ 夹具必须用 `id: ID`：`ballAsset()` 自生成 id，而 thumbPath 是按 ID 算的
    // → 两者必然不等 → fresh 恒 false（根因 B）。
    const a = ballAsset({ id: ID, thumbPath: ballThumbName(ID, SLOTS), thumbStatus: 'ready' })
    expect(ballThumbIsFresh(a)).toBe(true)
    // 显式默认值与「从未调参」必须给出同一个名字（§3.3 最短表示）
    expect(ballThumbName(ID, SLOTS)).toBe(ballThumbName(ID, SLOTS, DEFAULTS))
  })

  it('参数变化后同一 thumbPath → 翻转 false（必须重渲）', async () => {
    const a = ballAsset({
      id: ID,
      renderParams: DEFAULTS,
      thumbPath: ballThumbName(ID, SLOTS),
      thumbStatus: 'ready'
    })
    expect(ballThumbIsFresh(a)).toBe(true)
    useVault.setState({ assets: [a], selectedId: a.id })
    await useVault.getState().persistRenderParams(a.id, TUNED)
    const after = useVault.getState().assets[0]!
    expect(after.renderParams).toEqual(TUNED)
    expect(ballThumbIsFresh(after)).toBe(false)
    expect(after.thumbPath).toBe(ballThumbName(ID, SLOTS)) // 旧名，尚未重渲
  })

  it('DB 存的是规范化值 → 浮点噪声不会让 fresh 判错（§5.2）', async () => {
    const a = ballAsset({
      id: ID,
      renderParams: { roughness: 0.30000000000000004, bump: 1, uv: 1 },
      thumbPath: ballThumbName(ID, SLOTS, { roughness: 0.3, bump: 1, uv: 1 }),
      thumbStatus: 'ready'
    })
    useVault.setState({ assets: [a], selectedId: a.id })
    await useVault.getState().persistRenderParams(a.id, { roughness: 0.3, bump: 1, uv: 1 })
    // 规范化后相等 → 提前 return（防无意义写库 / 重渲）
    expect(putCalls.length).toBe(0)
    expect(ballThumbIsFresh(a)).toBe(true)
  })

  it('缺 albedo 的资产不判 fresh（不值得渲球，退回封面）', () => {
    const a = ballAsset({
      files: [
        {
          rel: 'vh1sbjl_2K_Normal.jpg',
          name: 'vh1sbjl_2K_Normal.jpg',
          ext: 'jpg',
          size: 10,
          kind: 'texture'
        }
      ],
      thumbPath: ballThumbName(ID, { normal: 'vh1sbjl_2K_Normal.jpg' }),
      thumbStatus: 'ready'
    })
    expect(ballThumbIsFresh(a)).toBe(false)
  })
})

// ── ④ §4.3 竞态：ensureMissingThumbs 不抢材质球 ────────────────
describe('store · ensureMissingThumbs 不抢材质球（§4.3 竞态）', () => {
  it('球图 fresh 的材质资产被跳过（不会被封面缩略图盖回去）', async () => {
    const ball = ballAsset({ id: ID, thumbPath: ballThumbName(ID, SLOTS), thumbStatus: 'ready' })
    const plain = ballAsset({ kind: 'model', thumbStatus: 'none' })
    useVault.setState({ assets: [ball, plain], selectedId: null })

    await ensureMissingThumbs()

    // 材质球被守卫跳过；普通资产照常补封面缩略图（证明守卫不是无差别跳过）
    const ids = modvault.ensureThumb.mock.calls.map((c) => c[0])
    expect(ids).not.toContain(ball.id)
    expect(ids).toContain(plain.id)
  })

  it('persistRenderParams 全程不改 thumbStatus → 参数变化后仍不会被抢走', async () => {
    const a = ballAsset({
      id: ID,
      renderParams: DEFAULTS,
      thumbPath: ballThumbName(ID, SLOTS),
      thumbStatus: 'ready'
    })
    useVault.setState({ assets: [a], selectedId: a.id })

    await useVault.getState().persistRenderParams(a.id, TUNED)
    const after = useVault.getState().assets[0]!
    expect(after.thumbStatus).toBe('ready') // ⚠️ 若这里被置非 ready，§4.3 竞态成立
    expect(ballThumbIsFresh(after)).toBe(false)

    await ensureMissingThumbs()
    expect(modvault.ensureThumb).not.toHaveBeenCalled()
    expect(useVault.getState().assets[0]!.thumbStatus).toBe('ready')
  })
})
