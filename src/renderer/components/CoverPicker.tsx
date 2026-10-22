import { useEffect, useRef, useState } from 'react'
import { useVault } from '../store'
import { vaultUrl } from '../../shared/format'
import {
  coverImageInputOf,
  firstImageFileOfClipboard,
  firstImageFileOfDataTransfer
} from '../logic/coverImage'
import type { Asset } from '../../shared/types'
import { Modal } from './Modal'

/** 封面候选 = 资产内全部贴图 / HDRI 文件（P0-8：手动换封面只在这类图片里选） */
function coverCandidates(asset: Asset) {
  return asset.files.filter((f) => f.kind === 'texture' || f.kind === 'hdri')
}

/** dragenter/dragover 里是否拖着文件（text/plain 等非文件拖拽不高亮） */
function hasFilesInDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types ?? []).includes('Files')
}

/** paste 事件目标是不是文本输入区（在输入框里 Ctrl+V 不能当贴封面） */
function isTextEntryTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true
}

/**
 * 手动换封面弹窗（P0-8 + 2026-10 装机反馈任务 3）。
 *
 * 三个图片来源：
 * ① **剪贴板粘贴**——弹窗打开期间监听 window `paste`，取 clipboardData.items
 *    里的图片（用户截图后直接 Ctrl+V，正是「截图扔进软件」的场景）；
 * ② **拖入**——整张弹窗都是放置区，拖一张图片进来松手即设；
 * ③ **选择本地文件**——隐藏的 `<input type="file">`。
 * 加上原有的「资产内图片」网格，四种方式最终都汇到
 * `setCoverFromImage` / `setCover`（coverSource='manual' + 缩略图重生）。
 *
 * 注意：网格里这些是**详情级原图**（vault://asset/...），单个资产的候选量有限，
 * 可以接受；资产网格本体仍然只准读缩略图（性能陷阱 C4）。
 */
export function CoverPicker({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const setCover = useVault((s) => s.setCover)
  const setCoverFromImage = useVault((s) => s.setCoverFromImage)
  const candidates = coverCandidates(asset)
  const [selected, setSelected] = useState<string | null>(asset.cover ?? null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 选中项必须是候选里真实存在的文件（派生校验，无需 effect）
  const selectedRel = selected && candidates.some((f) => f.rel === selected) ? selected : null

  // ① 剪贴板粘贴：弹窗打开期间生效；在输入框里粘贴文本时不拦截
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (busy || isTextEntryTarget(e.target)) return
      const file = firstImageFileOfClipboard(e.clipboardData)
      if (!file) return
      e.preventDefault()
      void applyFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, asset.id])

  /** 三个外部来源 + 内部网格共用的落点：IPC 落盘 → setCover 收尾 */
  const applyFile = async (file: File) => {
    if (busy) return
    setBusy(true)
    try {
      const input = await coverImageInputOf(file)
      if (!input) {
        useVault.setState({ notice: '只支持 PNG/JPEG 图片' })
        return
      }
      await setCoverFromImage(asset.id, input)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    // 与 DetailPanel 封面区同理：阻断冒泡，防止 App 的全窗拖入导入监听把图当包导入
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (busy) return
    const file = firstImageFileOfDataTransfer(e.dataTransfer)
    if (file) void applyFile(file)
  }

  const externalSources = (
    <div
      className={`rounded-lg border-2 border-dashed p-3 text-center transition ${
        dragOver ? 'border-accent bg-accent-tint/40' : 'border-line'
      }`}
      onDragEnter={(e) => {
        if (hasFilesInDrag(e.dataTransfer)) {
          e.stopPropagation() // 别让 App 的全窗拖入遮罩同时弹出
          setDragOver(true)
        }
      }}
      onDragOver={(e) => {
        if (hasFilesInDrag(e.dataTransfer)) {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          className="btn"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          title="从本地选择一张图片（PNG/JPEG，≤20MB）"
        >
          选择本地文件
        </button>
        <span className="text-[12px] text-muted">
          或直接 <b className="text-primary">Ctrl+V</b> 粘贴截图 / 把图片拖进这里
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = '' // 允许再次选同一文件
          if (f) void applyFile(f)
        }}
      />
      {busy && <div className="mt-2 text-[12px] text-muted">正在写入并生成缩略图…</div>}
    </div>
  )

  if (candidates.length === 0) {
    // 资产内没有图片（纯 skp 包等）——不再是死路：外部三来源照样能设封面
    return (
      <Modal title="更换封面" onClose={onClose} width="max-w-md">
        <p className="mb-3 py-2 text-center text-sm text-muted">
          这个资产里没有可选的图片，但你可以把截图或本地图片设成封面：
        </p>
        {externalSources}
        <div className="mt-4 flex justify-end">
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
        </div>
      </Modal>
    )
  }

  const confirm = async () => {
    if (!selectedRel || busy) return
    setBusy(true)
    await setCover(asset.id, selectedRel).catch(() => undefined)
    setBusy(false)
    onClose()
  }

  return (
    <Modal title="更换封面" onClose={onClose} width="max-w-2xl">
      <div className="mb-3">{externalSources}</div>
      <p className="mb-3 text-[12px] text-muted">
        或从资产内的 {candidates.length} 张图片中选择一张作为封面（含子目录）。
      </p>
      <div className="grid max-h-[50vh] grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 overflow-auto">
        {candidates.map((f) => (
          <button
            key={f.rel}
            onClick={() => setSelected(f.rel)}
            title={f.rel}
            className={`group relative overflow-hidden rounded-lg border bg-canvas transition ${
              selectedRel === f.rel ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-accent/40'
            }`}
          >
            <img
              src={vaultUrl(`${asset.relFolder}/${f.rel}`)}
              alt={f.name}
              loading="lazy"
              className="aspect-square w-full object-cover"
            />
            <span className="absolute bottom-0 left-0 right-0 truncate bg-black/45 px-1.5 py-0.5 text-left text-[10px] text-white">
              {f.name}
            </span>
            {selectedRel === f.rel && (
              <span className="absolute right-1 top-1 rounded bg-accent px-1 text-[10px] text-white">当前</span>
            )}
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button className="btn btn-primary" onClick={() => void confirm()} disabled={!selectedRel || busy}>
          {busy ? '生成缩略图…' : '设为封面'}
        </button>
      </div>
    </Modal>
  )
}
