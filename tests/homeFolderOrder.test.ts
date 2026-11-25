/**
 * 首页文件夹排 · 拖动排序（2026-11-25 用户需求）的纯函数真值表 + 源码守卫。
 *
 * 范式与 `tests/homePinnedWiring.test.ts` 一致：`vitest` 跑在 node 环境（无 DOM），
 * 行为归 `src/shared/homeFolderOrder.ts` 的纯函数，UI 只守"关键接线点有没有接上"。
 *
 * | # | 守卫 | 防的退化 |
 * |---|------|----------|
 * | 1 | 归一化：脏值丢弃 / 去重保序 / 64 封顶 / 未知键保留 | 手改档把脏值带进渲染 / 顺序表爆长 |
 * | 2 | 排序：按 order 排 + 缺失追加 + 虚卡恒末尾 | 新钉选的卡消失 / 虚卡跑到最前 |
 * | 3 | 移动：左右移动 + 越界夹取 | 拖到最左/最右丢卡 |
 * | 4 | 落点判定 / 让位真值表 | 拖到最右时最后一张不让位 |
 * | 5 | 合入既有 order：非可见键原地不动 | 0 素材分类 / 已删钉选的位置信息被冲掉 |
 * | 6 | HomeCover 用 Pointer Events + 阈值 + 吞 click | 退回 HTML5 DnD / 拖完误翻开 |
 * | 7 | App 落位后写 `homeFolderOrder`（且失败要回滚） | 顺序只在内存里 / 失败后界面不回头 |
 * | 8 | 虚卡不可拖 | 把「新建项目」拖进排序 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HOME_NEW_PROJECT_SLOT_KEY,
  MAX_HOME_FOLDER_ORDER,
  applyHomeFolderOrder,
  buildHomeFolderSlots,
  dragSlotShift,
  homeKindFolderKey,
  homePinFolderKey,
  moveHomeFolderKey,
  nearestSlotIndex,
  normalizeHomeFolderOrder,
  sortHomeFolderSlots,
  type HomeFolderSlot
} from '../src/shared/homeFolderOrder'

/** 相对仓库根读源码，换行归一（工作区 CRLF，切片断言不能被换行符干扰）。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 剥注释：本仓注释里就写着要防的东西（如"不要用 HTML5 DnD"），不剥会误判。 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const KIND_MODEL = homeKindFolderKey('model')
const KIND_CAD = homeKindFolderKey('cad')
const KIND_MATERIAL = homeKindFolderKey('materialGroup')
const PIN_A = homePinFolderKey('pin-a')
const PIN_B = homePinFolderKey('pin-b')

/** 取渲染槽位的键序列（把排序结果摊平成好断言的字符串数组） */
function keysOf(slots: readonly HomeFolderSlot[]): string[] {
  return slots.map((slot) => slot.key)
}

