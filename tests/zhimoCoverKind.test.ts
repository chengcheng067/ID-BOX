/**
 * `isZhimoCoverKind` —— 知末封面通道的**类型门槛唯一口径**（2026-10 增 `cad`）。
 *
 * 为什么值得一个独立测试文件：这个判定原本是**三处**裸的 `kind === 'model'`
 * （`pickZhimoCoverTargets` :90 / `isZhimoCoverBackfillCandidate` :156 /
 * `store.enqueueZhimoCover`）。加 `cad` 时只要漏掉任何一处，就会出现
 * "手动按钮点了能抓、导入后自动任务却不抓"这种**静默半边功能** —— 没有报错、
 * 没有日志，用户只会觉得"有时候好使有时候不好使"。
 *
 * 所以这里既测行为（model/cad 为真、其余为假；三处调用点真的认 cad），
 * 也测源码（renderer 里不再有裸的 `kind !== 'model'` 门槛，全部走同一个函数）。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Asset, AssetKind } from '../src/shared/types'
import {
  isZhimoCoverBackfillCandidate,
  isZhimoCoverKind,
  pickZhimoCoverTargets
} from '../src/renderer/logic/zhimoCover'

function asset(over: Partial<Asset> = {}): Asset {
  return {
    id: 'a1',
    name: '餐厅平面设计方案ID_1200166260',
    kind: 'cad',
    source: '',
    folder: 'E:\\Lib\\CAD\\未分类\\未分类\\餐厅平面设计方案',
    relFolder: 'CAD/未分类/未分类/餐厅平面设计方案',
    cover: '餐厅平面设计方案.preview.png',
    coverSource: 'embedded',
    files: [
      { rel: '餐厅平面设计方案.dwg', name: '餐厅平面设计方案.dwg', ext: 'dwg', size: 10, kind: 'cad' },
      { rel: '餐厅平面设计方案.preview.png', name: '餐厅平面设计方案.preview.png', ext: 'png', size: 2, kind: 'texture' }
    ],
    size: 12,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    zhimoId: null,
    dedupeKey: 'cad:餐厅平面设计方案',
    importedAt: 1,
    updatedAt: 2,
    ...over
  }
}

describe('isZhimoCoverKind —— 类型门槛', () => {
  it('model / cad → true', () => {
    expect(isZhimoCoverKind('model')).toBe(true)
    expect(isZhimoCoverKind('cad')).toBe(true)
  })

  it('texture / material / hdri / other → false', () => {
    for (const kind of ['texture', 'material', 'hdri', 'other'] as const) {
      expect(isZhimoCoverKind(kind), kind).toBe(false)
    }
  })

  it('覆盖全部 AssetKind（将来加类型时必须显式决定，不能靠默认值蒙）', () => {
    const all: AssetKind[] = ['model', 'texture', 'material', 'hdri', 'cad', 'other']
    expect(all.filter(isZhimoCoverKind).sort()).toEqual(['cad', 'model'])
  })

  it('纯函数：同一个入参永远同一个结果（没有读全局/设置）', () => {
    expect(isZhimoCoverKind('cad')).toBe(isZhimoCoverKind('cad'))
  })
})

describe('三处调用点都真的认 cad', () => {
  it('pickZhimoCoverTargets：cad 资产能进自动抓取队列', () => {
    const targets = pickZhimoCoverTargets([asset()], { replacePacked: true })
    expect(targets).toEqual([{ id: 'a1', zhimoId: '1200166260' }])
  })

  it('pickZhimoCoverTargets：材质 / 贴图仍然一个都不选', () => {
    const list = [
      asset({ id: 't1', kind: 'texture' }),
      asset({ id: 'm1', kind: 'material' }),
      asset({ id: 'h1', kind: 'hdri' })
    ]
    expect(pickZhimoCoverTargets(list, { replacePacked: true })).toEqual([])
  })

  it('isZhimoCoverBackfillCandidate：cad + 无 cover 文件 + 有 ID → 候选', () => {
    expect(
      isZhimoCoverBackfillCandidate(
        asset({ files: [{ rel: '餐厅平面设计方案.dwg', name: '餐厅平面设计方案.dwg', ext: 'dwg', size: 10, kind: 'cad' }] })
      )
    ).toBe(true)
  })

  it('isZhimoCoverBackfillCandidate：cad 已有 .cover.jpg → 不是候选（不重抓已有的）', () => {
    expect(
      isZhimoCoverBackfillCandidate(
        asset({
          files: [
            { rel: '餐厅平面设计方案.dwg', name: '餐厅平面设计方案.dwg', ext: 'dwg', size: 10, kind: 'cad' },
            { rel: '餐厅平面设计方案.cover.jpg', name: '餐厅平面设计方案.cover.jpg', ext: 'jpg', size: 9, kind: 'texture' }
          ]
        })
      )
    ).toBe(false)
  })
})

describe('源码守卫：类型门槛只有一处定义', () => {
  const logic = fs.readFileSync(new URL('../src/renderer/logic/zhimoCover.ts', import.meta.url), 'utf-8')
  const store = fs.readFileSync(new URL('../src/renderer/store.ts', import.meta.url), 'utf-8')
  const panel = fs.readFileSync(
    new URL('../src/renderer/components/DetailPanel.tsx', import.meta.url),
    'utf-8'
  )

  it('logic/zhimoCover.ts 里没有裸的 `kind !== \'model\'`，`kind === \'model\'` 只出现在定义处', () => {
    expect(logic).not.toContain("kind !== 'model'")
    // 唯一允许的一处就是 `isZhimoCoverKind` 的函数体（两处候选过滤都必须走它）
    expect(logic.match(/kind === 'model'/g)?.length).toBe(1)
    const def = logic.slice(logic.indexOf('export function isZhimoCoverKind'))
    expect(def.slice(0, 200)).toContain("kind === 'model'")
  })

  it('两处候选过滤（自动队列 / 存量补抓）都走 isZhimoCoverKind', () => {
    expect(logic.match(/isZhimoCoverKind\(asset\.kind\)/g)?.length).toBe(2)
  })

  it('函数本身只有一处定义，且只在 renderer/logic/zhimoCover.ts', () => {
    expect(logic).toContain('export function isZhimoCoverKind(kind: AssetKind): boolean')
    expect(logic).toContain("return kind === 'model' || kind === 'cad'")
    // store / 面板都只能 import 用，不许自己再写一份
    expect(store).not.toContain('function isZhimoCoverKind')
    expect(panel).not.toContain('function isZhimoCoverKind')
  })

  it('store.enqueueZhimoCover 与 DetailPanel 按钮都调它', () => {
    expect(store).toContain('isZhimoCoverKind(asset.kind)')
    expect(panel).toContain('isZhimoCoverKind(asset.kind)')
  })

  it('renderer 里（除定义处）不再有任何裸的 kind !== model 门槛', () => {
    expect(store).not.toContain("asset.kind !== 'model'")
    expect(panel).not.toContain("asset.kind === 'model'")
  })

  it('主进程抓取核心一行未改：不含任何 kind 判断，URL 模板仍是 su 那条', () => {
    const main = fs.readFileSync(new URL('../src/main/zhimoCover.ts', import.meta.url), 'utf-8')
    expect(main).not.toContain("kind === 'model'")
    expect(main).not.toContain("kind !== 'model'")
    // CAD 详情页靠**同一条** URL 模板 301 到 sgt 频道，抓取核心不需要任何改动
    expect(main).toContain("const ZHIMO_DETAIL_BASE = 'https://su.znzmo.com/sumoxing/'")
  })
})
