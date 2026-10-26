import { useRef, useState } from 'react'
import { useVault } from '../store'
import { revealTargetFor } from '../logic/assetPath'
import { duplicatesOf, groupOf } from '../logic/duplicates'
import { assetMenuItems } from '../logic/contextMenu'
import { effectiveMaterialSlots } from '../logic/materialBall'
import { undoGraceHint } from '../logic/graceText'
import { DEFAULT_UNDO_GRACE_MS } from '../../shared/undoGrace'
import { ContextMenu } from './ContextMenu'
import { CoverPicker } from './CoverPicker'
import { CustomRenderDialog } from './CustomRenderDialog'

/**
 * 资产卡片右键菜单。
 *
 * 2026-10-21 走查 P2⑧：原先只有 3 项（指派分类 / 在资源管理器中显示 / 删除）且**没有图标**，
 * 一列纯文字难扫读，「只是想收藏一下」还得绕到卡片右上角找星标 → 补图标与高频动作。
 *
 * 2026-10-13（本轮 · 右键菜单体系）：菜单项构成与判定**全部搬到**
 * `logic/contextMenu.ts` 的纯函数里（可单测），本组件只负责三件事：
 * ① 从 store 取动作并注入纯函数；
 * ② 把返回的 item 数组交给共用外壳 `ContextMenu` 渲染；
 * ③ 承接两个**弹窗类**项（更换封面 / 自定义渲染）—— 直接复用既有弹窗组件，
 *    不新造任何界面。
 *
 * ⚠️ 导出签名 `{ x, y, ids, onClose }` **不能改**：`AssetGrid` 的调用点依赖它
 * （`tests/contextMenu.test.ts` 有源码守卫）。
 */
export function AssetContextMenu({
  x,
  y,
  ids,
  onClose
}: {
  x: number
  y: number
  ids: string[]
  onClose: () => void
}) {
  const assets = useVault((s) => s.assets)
  const openCategoryPicker = useVault((s) => s.openCategoryPicker)
  const requestDelete = useVault((s) => s.requestDelete)
  const setFavorite = useVault((s) => s.setFavorite)
  const setNotice = useVault((s) => s.setNotice)
  const openFolderView = useVault((s) => s.openFolderView)
  const openHdrPreview = useVault((s) => s.openHdrPreview)
  // 删除撤销期（设置·数据与备份，三档 0 / 3000 / 5000）：提示文案必须跟着设置走，
  // 不能写死「5 秒内可撤销」——否则用户把撤销期设成 3 秒 / 不等待时提示会自相矛盾。
  const undoGraceMs = useVault((s) => s.settings?.undoGraceMs ?? DEFAULT_UNDO_GRACE_MS)

  /**
   * 菜单打开期间要接管的两个既有弹窗：`null` = 都关着（显示菜单本身）。
   *
   * 为什么弹窗挂在**这里**而不是 `AssetGrid`：`AssetContextMenu` 的 props 被锁定为
   * `{x,y,ids,onClose}`（调用点不能改），没有通道把"点了更换封面"这件事传回网格。
   * 这里直接渲染 `<CoverPicker>` / `<CustomRenderDialog>` —— 就是详情面板用的那两个
   * 组件（同样的 props），没有任何新弹窗。
   */
  const [dialog, setDialog] = useState<'cover' | 'render' | null>(null)
  /**
   * 「刚点了弹窗项」的同步标记。
   *
   * `ContextMenu` 在每次点击后都会调 `onClose()`；如果照单全收，外层会把整个菜单
   * 卸载掉 → 刚 `setDialog` 的那个弹窗跟着消失（连一帧都看不到）。
   * `onClick` 比 `onClose` 先执行，所以用 ref 在同步段打标，`closeMenu` 见到标记就
   * 只清标记、不上报 —— 菜单改由 `dialog` 分支接管渲染。
   */
  const openingDialog = useRef(false)
  const openDialog = (kind: 'cover' | 'render'): void => {
    openingDialog.current = true
    setDialog(kind)
  }
  const closeMenu = (): void => {
    if (openingDialog.current) {
      openingDialog.current = false
      return
    }
    onClose()
  }

  if (ids.length === 0) return null

  const targets = assets.filter((a) => ids.includes(a.id))
  if (targets.length === 0) return null

  const single = targets.length === 1 ? targets[0] : null

  /** 弹窗分支：先于菜单判断，菜单在弹窗打开期间不再渲染（避免两层浮层叠着） */
  if (single && dialog === 'cover') {
    return (
      <CoverPicker
        asset={single}
        onClose={() => {
          setDialog(null)
          onClose()
        }}
      />
    )
  }
  if (single && dialog === 'render') {
    return (
      <CustomRenderDialog
        asset={single}
        slots={effectiveMaterialSlots(single.files)}
        onClose={() => {
          setDialog(null)
          onClose()
        }}
      />
    )
  }

  /** 「打开文件位置」的目标：单选定位到主文件，多选退回第一个所在文件夹（既有口径） */
  const revealTarget = single ? revealTargetFor(single) : targets[0].folder
  /** 「保留这份」要删的副本（不含自己）+ 该组的体积差异警示 */
  const dupCopies = single ? duplicatesOf(assets, single.id) : []

  const items = assetMenuItems(assets, ids, {
    onEnterFolder: () => {
      if (single) openFolderView(single.id)
    },
    onPreviewHdr: () => {
      if (single) openHdrPreview(single.id)
    },
    onReveal: () => {
      void window.modvault.reveal(revealTarget)
    },
    onChangeCover: () => openDialog('cover'),
    onCustomRender: () => openDialog('render'),
    onAssignCategory: () => openCategoryPicker(ids),
    onToggleFavorite: (next) => {
      void setFavorite(ids, next)
    },
    onCopyName: () => {
      if (!single) return
      // 复制的是**库里的真实资产名**（`a.name`），不是别名显示名 —— 别名只改显示，
      // 用户拿这个名字去搜磁盘 / 搜索框都得能对上。
      void navigator.clipboard
        .writeText(single.name)
        .then(() => setNotice('已复制资产名'))
        .catch(() => setNotice('复制失败：系统剪贴板不可用'))
    },
    onCopyFolderPath: () => {
      // 复制的是**绝对文件夹路径**（资源管理器地址栏可直接粘贴）。剪贴板在个别
      // 环境会拒绝（无 secure context / 权限策略），失败必须给反馈，不能静默。
      const text =
        targets.length === 1 ? targets[0].folder : targets.map((a) => a.folder).join('\r\n')
      void navigator.clipboard
        .writeText(text)
        .then(() =>
          setNotice(targets.length === 1 ? '已复制文件夹路径' : `已复制 ${targets.length} 条路径`)
        )
        .catch(() => setNotice('复制失败：系统剪贴板不可用'))
    },
    onKeepThis: () => {
      if (!single || dupCopies.length === 0) return
      // 复用详情面板那条既有链路（二次确认 → 撤销期 → trashPaths），不自己写 trash。
      // 体积差异大时确认框额外警示（误删大体积原件的代价很高）。
      requestDelete(
        dupCopies.map((c) => c.id),
        {
          warning: groupOf(assets, single.id)?.sizeMismatch
            ? '体积差异较大，请先确认是同一套资产'
            : undefined,
          // 文案随设置变：5 秒 / 3 秒 / 不等待（0 = 没有撤销期）
          notice: undoGraceHint(undoGraceMs)
        }
      )
    },
    onDelete: () => requestDelete(ids)
  })

  return <ContextMenu x={x} y={y} items={items} onClose={closeMenu} />
}
