/**
 * 缩略图数据救援的**纯逻辑**测试（2026-10-23 rescan 事故）。
 *
 * 这一层刻意不碰 Dexie / electron / 文件系统：`planThumbRescue` 只看
 * 「记录 + `thumb:list` 的返回」，`applyThumbRescue` 的副作用全部经依赖注入，
 * 所以可以在 node 环境里把"多候选取最新 / 严格前缀 / 空跑保护 / 失败不中断"
 * 这些最容易写错的规则逐条钉死。
 *
 * 另一组是本轮事故的**字面量证据**：用固定槽位 fixture 复算
 * `5e4c3050-…-e94039c0.png`，证明 `uv = 3.10` + 其余默认 就是那张图的参数。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RENDER_PARAMS_RESTORE,
  RESCUE_PREFER,
  THUMB_RESCUE_LIMIT,
  THUMB_RESCUE_SNAPSHOT_PREFIX,
  applyThumbRescue,
  planRenderParamsRestore,
  planThumbRescue,
  restoreParamsFor,
  type ThumbRescueAsset,
  type ThumbRescueDeps
} from '../src/renderer/logic/thumbRescue'
import { ballThumbName, fnv1a, paramsKey, RENDER_REV } from '../src/shared/ballParams'
import type { ThumbFileEntry } from '../src/shared/types'

const ID_A = 'aaaaaaaa-1111-4222-8333-444455556666'
const ID_B = 'bbbbbbbb-1111-4222-8333-444455556666'

/** 造一个 `thumb:list` 条目；hash 必须是 8 位十六进制（`parseThumbFileName` 的要求） */
function file(id: string, hash: string, ext: 'png' | 'jpg' = 'png', mtimeMs = 1000, size = 4096): ThumbFileEntry {
  return { name: `${id}-${hash}.${ext}`, size, mtimeMs }
}

/** 缺 thumbPath 的记录（救援对象） */
function needRescue(over: Partial<ThumbRescueAsset> = {}): ThumbRescueAsset {
  return { id: ID_A, thumbStatus: 'none', ...over }
}

describe('planThumbRescue · 匹配规则', () => {
  it('按 id **完全相等**匹配（`abc` 不许匹配 `abcd-1234abcd.png`）', () => {
    const plan = planThumbRescue([needRescue({ id: 'abc' })], [file('abcd', '1234abcd')])
    expect(plan).toEqual([])
  })

  it('同一 id 多个候选 → 取 mtimeMs 最大', () => {
    const plan = planThumbRescue([needRescue()], [
      file(ID_A, 'aaaaaaaa', 'jpg', 1000),
      file(ID_A, 'bbbbbbbb', 'png', 3000),
      file(ID_A, 'cccccccc', 'png', 2000)
    ])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.thumbPath).toBe(`${ID_A}-bbbbbbbb.png`)
    expect(plan[0]!.candidates).toBe(3)
    expect(plan[0]!.mtimeMs).toBe(3000)
  })

  it('mtime 相同时 png 优先（再相同按文件名降序，结果确定）', () => {
    const plan = planThumbRescue([needRescue()], [
      file(ID_A, '11111111', 'jpg', 5000),
      file(ID_A, '22222222', 'png', 5000)
    ])
    expect(plan[0]!.thumbPath).toBe(`${ID_A}-22222222.png`)
  })

  it('盘上没有该 id 的文件 → 不产出（38 条里那条"文件也没了"的记录）', () => {
    const plan = planThumbRescue([needRescue()], [file(ID_B, 'aaaaaaaa')])
    expect(plan).toEqual([])
  })

  it('不是缩略图名的文件 / 0 字节残骸 / 非法 size → 全部忽略', () => {
    const plan = planThumbRescue([needRescue()], [
      { name: 'not-a-thumb.png', size: 100, mtimeMs: 9000 },
      { name: `${ID_A}.png`, size: 100, mtimeMs: 9000 },
      { name: `${ID_A}-1234abcd.png`, size: 0, mtimeMs: 9000 },
      { name: `${ID_A}-1234abcd.png`, size: Number.NaN, mtimeMs: 9000 }
    ])
    expect(plan).toEqual([])
  })

  it('已有可用缩略图（thumbPath + ready）→ 绝不碰', () => {
    const plan = planThumbRescue(
      [needRescue({ thumbPath: `${ID_A}-deadbeef.png`, thumbStatus: 'ready' })],
      [file(ID_A, 'aaaaaaaa')]
    )
    expect(plan).toEqual([])
  })

  it('thumbPath 有但状态不是 ready → 仍属救援对象（这是本次事故的普遍形态之一）', () => {
    const plan = planThumbRescue(
      [needRescue({ thumbPath: `${ID_A}-deadbeef.png`, thumbStatus: 'failed' })],
      [file(ID_A, 'aaaaaaaa')]
    )
    expect(plan).toHaveLength(1)
  })

  it('软删记录不救援（回收站里不该突然有图）', () => {
    const plan = planThumbRescue([needRescue({ deletedAt: 123 })], [file(ID_A, 'aaaaaaaa')])
    expect(plan).toEqual([])
  })

  it('空入参 → 空计划（空跑保护的第一道）', () => {
    expect(planThumbRescue([], [file(ID_A, 'aaaaaaaa')])).toEqual([])
    expect(planThumbRescue([needRescue()], [])).toEqual([])
  })

  it('上限封顶（默认 THUMB_RESCUE_LIMIT，可覆盖）', () => {
    const assets = Array.from({ length: 5 }, (_, i) =>
      needRescue({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })
    )
    const files = assets.map((a) => file(a.id, 'abcdef01'))
    expect(planThumbRescue(assets, files, { limit: 2 })).toHaveLength(2)
    expect(THUMB_RESCUE_LIMIT).toBeGreaterThan(2)
  })
})