describe('归一化 · normalizeHomeFolderOrder', () => {
  it('非数组 / null / 字符串 → 空表（= 默认排布）', () => {
    expect(normalizeHomeFolderOrder(undefined)).toEqual([])
    expect(normalizeHomeFolderOrder(null)).toEqual([])
    expect(normalizeHomeFolderOrder('kind:model')).toEqual([])
    expect(normalizeHomeFolderOrder({ 0: 'kind:model' })).toEqual([])
  })

  it('脏值丢弃：非字符串 / 空串 / 纯空白', () => {
    expect(
      normalizeHomeFolderOrder([KIND_MODEL, null, 3, '', '   ', {}, [], KIND_CAD])
    ).toEqual([KIND_MODEL, KIND_CAD])
  })

  it('去重保序：同一个槽位只留先出现的那条', () => {
    expect(normalizeHomeFolderOrder([PIN_A, KIND_MODEL, PIN_A, KIND_MODEL])).toEqual([
      PIN_A,
      KIND_MODEL
    ])
  })

  it(`封顶 ${MAX_HOME_FOLDER_ORDER} 条（先出现的更可信）`, () => {
    const raw = Array.from({ length: MAX_HOME_FOLDER_ORDER + 10 }, (_, i) => `pin:p${i}`)
    const out = normalizeHomeFolderOrder(raw)
    expect(out).toHaveLength(MAX_HOME_FOLDER_ORDER)
    expect(out[0]).toBe('pin:p0')
    expect(out[out.length - 1]).toBe(`pin:p${MAX_HOME_FOLDER_ORDER - 1}`)
  })

  it('未知键保留：不属于 kind: / pin: 的键也原样留着（删了 pin 再钉回来还能恢复位置）', () => {
    expect(normalizeHomeFolderOrder([PIN_A, 'legacy:whatever', KIND_MODEL])).toEqual([
      PIN_A,
      'legacy:whatever',
      KIND_MODEL
    ])
  })

  it('首尾空白会被 trim（手改档写了 " kind:model " 也能认）', () => {
    expect(normalizeHomeFolderOrder([' kind:model '])).toEqual([KIND_MODEL])
  })
})

describe('排序 · sortHomeFolderSlots', () => {
  const slots = buildHomeFolderSlots(
    ['model', 'cad', 'materialGroup'],
    ['pin-a', 'pin-b'],
    true
  )

  it('默认（空 order）= 大类在前、钉选在后、虚卡末尾', () => {
    expect(keysOf(sortHomeFolderSlots(slots, []))).toEqual([
      KIND_MODEL,
      KIND_CAD,
      KIND_MATERIAL,
      PIN_A,
      PIN_B,
      HOME_NEW_PROJECT_SLOT_KEY
    ])
  })

  it('按 order 排：钉选可以排到素材卡前面（统一排序口径）', () => {
    const out = sortHomeFolderSlots(slots, [PIN_B, KIND_CAD, PIN_A])
    expect(keysOf(out)).toEqual([
      PIN_B,
      KIND_CAD,
      PIN_A,
      KIND_MODEL,
      KIND_MATERIAL,
      HOME_NEW_PROJECT_SLOT_KEY
    ])
  })

  it('缺失键按默认顺序追加到末尾 —— 新增的文件夹不会消失', () => {
    const out = sortHomeFolderSlots(slots, [PIN_A])
    expect(keysOf(out)).toEqual([
      PIN_A,
      KIND_MODEL,
      KIND_CAD,
      KIND_MATERIAL,
      PIN_B,
      HOME_NEW_PROJECT_SLOT_KEY
    ])
  })

  it('虚卡恒末尾：哪怕 order 里（脏值）写了虚卡键也不动它', () => {
    const out = sortHomeFolderSlots(slots, [HOME_NEW_PROJECT_SLOT_KEY, PIN_B])
    expect(out[out.length - 1]?.key).toBe(HOME_NEW_PROJECT_SLOT_KEY)
    expect(out.filter((slot) => slot.type === 'newProject')).toHaveLength(1)
  })

  it('不传虚卡时就不生成虚卡槽位', () => {
    const noVirtual = buildHomeFolderSlots(['model'], [], false)
    expect(keysOf(sortHomeFolderSlots(noVirtual, []))).toEqual([KIND_MODEL])
  })
})

