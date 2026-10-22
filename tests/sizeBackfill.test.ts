/**
 * 尺寸回填调度（`renderer/logic/sizeBackfill.ts`）—— 全部用**假 deps**。
 *
 * 硬化四条边界：① 不加载 Dexie / store / electron（deps 注入后默认实现永不求值）；
 * ② 写库走**定向 patch**（只动 `files[i].w/h`，`updatedAt` 等逐字段不变）；
 * ③ **不覆盖并发写入**：探测期间别处改了 `thumbPath` / `renderParams`，patch 之后
 *    库里仍是新值（快照整对象 `put` 会把这些改动回滚掉）；④ 单飞 + 预算 + 环形轮转。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BACKFILL_MAX_ASSETS,
  BACKFILL_MAX_ROUNDS,
  BACKFILL_PROBE_LIMIT,
  BACKFILL_ROUND_GAP_MS,
  isBackfillCandidate,
  missingSizeRels,
  planBackfill,
  rotationOffset,
  runSizeBackfill,
  startSizeBackfill,
  withProbedSizes,
  type SizeBackfillDeps,
  type SizeBackfillLogEvent,
  type SizePatch
} from '../src/renderer/logic/sizeBackfill'
import { PROBE_SIZES_MAX } from '../src/main/probeSizes'
import type { Asset, AssetFile } from '../src/shared/types'

/** 固定时钟：让环形起点 / 预算判定可复现 */
const FIXED_NOW = 1_700_000_000_123

function file(rel: string, ext: string, size?: { w?: number; h?: number }): AssetFile {
  return {
    rel,
    name: rel.split('/').pop() ?? rel,
    ext,
    size: 1024,
    kind: 'texture',
    ...(size?.w !== undefined ? { w: size.w } : {}),
    ...(size?.h !== undefined ? { h: size.h } : {})
  }
}

function asset(id: string, files: AssetFile[], extra: Partial<Asset> = {}): Asset {
  return {
    id,
    name: `资产-${id}`,
    kind: 'texture',
    source: '手动导入',
    folder: `E:/FakeLib/材质/未分类/未分类/${id}`,
    relFolder: `材质/未分类/未分类/${id}`,
    files,
    size: 2048,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `texture:资产-${id}`,
    importedAt: 1_600_000_000_000,
    updatedAt: 1_650_000_000_000,
    ...extra
  }
}

/** 缺尺寸的 jpg 资产（大多数用例的"标准候选"） */
function candidateAsset(id: string): Asset {
  return asset(id, [file('albedo.jpg', 'jpg'), file('model.skp', 'skp')])
}

/** 统一收集 patch 调用（默认返回"确实改了"，让 patched 计数可断言） */
function collector(): {
  patch: (id: string, patches: SizePatch[]) => Promise<boolean>
  calls: Array<{ id: string; patches: SizePatch[] }>
} {
  const calls: Array<{ id: string; patches: SizePatch[] }> = []
  return {
    calls,
    patch: async (id: string, patches: SizePatch[]) => {
      calls.push({ id, patches: patches.map((p) => ({ ...p })) })
      return true
    }
  }
}

/**
 * 内存版「库 + Dexie modify 语义」：`patchSizes` 像真实实现一样**读库里当下的记录**
 * 只改 `files[i].w/h`，其余字段（thumbPath / renderParams / updatedAt…）原样保留。
 */