describe('planThumbRescue · prefer（显式偏好优先于 mtime）', () => {
  const TARGET = '5e4c3050-e057-4681-a70a-cb277890c309'
  const PREFERED = `${TARGET}-e94039c0.png`
  const NEWER = `${TARGET}-7933daa4.png`

  it('偏好文件优先，即便它不是最新的那个（事故现场：7900 比 e940 晚 5 分钟）', () => {
    const plan = planThumbRescue(
      [{ id: TARGET, thumbStatus: 'none' }],
      [
        file(TARGET, '7933daa4', 'png', 5000), // 更晚
        file(TARGET, 'e94039c0', 'png', 1000) // 正确
      ],
      { prefer: { [TARGET]: PREFERED } }
    )
    expect(plan).toHaveLength(1)
    expect(plan[0]!.thumbPath).toBe(PREFERED)
    expect(plan[0]!.candidates).toBe(2)
  })

  it('偏好**允许替换已有 thumbPath**（唯一例外；否则用户永远看到默认 UV 那张）', () => {
    const plan = planThumbRescue(
      [{ id: TARGET, thumbPath: NEWER, thumbStatus: 'ready' }],
      [file(TARGET, '7933daa4', 'png', 5000), file(TARGET, 'e94039c0', 'png', 1000)],
      { prefer: { [TARGET]: PREFERED } }
    )
    expect(plan).toHaveLength(1)
    expect(plan[0]!.thumbPath).toBe(PREFERED)
  })

  it('偏好文件不在盘上 → 回落 mtime 规则（绝不凭空造名字）', () => {
    const plan = planThumbRescue(
      [{ id: TARGET, thumbStatus: 'none' }],
      [file(TARGET, '7933daa4', 'png', 5000)],
      { prefer: { [TARGET]: PREFERED } }
    )
    expect(plan).toHaveLength(1)
    expect(plan[0]!.thumbPath).toBe(NEWER)
  })

  it('偏好文件不在盘上且记录已有可用图 → 不产出', () => {
    const plan = planThumbRescue(
      [{ id: TARGET, thumbPath: NEWER, thumbStatus: 'ready' }],
      [file(TARGET, '7933daa4', 'png', 5000)],
      { prefer: { [TARGET]: PREFERED } }
    )
    expect(plan).toEqual([])
  })

  it('软删记录：偏好也不能越过', () => {
    const plan = planThumbRescue(
      [{ id: TARGET, thumbStatus: 'none', deletedAt: 1 }],
      [file(TARGET, 'e94039c0', 'png', 1000)],
      { prefer: { [TARGET]: PREFERED } }
    )
    expect(plan).toEqual([])
  })

  it('RESCUE_PREFER 与表项同源（写死的那一个文件名）', () => {
    expect(RESCUE_PREFER[TARGET]).toBe(PREFERED)
    expect(Object.keys(RESCUE_PREFER)).toEqual([TARGET])
  })
})

