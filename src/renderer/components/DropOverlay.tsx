import { IconDownload } from '../icons'

/** 全窗拖拽提示：拖着文件进窗口时显示（⛔ 规范禁玻璃拟态，不用 backdrop-blur） */
export function DropOverlay({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-accent/10">
      <div className="flex flex-col items-center gap-3 rounded-modal border-2 border-dashed border-accent/60 bg-card px-16 py-12 shadow-modal">
        <div className="text-accent">
          <div className="scale-[2.5]">
            <IconDownload />
          </div>
        </div>
        <div className="text-base font-semibold">松手即导入</div>
        <div className="text-xs text-muted">自动解压 → 分类归档 → 原包进回收站（支持 zip / rar / 7z，也可拖入已解压的文件夹）</div>
      </div>
    </div>
  )
}
