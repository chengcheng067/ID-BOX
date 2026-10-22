import { useVault } from '../store'
import { fileMenuItems } from '../logic/contextMenu'
import { ContextMenu } from './ContextMenu'
import type { FileRow } from '../logic/fileView'

/**
 * 文件行右键菜单（中栏「软件内文件夹视图」里的一行 / 一张文件卡）。
 *
 * 用户口径（本轮）：「卡片允许右键，那每一个界面的右键菜单有哪些功能你来设置」。
 * 文件夹视图在此之前**完全没有右键**——想「用别的程序打开某个贴图」只能先双击
 * （而双击用的是系统默认程序），想复制路径得回资产卡片右键拿文件夹路径。
 *
 * 五项的分工（刻意很窄，文件不是资产，不能在这里删 / 分类）：
 * - 打开 / 定位：交给系统（`openPath` / `reveal`），与双击同一条 IPC；
 * - 设为封面：把这张图升级成**该资产**的封面（`setCover`，与详情面板同一个入口）；
 * - 复制：文件名 / 完整路径。
 */
export function FileContextMenu({
  x,
  y,
  assetId,
  row,
  onClose
}: {
  x: number
  y: number
  /** 该文件所属的资产（设封面要用） */
  assetId: string
  row: FileRow
  onClose: () => void
}) {
  const setCover = useVault((s) => s.setCover)
  const setNotice = useVault((s) => s.setNotice)

  const items = fileMenuItems(row, {
    /**
     * 与 `AssetGrid.openFileRow` 逐字同口径：main 返回错误文案（空串已归一成 null）
     * 就落一条 notice —— 否则「点了没反应」会被当成 bug。
     */
    onOpen: () => {
      window.modvault
        .openPath(row.absPath)
        .then((err) => {
          if (err) setNotice(`打开失败：${err}`)
        })
        .catch(() => setNotice('打开失败：找不到可打开该文件的程序'))
    },
    onReveal: () => {
      void window.modvault.reveal(row.absPath)
    },
    onSetCover: () => {
      void setCover(assetId, row.rel)
        .then(() => setNotice('已设为封面'))
        .catch(() => setNotice('设置封面失败：请换一张图片再试'))
    },
    onCopyName: () => {
      void navigator.clipboard
        .writeText(row.name)
        .then(() => setNotice('已复制文件名'))
        .catch(() => setNotice('复制失败：系统剪贴板不可用'))
    },
    onCopyPath: () => {
      void navigator.clipboard
        .writeText(row.absPath)
        .then(() => setNotice('已复制完整路径'))
        .catch(() => setNotice('复制失败：系统剪贴板不可用'))
    }
  })

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} minWidth={190} />
}
