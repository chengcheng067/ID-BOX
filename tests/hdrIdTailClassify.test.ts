/**
 * 知末 HDR 标准包的一级分类回归（v0.9.3）。
 *
 * 背景：知末 HDR 下载下来是**单个 .hdr 文件、没有压缩包**，文件名形如
 * `现代小区HDRID_1223468004.hdr`。导入时 assetName = `现代小区HDRID_1223468004`，
 * 里面的 `ID_<数字>` 尾巴粘在 `HDR` 后面会把 CJK 尾锚咬断，导致明明名字里
 * 有「小区HDR」却分不出来。修法见 `src/shared/classifyAsset.ts` 的 `matchName`。
 *
 * 本文件同时钉住三件事：
 * 1. 五个站方一级词 + 用户给的真实样本，全部命中；
 * 2. 词表纪律红线（裸「天空」不模糊匹配、`木纹HDR` 不串进贴图频道）不变；
 * 3. **磁盘名不动**：`displayName` 只用于分类判据，导入侧的 assetName 生成式
 *    与 `classifyAssetName(assetName, ...)` 调用保持原样（源码守卫）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classifyAssetName } from '../src/shared/classifyAsset'
import { displayName, sanitizeName, stripNoise } from '../src/shared/naming'
import { UNCLASSIFIED } from '../src/shared/taxonomy'

/** 复刻 importer.ts:1558 / :1266 的资产名生成（去扩展名 → stripNoise → sanitizeName） */
const assetNameOf = (itemName: string): string =>
  sanitizeName(stripNoise(itemName.replace(/\.[^.]+$/, '')))

const classifyItem = (itemName: string) =>
  classifyAssetName(assetNameOf(itemName), [itemName], 'hdri')

describe('A · 带 ID 尾巴的知末标准包 → 命中站方一级', () => {
  it.each([
    ['天空HDRID_1223468001.hdr', '天空HDR'],
    ['城市HDRID_1223468002.hdr', '城市HDR'],
    ['小区HDRID_1223468003.hdr', '小区HDR'],
    ['室内HDRID_1223468004.hdr', '室内HDR'],
    ['户外HDRID_1223468005.hdr', '户外HDR'],
    // 用户 2026-11-04 给的真实样本：名字里带修饰词「现代」，尾锚仍是「小区HDR」
    ['现代小区HDRID_1223468004.hdr', '小区HDR']
  ])('%s → %s / 未分类', (file, expected) => {
    const out = classifyItem(file)
    expect(out.category1).toBe(expected)
    expect(out.category2).toBe(UNCLASSIFIED)
  })

  it('剥 ID 只发生在判据里：displayName 与落盘用的 assetName 确实不同', () => {
    const assetName = assetNameOf('现代小区HDRID_1223468004.hdr')
    expect(assetName).toBe('现代小区HDRID_1223468004')
    expect(displayName(assetName)).toBe('现代小区HDR')
    // classifyAssetName 是纯函数，不回写入参
    expect(assetName).toBe('现代小区HDRID_1223468004')
  })
})

describe('B · 红线：改后一律不许变化', () => {
  it.each([
    '天空', // 裸词不做模糊匹配（尾锚纪律）
    '木纹HDR', // 通用 40 项二级词条不许污染 HDR 频道
    '石材HDR',
    '沙发HDR',
    '北欧挂画',
    '古月视觉HDR-偏移U：0.23' // 用户自己收集的素材：无 ID、无场景词 → 仍双未分类
  ])('%s → 双未分类', (name) => {
    expect(classifyAssetName(name, [], 'hdri')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
  })

  it('只有 hdri 通道使用 displayName（源码守卫）', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/shared/classifyAsset.ts', import.meta.url)),
      'utf-8'
    )
    expect(src).toContain("level2Scope === 'hdri' ? displayName(assetName) : assetName")
  })

  it('导入侧仍用原 assetName 落盘，没被换成 displayName（源码守卫）', () => {
    const importer = readFileSync(
      fileURLToPath(new URL('../src/main/importer.ts', import.meta.url)),
      'utf-8'
    )
    expect(importer).toContain(
      'const assetName = sanitizeName(stripNoise(path.basename(itemName, path.extname(itemName))))'
    )
    expect(importer).toContain('classifyAssetName(assetName, [itemName], kind)')
  })
})
