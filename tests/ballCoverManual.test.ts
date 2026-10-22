/**
 * 回归：用户「更换封面」亲手选了封面后，卡片不能再显示球图（2026-10-23 用户反馈）。
 *
 * 缺陷现象：在「更换封面」里选了包内自带的 `*_Preview.png`，卡片仍显示渲染球。
 * 根因：`ballThumbTarget()` 只排除 `coverSource === 'named'`，没排除 `'manual'` →
 *   `regenThumbSweep` 走球图分支并保留旧的 `thumbPath`（= 球图名），
 *   封面缩略图**根本没生成**，所以卡片一直显示球。
 *
 * 判据：`ballThumbTarget()` 是「这个资产**该不该**有球图」的唯一入口
 * （入队侧 `enqueueBallThumb`、渲染侧 `renderBallThumbFor`、清理侧 `regenThumbSweep` 三处共用），
 * 所以这里直接对它断言即可，不需要真跑渲染。
 */
import { describe, expect, it } from 'vitest'
import type { Asset } from '../src/shared/types'
import { ballThumbTarget, isStaleBallThumb } from '../src/renderer/store'

/** 最小可用材质资产：一个 albedo 槽位 + 封面 */
function makeAsset(patch: Partial<Asset>): Asset {
  return {
    id: 'asset-1',
    name: '墙面-2',
    kind: 'material',
    source: '知末网',
    folder: 'E:/lib/材质/涂料/涂料/墙面-2',
    relFolder: '材质/涂料/涂料/墙面-2',
    size: 1024,
    files: [
      {
        rel: 'x_2K_Albedo.jpg',
        name: 'x_2K_Albedo.jpg',
        ext: 'jpg',
        size: 1024,
        kind: 'texture'
      }
    ],
    cover: 'Plaster_Old_surface_Preview.png',
    coverSource: 'placeholder',
    importedAt: 1,
    updatedAt: 1,
    ...patch
  } as Asset
}

describe('ballThumbTarget · 封面来源优先级', () => {
  it('manual（用户亲手选的封面）→ 不渲球，卡片走封面缩略图', () => {
    expect(ballThumbTarget(makeAsset({ coverSource: 'manual' }))).toBeNull()
  })

  it('named（包内官方预览图）→ 不渲球（既有行为，防回归）', () => {
    expect(ballThumbTarget(makeAsset({ coverSource: 'named' }))).toBeNull()
  })

  it('placeholder（没有封面）→ 渲球', () => {
    expect(ballThumbTarget(makeAsset({ coverSource: 'placeholder' }))).not.toBeNull()
  })

  it('root / largest / embedded（自动挑的封面）→ 仍渲球（球图是这类资产的主视觉）', () => {
    for (const coverSource of ['root', 'largest', 'embedded'] as const) {
      expect(ballThumbTarget(makeAsset({ coverSource }))).not.toBeNull()
    }
  })

  it('manual 但 cover 为空（脏数据）→ 仍渲球，不能因为脏数据把卡片变成空白', () => {
    expect(ballThumbTarget(makeAsset({ coverSource: 'manual', cover: undefined }))).not.toBeNull()
  })

  it('模型资产永远不渲球（与封面来源无关）', () => {
    expect(ballThumbTarget(makeAsset({ kind: 'model', coverSource: 'manual' }))).toBeNull()
    expect(ballThumbTarget(makeAsset({ kind: 'model', coverSource: 'placeholder' }))).toBeNull()
  })
})

describe('isStaleBallThumb · 存量修复判据', () => {
  /** 借 ballThumbTarget 拿到该资产当前的球图名（避免在测试里重算槽位与参数） */
  const ballNameOf = (patch: Partial<Asset>): string => {
    const t = ballThumbTarget(makeAsset({ ...patch, coverSource: 'placeholder' }))
    expect(t).not.toBeNull()
    return t!.name
  }

  it('手动封面 + 缩略图仍指着旧球图 → 需要修', () => {
    const name = ballNameOf({})
    const asset = makeAsset({ coverSource: 'manual', thumbPath: name, thumbStatus: 'ready' })
    expect(isStaleBallThumb(asset)).toBe(true)
  })

  it('手动封面 + 缩略图已是封面缩略图（名字不同）→ 不需要修', () => {
    const asset = makeAsset({
      coverSource: 'manual',
      thumbPath: 'asset-1-deadbeef.png',
      thumbStatus: 'ready'
    })
    expect(isStaleBallThumb(asset)).toBe(false)
  })

  it('未指定封面（仍该用球图）→ 即使缩略图是球图也不需要修', () => {
    const name = ballNameOf({})
    const asset = makeAsset({ coverSource: 'placeholder', thumbPath: name, thumbStatus: 'ready' })
    expect(isStaleBallThumb(asset)).toBe(false)
  })

  it('缩略图未就绪 → 不修（交给 ensureMissingThumbs）', () => {
    const name = ballNameOf({})
    const asset = makeAsset({ coverSource: 'manual', thumbPath: name, thumbStatus: 'none' })
    expect(isStaleBallThumb(asset)).toBe(false)
  })

  it('没有封面 → 不修', () => {
    const name = ballNameOf({})
    const asset = makeAsset({
      coverSource: 'manual',
      cover: undefined,
      thumbPath: name,
      thumbStatus: 'ready'
    })
    expect(isStaleBallThumb(asset)).toBe(false)
  })
})