describe('移动 · moveHomeFolderKey', () => {
  const keys = [KIND_MODEL, KIND_CAD, PIN_A, PIN_B]

  it('右移一格（相邻交换）', () => {
    expect(moveHomeFolderKey(keys, KIND_MODEL, 1)).toEqual([KIND_CAD, KIND_MODEL, PIN_A, PIN_B])
  })

  it('左移一格', () => {
    expect(moveHomeFolderKey(keys, PIN_A, 1)).toEqual([KIND_MODEL, PIN_A, KIND_CAD, PIN_B])
  })

  it('拖到最左 / 最右', () => {
    expect(moveHomeFolderKey(keys, PIN_B, -5)).toEqual([PIN_B, KIND_MODEL, KIND_CAD, PIN_A])
    expect(moveHomeFolderKey(keys, KIND_MODEL, 99)).toEqual([KIND_CAD, PIN_A, PIN_B, KIND_MODEL])
  })

  it('目标就是原位 → 原样返回（新数组，引用变了以便调用方比较）', () => {
    const out = moveHomeFolderKey(keys, KIND_CAD, 1)
    expect(out).toEqual(keys)
    expect(out).not.toBe(keys)
  })

  it('key 不在表里 / 传入 NaN → 原样返回（不插幽灵键）', () => {
    expect(moveHomeFolderKey(keys, 'pin:ghost', 0)).toEqual(keys)
    expect(moveHomeFolderKey(keys, KIND_MODEL, Number.NaN)).toEqual(keys)
  })
})

describe('落点判定 · nearestSlotIndex', () => {
  const centers = [100, 300, 500]

  it('按最近中心取下标（含两侧越界夹取）', () => {
    expect(nearestSlotIndex(centers, -999)).toBe(0)
    expect(nearestSlotIndex(centers, 100)).toBe(0)
    expect(nearestSlotIndex(centers, 260)).toBe(1)
    expect(nearestSlotIndex(centers, 401)).toBe(2)
    expect(nearestSlotIndex(centers, 9999)).toBe(2)
  })

  it('空列表 → 0（不可能抛错）', () => {
    expect(nearestSlotIndex([], 42)).toBe(0)
  })
})

describe('让位真值表 · dragSlotShift', () => {
  it('右拖：源与目标之间的卡左移一格，其余不动', () => {
    // from 0 → to 2：1、2 左移；源卡自己 0；3 不动
    expect([0, 1, 2, 3].map((i) => dragSlotShift(0, 2, i))).toEqual([0, -1, -1, 0])
  })

  it('左拖：目标与源之间的卡右移一格', () => {
    // from 3 → to 1：1、2 右移；源卡自己 0；0 不动
    expect([0, 1, 2, 3].map((i) => dragSlotShift(3, 1, i))).toEqual([0, 1, 1, 0])
  })

  it('没换位 → 全员不动', () => {
    expect([0, 1, 2].map((i) => dragSlotShift(2, 2, i))).toEqual([0, 0, 0])
  })
})

describe('合入既有 order · applyHomeFolderOrder', () => {
  it('只重排可见槽位，非可见键原地不动', () => {
    // 旧表里 kind:other 现在 0 素材（不可见），它的位置必须保留；
    // PIN_B 也不在本次可见集合里 → 原位不动。
    const previous = [KIND_MODEL, 'kind:other', PIN_A, PIN_B]
    const out = applyHomeFolderOrder(previous, [PIN_A, KIND_MODEL])
    expect(out).toEqual([PIN_A, 'kind:other', KIND_MODEL, PIN_B])
  })

  it('旧表里没有的可见键追加到末尾（首次拖动 / 新加的钉选）', () => {
    expect(applyHomeFolderOrder([], [PIN_B, PIN_A])).toEqual([PIN_B, PIN_A])
    expect(applyHomeFolderOrder([KIND_MODEL], [KIND_MODEL, PIN_A])).toEqual([KIND_MODEL, PIN_A])
  })

  it('去重 + 封顶（脏旧值也能收口）', () => {
    const out = applyHomeFolderOrder([PIN_A, PIN_A], [PIN_A, PIN_A])
    expect(out).toEqual([PIN_A])
  })
})

