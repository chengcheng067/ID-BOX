/**
 * `shared/classifyAsset.classifyAssetName` 单测（v1.0.13）。
 *
 * 这个函数是「导入预分类」与「设置页重跑自动分类」的**唯一**判定实现，抽到 shared 的
 * 目的就是不让两份逻辑漂移。本组钉两件事：
 * ① 与 v1.0.12 导入侧行为逐字一致（真实文件名回归）；
 * ② `fileNames` / `kind` 两个入参确实被透传到匹配器与闸门。
 */
import { describe, expect, it } from 'vitest'
import { classifyAssetName } from '../src/shared/classifyAsset'
import { UNCLASSIFIED } from '../src/shared/taxonomy'

describe('classifyAssetName — 真实文件名（与导入侧同一份实现）', () => {
  it('传薇佳画_挂画组合ID_1186414883（model）→ 软装陈设/挂画', () => {
    expect(classifyAssetName('传薇佳画_挂画组合ID_1186414883', undefined, 'model')).toEqual({
      category1: '软装陈设',
      category2: '挂画'
    })
  })

  it('无堺黑色木纹ID_1151853396（material）→ 木纹/未分类（一级保住，二级哨兵）', () => {
    expect(classifyAssetName('无堺黑色木纹ID_1151853396', undefined, 'material')).toEqual({
      category1: '木纹',
      category2: UNCLASSIFIED
    })
  })

  it('现代仿古砖ID_1100000001（material）→ 砖材/仿古砖', () => {
    expect(classifyAssetName('现代仿古砖ID_1100000001', undefined, 'material')).toEqual({
      category1: '砖材',
      category2: '仿古砖'
    })
  })

  it('北欧挂画（texture）→ 挂画/未分类（二级被闸门拒 → 一级回退生效）', () => {
    expect(classifyAssetName('北欧挂画', undefined, 'texture')).toEqual({
      category1: '挂画',
      category2: UNCLASSIFIED
    })
  })

  it('屏风贴图（texture）→ 双未分类（真跨频道，一级回退也失败）', () => {
    expect(classifyAssetName('屏风贴图', ['屏风贴图.jpg'], 'texture')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
  })
})

describe('classifyAssetName — 入参透传', () => {
  it('fileNames 参与二级匹配（资产名无词，包内图片名有词）', () => {
    expect(classifyAssetName('pack-2026', ['预览图.jpg', '人字拼木地板.jpg'], 'texture')).toEqual({
      category1: '木地板',
      category2: '人字拼木地板'
    })
  })

  it('fileNames 省略 / 空数组都不崩，退回只看资产名', () => {
    expect(classifyAssetName('沙发', undefined, 'model')).toEqual({
      category1: '家具',
      category2: '沙发'
    })
    expect(classifyAssetName('沙发', [], 'model')).toEqual({
      category1: '家具',
      category2: '沙发'
    })
  })

  it('同名词在不同 kind 下判出不同结果（kind 真的进了闸门）', () => {
    // `北欧挂画`：model 下二级 软装陈设/挂画 直接放行；texture 下只能拿一级 挂画。
    expect(classifyAssetName('北欧挂画', undefined, 'model')).toEqual({
      category1: '软装陈设',
      category2: '挂画'
    })
    expect(classifyAssetName('北欧挂画', undefined, 'texture')).toEqual({
      category1: '挂画',
      category2: UNCLASSIFIED
    })
    // 无一级词表的 kind → 命中即丢弃
    expect(classifyAssetName('北欧挂画', undefined, 'hdri')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
  })
})