describe('applyThumbRescue · 快照与失败策略', () => {
  /** 依赖桩：返回值额外标注成 `vi.fn`，断言里才能访问 `.mock.calls` */
  function deps(over: Partial<ThumbRescueDeps> = {}): ThumbRescueDeps & {
    loadAssets: ReturnType<typeof vi.fn>
    saveSnapshot: ReturnType<typeof vi.fn>
    updateThumb: ReturnType<typeof vi.fn>
  } {
    return {
      loadAssets: vi.fn(async (ids: readonly string[]) =>
        ids.map((id) => ({ id, thumbPath: undefined, thumbStatus: 'none' as const }))
      ),
      saveSnapshot: vi.fn(async () => undefined),
      updateThumb: vi.fn(async () => undefined),
      now: () => 1700000000000,
      ...over
    } as unknown as ThumbRescueDeps & {
      loadAssets: ReturnType<typeof vi.fn>
      saveSnapshot: ReturnType<typeof vi.fn>
      updateThumb: ReturnType<typeof vi.fn>
    }
  }

  it('计划为空 → 不读库、不写快照、不改任何记录', async () => {
    const d = deps()
    const result = await applyThumbRescue([], d)
    expect(result).toEqual({ snapshotId: null, applied: 0, skipped: 0 })
    expect(d.loadAssets).not.toHaveBeenCalled()
    expect(d.saveSnapshot).not.toHaveBeenCalled()
    expect(d.updateThumb).not.toHaveBeenCalled()
  })

  it('先写快照（rescue-<ts>，json 是原记录）再逐条更新', async () => {
    const d = deps()
    const plan = [
      { assetId: ID_A, thumbPath: `${ID_A}-aaaaaaaa.png`, mtimeMs: 1000, candidates: 1 },
      { assetId: ID_B, thumbPath: `${ID_B}-bbbbbbbb.jpg`, mtimeMs: 2000, candidates: 2 }
    ]
    const result = await applyThumbRescue(plan, d)

    expect(d.saveSnapshot).toHaveBeenCalledTimes(1)
    const snap = d.saveSnapshot.mock.calls[0]![0] as { id: string; at: number; json: string }
    expect(snap.id.startsWith(THUMB_RESCUE_SNAPSHOT_PREFIX)).toBe(true)
    expect(snap.at).toBe(1700000000000)
    const restored = JSON.parse(snap.json) as Array<{ id: string }>
    expect(restored.map((r) => r.id)).toEqual([ID_A, ID_B])
    // 顺序：快照先于写库
    expect(d.saveSnapshot.mock.invocationCallOrder[0]!).toBeLessThan(
      d.updateThumb.mock.invocationCallOrder[0]!
    )
    expect(result).toEqual({ snapshotId: `rescue-1700000000000`, applied: 2, skipped: 0 })
  })

  it('单条写失败只计入 skipped，其余照常写回（一条坏记录不拖垮整批）', async () => {
    const d = deps({
      updateThumb: vi.fn(async (id: string) => {
        if (id === ID_A) throw new Error('记录已被删')
      })
    })
    const result = await applyThumbRescue(
      [
        { assetId: ID_A, thumbPath: `${ID_A}-aaaaaaaa.png`, mtimeMs: 1, candidates: 1 },
        { assetId: ID_B, thumbPath: `${ID_B}-bbbbbbbb.png`, mtimeMs: 2, candidates: 1 }
      ],
      d
    )
    expect(result.applied).toBe(1)
    expect(result.skipped).toBe(1)
    expect(d.updateThumb).toHaveBeenCalledTimes(2)
  })

  it('记录在计划生成后消失（loadAssets 返回空）→ 不写快照、全部计 skipped', async () => {
    const d = deps({ loadAssets: vi.fn(async () => []) })
    const result = await applyThumbRescue(
      [{ assetId: ID_A, thumbPath: `${ID_A}-aaaaaaaa.png`, mtimeMs: 1, candidates: 1 }],
      d
    )
    expect(result).toEqual({ snapshotId: null, applied: 0, skipped: 1 })
    expect(d.saveSnapshot).not.toHaveBeenCalled()
  })
})