function fakeLibrary(initial: Asset[]): {
  deps: SizeBackfillDeps
  patchCalls: Array<{ id: string; patches: SizePatch[] }>
  get: (id: string) => Asset | undefined
  /** 模拟"别处（球图渲染器 commitAsset）"在探测期间写库 */
  write: (id: string, patch: Partial<Asset>) => void
  refreshed: Asset[][]
} {
  const rows = new Map<string, Asset>(initial.map((a) => [a.id, a]))
  const patchCalls: Array<{ id: string; patches: SizePatch[] }> = []
  const refreshed: Asset[][] = []

  const deps: SizeBackfillDeps = {
    listAssets: async () => [...rows.values()],
    patchSizes: async (id: string, patches: SizePatch[]) => {
      patchCalls.push({ id, patches: patches.map((p) => ({ ...p })) })
      const current = rows.get(id)
      if (!current) return false
      let changed = false
      const files = current.files.map((file) => {
        const hit = patches.find((p) => p.rel === file.rel)
        if (!hit) return file
        if (file.w === hit.w && file.h === hit.h) return file
        changed = true
        return { ...file, w: hit.w, h: hit.h }
      })
      if (changed) rows.set(id, { ...current, files })
      return changed
    },
    readAsset: async (id: string) => rows.get(id),
    probe: async (_folder, rels) => rels.map((rel) => ({ rel, w: 2048, h: 2048 })),
    refreshAssets: (updated) => {
      refreshed.push(updated)
    },
    log: () => {},
    now: () => FIXED_NOW
  }

  return {
    deps,
    patchCalls,
    refreshed,
    get: (id: string) => rows.get(id),
    write: (id: string, patch: Partial<Asset>) => {
      const current = rows.get(id)
      if (current) rows.set(id, { ...current, ...patch })
    }
  }
}

describe('planBackfill —— 候选判定', () => {
  it('只挑 jpg/jpeg/png/hdr/exr 且缺 w/h 的；webp/bmp/tif/gif 不进候选', () => {
    const assets: Asset[] = [
      candidateAsset('a-jpg'),
      asset('b-jpeg', [file('x.jpeg', 'jpeg')]),
      asset('c-png', [file('x.png', 'png', { w: 1024 })]), // 只有 w → 仍缺 h
      asset('d-hdr', [file('pano.hdr', 'hdr')]),
      asset('e-exr', [file('disp.exr', 'exr')]),
      // 以下都不该进候选
      asset('f-webp', [file('x.webp', 'webp')]),
      asset('g-bmp', [file('x.bmp', 'bmp')]),
      asset('h-tif', [file('x.tif', 'tif')]),
      asset('i-gif', [file('x.gif', 'gif')]),
      asset('j-complete', [file('x.jpg', 'jpg', { w: 2048, h: 2048 })]),
      asset('k-deleted', [file('x.jpg', 'jpg')], { deletedAt: 1_700_000_000_000 }),
      asset('l-no-files', [])
    ]

    const plan = planBackfill(assets, { now: FIXED_NOW, maxAssets: 100 })
    expect(plan.total).toBe(5)
    expect(plan.queue.map((a) => a.id).sort()).toEqual([
      'a-jpg',
      'b-jpeg',
      'c-png',
      'd-hdr',
      'e-exr'
    ])
    expect(plan.queue.some((a) => a.id === 'k-deleted')).toBe(false)
  })

  it('isBackfillCandidate：ext 大小写不敏感；w/h 都齐 → 不是候选', () => {
    expect(isBackfillCandidate(asset('x', [file('A.JPG', 'JPG')]))).toBe(true)
    expect(isBackfillCandidate(asset('y', [file('a.jpg', 'jpg', { w: 1, h: 1 })]))).toBe(false)
    expect(isBackfillCandidate(asset('z', [file('a.jpg', 'jpg', { w: 1 })]))).toBe(true)
  })

  it('rotationOffset：now % total，负数/非法值不炸', () => {
    expect(rotationOffset(10, 3)).toBe(3)
    expect(rotationOffset(10, 13)).toBe(3)
    expect(rotationOffset(0, 13)).toBe(0)
    expect(rotationOffset(10, Number.NaN)).toBe(0)
    expect(rotationOffset(10, -13)).toBe(3)
  })

  it('missingSizeRels：只挑缺尺寸的白名单文件、保序、最多 200 条', () => {
    const many: AssetFile[] = []
    for (let i = 0; i < 250; i += 1) many.push(file(`t${i}.png`, 'png'))
    many.push(file('done.jpg', 'jpg', { w: 1, h: 1 }))
    many.push(file('x.webp', 'webp'))

    const rels = missingSizeRels(asset('m', many))
    expect(rels).toHaveLength(BACKFILL_PROBE_LIMIT)
    expect(rels[0]).toBe('t0.png')
    expect(rels).not.toContain('done.jpg')
    expect(rels).not.toContain('x.webp')
  })

  it('渲染层的 PROBE 上限必须与主进程 PROBE_SIZES_MAX 一致（防两处漂移）', () => {
    expect(BACKFILL_PROBE_LIMIT).toBe(PROBE_SIZES_MAX)
  })
})