describe('源码守卫 · HomeCover 拖动接线', () => {
  const cover = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))
  const app = stripComments(readSrc('src/renderer/App.tsx'))

  it('走 Pointer Events + setPointerCapture，不用 HTML5 drag-and-drop', () => {
    expect(cover).toContain('onPointerDown={handleRowPointerDown}')
    expect(cover).toContain('onPointerMove={handleRowPointerMove}')
    expect(cover).toContain('onPointerUp={handleRowPointerUp}')
    expect(cover).toContain('onPointerCancel={handleRowPointerCancel}')
    expect(cover).toContain('setPointerCapture?.(')
    expect(cover).toContain('releasePointerCapture(')
    // 与系统"拖出窗口"抢手势的 HTML5 DnD 一律不许出现
    expect(cover).not.toContain('onDragStart')
    expect(cover).not.toContain('draggable=')
  })

  it('阈值 + 拖动后吞掉 click（拖完不翻开 / 不进入）', () => {
    expect(cover).toContain('DRAG_THRESHOLD_PX')
    expect(cover).toContain('suppressClickRef')
    expect(cover).toContain('onClickCapture={handleRowClickCapture}')
    expect(cover).toContain('onDoubleClickCapture={handleRowClickCapture}')
  })

  it('让位 / 落点走 shared 纯函数（组件内不复制规则）', () => {
    expect(cover).toContain('dragSlotShift(')
    expect(cover).toContain('nearestSlotIndex(')
    expect(cover).toContain('moveHomeFolderKey(')
    expect(cover).toContain('applyHomeFolderOrder(')
    expect(cover).toContain('sortHomeFolderSlots(')
  })

  it('Esc / pointercancel 取消本次拖动（复位、不写档）', () => {
    expect(cover).toContain("event.key !== 'Escape'")
    expect(cover).toContain('finishDrag(false)')
  })

  it('顺序写档只走 saveSettings({ homeFolderOrder })（拖动过程不写）', () => {
    expect(app).toContain('saveSettings({ homeFolderOrder: order })')
    expect(app).toContain('onReorderFolders={reorderHomeFolders}')
    // 失败 → 返回 false + 单行提示（HomeCover 据此回滚乐观顺序）
    expect(app).toContain('保存文件夹顺序失败，已恢复原顺序')
  })
})

describe('源码守卫 · 虚卡不可拖', () => {
  const cover = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))
  const glass = stripComments(readSrc('src/renderer/components/home/GlassFolder.tsx'))

  it('HomeCover 的虚卡 JSX 不带 slotKey（只有两类真卡带）', () => {
    const start = cover.indexOf('<NewProjectFolderCard')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = cover.indexOf('/>', start)
    const jsx = cover.slice(start, end)
    expect(jsx).not.toContain('slotKey')
  })

  it('NewProjectFolderCard 根节点没有 data-slot-key', () => {
    const start = glass.indexOf('export function NewProjectFolderCard')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = glass.slice(start)
    expect(body).not.toContain('data-slot-key')
  })
})

describe('源码守卫 · 退场分半按视觉顺序（data-exit-half）', () => {
  const cover = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))
  const glass = stripComments(readSrc('src/renderer/components/home/GlassFolder.tsx'))
  const outro = stripComments(readSrc('src/renderer/components/home/home-outro.css'))

  it('HomeCover 按排序后的视觉槽位下标写 exitHalf（n 不含虚卡，i < ceil(n/2) 为 left）', () => {
    expect(cover).toContain('exitHalf={slotIndex < exitHalfSplit')
    expect(cover).toContain("slot.type !== 'newProject'")
    expect(cover).toContain('Math.ceil(')
  })

  it('GlassFolder 落 data-exit-half（真卡透传；虚卡恒在末位 → 写死 right）', () => {
    expect(glass).toContain('data-exit-half={exitHalf}')
    expect(glass).toContain('data-exit-half="right"')
  })

  it('home-outro.css 只认 data-exit-half 做左右分半，不再依赖 nth-child 猜 DOM', () => {
    expect(outro).toContain("[data-exit-half='left']")
    expect(outro).toContain("[data-exit-half='right']")
    expect(outro).not.toContain('nth-child')
  })
})