describe('RENDER_PARAMS_RESTORE · 事故参数的字面量证据', () => {
  const TARGET_ID = '5e4c3050-e057-4681-a70a-cb277890c309'
  /**
   * ⚠️ **固定槽位 fixture**，不要换成运行时的 `effectiveMaterialSlots`：
   * 这张 `-e94039c0.png` 是 **RENDER_REV=3** 时代用 `*.cover.jpg` 当 albedo 渲出来的。
   *
   * 两条已经发生的变更都会让它"不再是当前期望名"：
   * ① `RENDER_REV` 已由相机取景口径（`logic/ballCamera.ts`）**+1 到 4**；
   * ② `albedo-slot-engineer` 把贴图资产的首选图从 `*.cover.jpg` 换成真贴图。
   *
   * 所以下面按**显式 rev 前缀**做断言（不依赖今天的常量），把"这文件是哪一版的产物"
   * 写死成历史事实；本次救援只保证**参数值正确**，不保证永远命中同一张图。
   */
  const TARGET_SLOT = '新中式复古仿古砖_复古砖_墙砖_地砖_深色仿古砖ID_1172815578.cover.jpg'
  const TARGET_SLOTS_FIXED = { albedo: TARGET_SLOT }

  it('uv=3.10 + 其余默认 → rev3 的 hash 输入算出 e94039c0（盘上那张旧球图）', () => {
    const entry = RENDER_PARAMS_RESTORE[0]!
    expect(entry.id).toBe(TARGET_ID)
    expect(entry.params).toEqual({ uv: 3.1 })

    // 显式 rev3：这是磁盘文件名的来源，与当前 RENDER_REV 无关
    const rev3Input = 'rev3\n' + TARGET_SLOT + '\n' + paramsKey({ roughness: 1, bump: 1, uv: 3.1 })
    expect(fnv1a(rev3Input)).toBe('e94039c0')
  })

  it('对照：rev3 + 默认参数 = 7933daa4（事故后记录里残留的那张，证明只动过 UV）', () => {
    expect(fnv1a('rev3\n' + TARGET_SLOT)).toBe('7933daa4')
    // 有参数与无参数必须是不同的输入（否则"UV 被抹掉"根本看不出来）
    expect(fnv1a('rev3\n' + TARGET_SLOT + '\n1.00,1.00,3.10')).not.toBe(
      fnv1a('rev3\n' + TARGET_SLOT)
    )
  })

  it('当前 RENDER_REV 下同一参数已经是另一个名字（rev4 相机口径 → 旧图必然作废）', () => {
    // 显式 rev4：把"升级后必然换名"钉死；RENDER_REV 再 +1 时这条记录的是历史，不是约束
    expect(fnv1a('rev4\n' + TARGET_SLOT + '\n1.00,1.00,3.10')).toBe('2d6997ef')
    expect(fnv1a('rev4\n' + TARGET_SLOT)).toBe('f84ff4cd')
    expect(RENDER_REV).toBeGreaterThanOrEqual(4) // 只增不减的纪律
  })

  it('`ballThumbName` 的输入 = rev 前缀 + 槽位 + 参数串（与上面三条同源，不是另一套算法）', () => {
    const expectedHash = fnv1a(
      'rev' +
        RENDER_REV +
        '\n' +
        TARGET_SLOT +
        '\n' +
        paramsKey(restoreParamsFor(RENDER_PARAMS_RESTORE[0]!))
    )
    expect(
      ballThumbName(TARGET_ID, TARGET_SLOTS_FIXED, restoreParamsFor(RENDER_PARAMS_RESTORE[0]!), 'sphere')
    ).toBe(`${TARGET_ID}-${expectedHash}.png`)
  })

  it('槽位随 albedo 修复而变 → 名字必定不同（注释里那条提醒的可执行版本）', () => {
    const afterAlbedoFix = ballThumbName(
      TARGET_ID,
      { albedo: 'textures/仿古砖_2K_Albedo.jpg' },
      restoreParamsFor(RENDER_PARAMS_RESTORE[0]!),
      'sphere'
    )
    expect(afterAlbedoFix).not.toBe(`${TARGET_ID}-e94039c0.png`)
  })

  it('restoreParamsFor 必须补齐成六字段完整结构（不能让下游读到 undefined）', () => {
    expect(restoreParamsFor(RENDER_PARAMS_RESTORE[0]!)).toEqual({
      roughness: 1,
      bump: 1,
      uv: 3.1,
      light: 1,
      metal: 0,
      alpha: 1
    })
  })
})

describe('planRenderParamsRestore · 绝不覆盖用户新调的值', () => {
  const TARGET_ID = '5e4c3050-e057-4681-a70a-cb277890c309'

  it('renderParams 为空 → 产出恢复项', () => {
    const plan = planRenderParamsRestore([{ id: TARGET_ID, renderParams: undefined }])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.params.uv).toBe(3.1)
  })

  it('空对象也算"空"（脏数据兜底，可以安全覆盖成 3.10）', () => {
    expect(planRenderParamsRestore([{ id: TARGET_ID, renderParams: {} }])).toHaveLength(1)
  })

  it('用户已经调过（任何非空参数）→ 一个字节都不动', () => {
    expect(
      planRenderParamsRestore([{ id: TARGET_ID, renderParams: { roughness: 1, bump: 1, uv: 2.2 } }])
    ).toEqual([])
  })

  it('软删记录 / 不在表里的 id → 不产出', () => {
    expect(planRenderParamsRestore([{ id: TARGET_ID, deletedAt: 1 }])).toEqual([])
    expect(planRenderParamsRestore([{ id: 'other-id' }])).toEqual([])
  })

  it('幂等：写完（有参数）之后再跑一次 → 空计划', () => {
    const first = planRenderParamsRestore([{ id: TARGET_ID }])
    expect(first).toHaveLength(1)
    const after = planRenderParamsRestore([{ id: TARGET_ID, renderParams: first[0]!.params }])
    expect(after).toEqual([])
  })
})