describe('withProbedSizes —— 只 patch 目标字段', () => {
  it('只写 files[i].w/h；id / name / updatedAt 等逐字段不变', () => {
    const before = candidateAsset('only-fields')
    const after = withProbedSizes(before, [{ rel: 'albedo.jpg', w: 2048, h: 2048 }])

    expect(after).not.toBeNull()
    // 整对象深比较：任何字段被"顺手改动"都会红
    expect(after).toEqual({
      ...before,
      files: [{ ...before.files[0], w: 2048, h: 2048 }, before.files[1]]
    })
    expect(after!.updatedAt).toBe(before.updatedAt)
    expect(after!.id).toBe(before.id)
    expect(after!.name).toBe(before.name)
    expect(before.files[0].w).toBeUndefined() // 入参未被就地修改
  })

  it('没匹配 / 值相同 → null（调用方据此不写库，天然幂等）', () => {
    const a = candidateAsset('idempotent')
    expect(withProbedSizes(a, [])).toBeNull()
    expect(withProbedSizes(a, [{ rel: 'other.jpg', w: 10, h: 10 }])).toBeNull()

    const done = asset('done', [file('albedo.jpg', 'jpg', { w: 2048, h: 2048 })])
    expect(withProbedSizes(done, [{ rel: 'albedo.jpg', w: 2048, h: 2048 }])).toBeNull()
  })
})

