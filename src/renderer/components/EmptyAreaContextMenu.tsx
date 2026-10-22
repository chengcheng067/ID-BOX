import { useVault } from '../store'
import { clearFilterPatch, emptyMenuItems, rescanNoticeOf } from '../logic/contextMenu'
import { ContextMenu } from './ContextMenu'

/**
 * 空白处右键菜单（**所有视图**共用：全部 / 模型 / 材质 / HDR / 收藏 / 重复 / 最近删除 / 文件夹视图）。
 *
 * 用户原话：「在所有的界面的空界面右键都增加刷新按钮」。
 *
 * 关于「刷新」用 `forceRescan` 而不是 `rescan`：用户点这个按钮的语境是
 * 「我刚往库里拖了东西 / 我手动改了目录，界面没变」——此时常规重扫的
 * 「扫描结果骤减就中止」守卫会把他挡在门外（他自己清楚刚做了什么）。
 * 但 `forceRescan` **仍然会先落备份**（force 不等于不救），且中止/失败一定有 notice。
 */
export function EmptyAreaContextMenu({
  x,
  y,
  onClose
}: {
  x: number
  y: number
  onClose: () => void
}) {
  const filters = useVault((s) => s.filters)
  const setFilter = useVault((s) => s.setFilter)
  const forceRescan = useVault((s) => s.forceRescan)
  const setNotice = useVault((s) => s.setNotice)

  const items = emptyMenuItems(filters, {
    onRefresh: () => {
      // 先给"我收到了"的即时反馈：全库重扫是秒级到分钟级的活，没有提示会像卡死
      setNotice('正在重新扫描本地库…')
      void forceRescan()
        .then((outcome) => setNotice(rescanNoticeOf(outcome)))
        .catch((err: unknown) => {
          // 失败必须如实说（含原因），不能静默 —— 静默时用户会以为库里的东西丢了
          const reason = err instanceof Error ? err.message : String(err)
          setNotice(`刷新失败：${reason || '未知错误'}`)
        })
    },
    onClearFilters: () => setFilter(clearFilterPatch(filters))
  })

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} minWidth={176} />
}