describe('runSizeBackfill —— 预算 / 轮转 / 单飞', () => {
  it('probe 返回空数组 → 不 patch、不抛异常、remaining 计数正确', async () => {
    const { patch, calls } = collector()
    const probe = vi.fn(async () => [])
    const summary = await runSizeBackfill({
      listAssets: async () => [candidateAsset('a'), candidateAsset('b')],
      patchSizes: patch,
      probe,
      refreshAssets: () => {},
      log: () => {},
      now: () => FIXED_NOW
    })

    expect(summary).toEqual({
      scanned: 2,
      patched: 0,
      remaining: 0,
      elapsedMs: 0
    })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(0)
  })

  it('预算：100 个候选 + maxAssets=60 → 只 probe 60 个，remaining=40', async () => {
    const assets = Array.from({ length: 100 }, (_, i) => candidateAsset(`id-${i}`))
    const probe = vi.fn(async () => [])
    const summary = await runSizeBackfill({
      listAssets: async () => assets,
      patchSizes: async () => false,
      probe,
      refreshAssets: () => {},
      log: () => {},
      now: () => FIXED_NOW
    })

    expect(probe).toHaveBeenCalledTimes(BACKFILL_MAX_ASSETS)
    expect(summary?.scanned).toBe(BACKFILL_MAX_ASSETS)
    expect(summary?.patched).toBe(0)
    expect(summary?.remaining).toBe(40)
  })

  it('时间预算：时钟每步前进 1 秒 → 3 秒到点就停（不等 60 个跑完）', async () => {
    const assets = Array.from({ length: 100 }, (_, i) => candidateAsset(`time-${i}`))
    let ticks = 0
    const summary = await runSizeBackfill({
      listAssets: async () => assets,
      patchSizes: async () => false,
      probe: async () => [],
      refreshAssets: () => {},
      log: () => {},
      now: () => (ticks += 1000)
    })

    expect(summary!.scanned).toBe(2) // 0s 起跑；1s 第二个；3s 到点
    expect(summary!.remaining).toBe(98)
    expect(summary!.elapsedMs).toBeGreaterThanOrEqual(3000)
  })

  it('轮转起点：now 不同 → 本轮处理的 id 集合不同（坏资产不会永远堵在队头）', () => {
    const assets = Array.from({ length: 10 }, (_, i) => candidateAsset(`rot-${i}`))
    const first = planBackfill(assets, { now: 3, maxAssets: 4 })
    const second = planBackfill(assets, { now: 7, maxAssets: 4 })

    const firstIds = first.queue.map((a) => a.id)
    const secondIds = second.queue.map((a) => a.id)
    expect(first.offset).toBe(3)
    expect(second.offset).toBe(7)
    expect(firstIds).not.toEqual(secondIds)
    // 环形：offset 起连续取，超过尾部回绕到 0
    expect(firstIds).toEqual(['rot-3', 'rot-4', 'rot-5', 'rot-6'])
    expect(secondIds).toEqual(['rot-7', 'rot-8', 'rot-9', 'rot-0'])
  })

  it('single-flight：并发调用只跑一轮（第二轮返回 null，probe 不被翻倍）', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const probe = vi.fn(async () => {
      await gate
      return [{ rel: 'albedo.jpg', w: 2048, h: 2048 }]
    })
    const { patch, calls } = collector()
    const deps = {
      listAssets: async () => [candidateAsset('single')],
      patchSizes: patch,
      probe,
      refreshAssets: () => {},
      log: () => {},
      now: () => FIXED_NOW
    }

    const first = runSizeBackfill(deps)
    // 让第一轮跑进 probe 的 await 点
    await Promise.resolve()
    const second = await runSizeBackfill(deps)
    expect(second).toBeNull()

    release()
    const summary = await first
    expect(summary?.patched).toBe(1)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('single')
    expect(calls[0]!.patches).toEqual([{ rel: 'albedo.jpg', w: 2048, h: 2048 }])
  })

  it('写库与刷新都失败也不抛（写库失败 → 不计数、不刷新）', async () => {
    const refresh = vi.fn(() => {})
    const summary = await runSizeBackfill({
      listAssets: async () => [candidateAsset('boom')],
      patchSizes: async () => {
        throw new Error('quota')
      },
      probe: async () => [{ rel: 'albedo.jpg', w: 1024, h: 1024 }],
      refreshAssets: refresh,
      log: () => {},
      now: () => FIXED_NOW
    })

    expect(summary).toEqual({ scanned: 1, patched: 0, remaining: 0, elapsedMs: 0 })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('patch 返回 false（值本来就相同）→ 不计数、不刷新', async () => {
    const refresh = vi.fn(() => {})
    const summary = await runSizeBackfill({
      listAssets: async () => [candidateAsset('noop')],
      patchSizes: async () => false,
      probe: async () => [{ rel: 'albedo.jpg', w: 1024, h: 1024 }],
      refreshAssets: refresh,
      log: () => {},
      now: () => FIXED_NOW
    })

    expect(summary).toEqual({ scanned: 1, patched: 0, remaining: 0, elapsedMs: 0 })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('★ 探测期间该资产被别处改了 thumbPath / renderParams → patch 之后库里仍是新值', async () => {
    const before = candidateAsset('concurrent')
    const lib = fakeLibrary([before])
    // 探测期间球图渲染器 commitAsset：写进新的缩略图与调参
    const probe = vi.fn(async (_folder: string, rels: string[]) => {
      lib.write('concurrent', {
        thumbPath: 'e94039c0.jpg',
        thumbStatus: 'ready',
        renderParams: { roughness: 1.4, bump: 0.7, uv: 3.1 },
        updatedAt: 1_700_000_999_000
      })
      return rels.map((rel) => ({ rel, w: 4096, h: 4096 }))
    })

    const summary = await runSizeBackfill({ ...lib.deps, probe })

    expect(summary?.patched).toBe(1)
    const row = lib.get('concurrent')!
    // 尺寸补上了
    expect(row.files[0]!.w).toBe(4096)
    expect(row.files[0]!.h).toBe(4096)
    // ★ 并发写入一点没被回滚（旧实现整对象 put 会把这三项顶回快照值）
    expect(row.thumbPath).toBe('e94039c0.jpg')
    expect(row.thumbStatus).toBe('ready')
    expect(row.renderParams).toEqual({ roughness: 1.4, bump: 0.7, uv: 3.1 })
    expect(row.updatedAt).toBe(1_700_000_999_000)
    // 内存刷新用的是"写库后的最新记录"，不是轮次快照
    expect(lib.refreshed).toHaveLength(1)
    expect(lib.refreshed[0]![0]!.thumbPath).toBe('e94039c0.jpg')
    expect(lib.refreshed[0]![0]!.renderParams).toEqual({ roughness: 1.4, bump: 0.7, uv: 3.1 })
  })

  it('整体失败（读库抛错）→ 返回零摘要，绝不把异常抛给启动链路', async () => {
    const summary = await runSizeBackfill({
      listAssets: async () => {
        throw new Error('db closed')
      },
      now: () => FIXED_NOW
    })
    expect(summary).toEqual({ scanned: 0, patched: 0, remaining: 0, elapsedMs: 0 })
  })
})

// ── 大类能力门（只补"分辨率有意义"的大类） ──────────────────────────────

describe('候选判定 —— 只补能力表里 resolution=true 的大类', () => {
  it('model / other 即使缺 w/h 也不进候选', () => {
    expect(isBackfillCandidate(asset('m', [file('a.jpg', 'jpg')], { kind: 'model' }))).toBe(false)
    expect(isBackfillCandidate(asset('o', [file('a.jpg', 'jpg')], { kind: 'other' }))).toBe(false)

    const plan = planBackfill(
      [
        asset('m', [file('a.jpg', 'jpg')], { kind: 'model' }),
        asset('o', [file('b.jpg', 'jpg')], { kind: 'other' })
      ],
      { now: FIXED_NOW, maxAssets: 60 }
    )
    expect(plan.total).toBe(0)
    expect(plan.queue).toHaveLength(0)
  })

  it('texture / material / hdri 都进候选（hdri 走 hdr/exr 也要补）', () => {
    expect(isBackfillCandidate(asset('t', [file('a.jpg', 'jpg')], { kind: 'texture' }))).toBe(true)
    expect(isBackfillCandidate(asset('mat', [file('a.jpg', 'jpg')], { kind: 'material' }))).toBe(
      true
    )
    expect(isBackfillCandidate(asset('h', [file('p.hdr', 'hdr')], { kind: 'hdri' }))).toBe(true)

    const plan = planBackfill(
      [
        asset('t', [file('a.jpg', 'jpg')], { kind: 'texture' }),
        asset('mat', [file('b.jpg', 'jpg')], { kind: 'material' }),
        asset('h', [file('c.hdr', 'hdr')], { kind: 'hdri' }),
        asset('m', [file('d.jpg', 'jpg')], { kind: 'model' })
      ],
      { now: FIXED_NOW, maxAssets: 60 }
    )
    expect(plan.queue.map((a) => a.id).sort()).toEqual(['h', 'mat', 't'])
  })
})

// ── 会话驱动：一轮补不完自己接着跑 ──────────────────────────────────────

/** 内存假 db：patch 会真的改掉 rows（只改 w/h），下一轮 listAssets 才能看到"已补完" */
function fakeDb(
  initial: Asset[],
  opts: { probeDelay?: () => Promise<void> } = {}
): {
  deps: SizeBackfillDeps
  patched: SizePatch[]
  logs: SizeBackfillLogEvent[]
  probeCalls: () => number
} {
  let rows = initial
  const patchedCalls: SizePatch[] = []
  const logs: SizeBackfillLogEvent[] = []
  let probes = 0
  const deps: SizeBackfillDeps = {
    listAssets: async () => rows,
    patchSizes: async (id, patches) => {
      patchedCalls.push(...patches)
      let rowChanged = false
      rows = rows.map((row) => {
        if (row.id !== id) return row
        const files = row.files.map((file) => {
          const hit = patches.find((p) => p.rel === file.rel)
          if (!hit) return file
          rowChanged = true
          return { ...file, w: hit.w, h: hit.h }
        })
        return { ...row, files }
      })
      return rowChanged
    },
    readAsset: async (id) => rows.find((row) => row.id === id),
    probe: async (_folder, rels) => {
      probes += 1
      if (opts.probeDelay) await opts.probeDelay()
      return rels.map((rel) => ({ rel, w: 2048, h: 2048 }))
    },
    refreshAssets: () => {},
    log: (ev) => logs.push(ev),
    now: () => FIXED_NOW
  }
  return { deps, patched: patchedCalls, logs, probeCalls: () => probes }
}

/** 推进 fake timer（每轮间隔一次），足够跑完一整条会话链 */
async function advanceSession(times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(BACKFILL_ROUND_GAP_MS)
  }
}

describe('startSizeBackfill —— 同会话自续', () => {
  it('150 个候选 → 自动跑满 3 轮（60/60/30）后停，remaining=0 且点亮完成日志', async () => {
    vi.useFakeTimers()
    try {
      const db = fakeDb(Array.from({ length: 150 }, (_, i) => candidateAsset(`auto-${i}`)))
      const running = startSizeBackfill(db.deps)
      await advanceSession()
      const summary = await running

      expect(summary).toEqual({
        rounds: 3,
        scanned: 150,
        patched: 150,
        remaining: 0,
        elapsedMs: 0
      })
      expect(db.probeCalls()).toBe(150)
      expect(db.patched).toHaveLength(150)

      // 完成日志：累计 patched + 总耗时
      const done = db.logs.find((e) => e.message === '[sizeBackfill] 全部补完')
      expect(done).toBeDefined()
      expect(done!.context.rounds).toBe(3)
      expect(done!.context.patched).toBe(150)
      expect(typeof done!.context.elapsedMs).toBe('number')
      expect(done!.context.elapsedMs).toBeGreaterThanOrEqual(0)
      // 每轮各有一条单轮日志（60/60/30）
      const roundsLogs = db.logs.filter((e) => e.message === '[sizeBackfill] 完成')
      expect(roundsLogs.map((e) => e.context.scanned)).toEqual([60, 60, 30])
    } finally {
      vi.useRealTimers()
    }
  })

  it('会话上限：2000 个候选跑满 25 轮就停，不无限循环', async () => {
    vi.useFakeTimers()
    try {
      const logs: SizeBackfillLogEvent[] = []
      let probes = 0
      // probe 永远返回空（模拟"全都读不出"）→ remaining 不降，只能撞上限
      const assets = Array.from({ length: 2000 }, (_, i) => candidateAsset(`cap-${i}`))
      const running = startSizeBackfill({
        listAssets: async () => assets,
        patchSizes: async () => false,
        probe: async () => {
          probes += 1
          return []
        },
        refreshAssets: () => {},
        log: (ev) => logs.push(ev),
        now: () => FIXED_NOW
      })
      await advanceSession(40)
      const summary = await running

      expect(summary!.rounds).toBe(BACKFILL_MAX_ROUNDS)
      // remaining 是"最后一轮没轮到的"：2000 个候选、每轮 60 → 1940
      expect(summary!.remaining).toBe(2000 - BACKFILL_MAX_ASSETS)
      expect(probes).toBe(BACKFILL_MAX_ROUNDS * BACKFILL_MAX_ASSETS)

      const capped = logs.find((e) => e.message === '[sizeBackfill] 到达会话上限')
      expect(capped).toBeDefined()
      expect(capped!.context.rounds).toBe(BACKFILL_MAX_ROUNDS)
      expect(capped!.context.remaining).toBe(2000 - BACKFILL_MAX_ASSETS)
      expect(logs.some((e) => e.message === '[sizeBackfill] 全部补完')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('会话单飞：第二条 startSizeBackfill 直接返回 null', async () => {
    vi.useFakeTimers()
    try {
      const db = fakeDb(Array.from({ length: 90 }, (_, i) => candidateAsset(`dup-${i}`)))
      const first = startSizeBackfill(db.deps)
      expect(await startSizeBackfill(db.deps)).toBeNull()
      await advanceSession()
      const summary = await first
      expect(summary!.rounds).toBe(2) // 60 + 30
      expect(db.probeCalls()).toBe(90)
    } finally {
      vi.useRealTimers()
    }
  })
})
