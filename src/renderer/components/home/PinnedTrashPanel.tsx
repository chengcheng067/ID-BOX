/**
 * 应用内文件浏览器 · 钉选目录「回收站」面板（pinned-trash-ui）。
 *
 * 背景：删除钉选目录里的文件时，本地盘进系统回收站，网络映射盘因系统回收站无效
 * 而由主进程在同盘隐藏回收区保留（带 token，可还原）。本面板只负责渲染层：
 * - 打开时 `listPinnedTrash({pinId})` 拉本钉选目录的可还原条目；
 * - 每条一个「还原」按钮 → `restorePinnedTrash({pinId, token})`；
 * - 原位置有同名项时主进程会自动改名并返回 `renamed:true`，这里明确提示新名字；
 * - **不提供「永久删除」按钮**（铁律：软件不做永久删除）。
 *
 * 纪律与浏览器本体一致：零系统默认控件；颜色 / 圆角 / 字体全走现有 token 与
 * Tailwind 工具类（照确认层风格）；Esc 层栈用 `useEscLayer`，视觉层级由
 * `zClassForDepth` 换算，不写死 z-index。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useEscLayer } from '../../logic/escLayer'
import { zClassForDepth } from '../../logic/zStack'
import { useVault } from '../../store'
import {
  formatSize,
  formatTime,
  pinnedWriteApi,
  WRITE_NOT_READY_NOTICE
} from '../../logic/pinnedBrowser'
import type { PinnedTrashEntry } from '../../../shared/ipc'
import { IconClose, IconTrash } from '../../icons'

export interface PinnedTrashPanelProps {
  /** 钉选 id（决定回收区归属） */
  pinId: string
  /** 关面板（Esc / 点遮罩 / 关闭按钮统一走这里） */
  onClose: () => void
  /** 还原成功后通知父级刷新当前目录列表 */
  onRestored: () => void
}

/** 加载态：loading → ready | error */
type LoadState = 'loading' | 'ready' | 'error'

/** 根目录的 relFolder 为空串，展示成更友好的文案 */
function displayFolder(relFolder: string): string {
  return relFolder.length === 0 ? '根目录' : relFolder
}

/**
 * 回收区面板（自绘 scrim + Esc 栈顶）。
 *
 * ⚠️ `pinnedWriteApi()` 是「所有写方法就绪才返回 API」的探针，面板只在入口处
 * 置灰过；这里再做一次 null 守卫，避免主进程尚未落地时点击抛错。
 */
export function PinnedTrashPanel({
  pinId,
  onClose,
  onRestored
}: PinnedTrashPanelProps): ReactElement {
  const depth = useEscLayer(onClose, true)
  const setNotice = useVault((s) => s.setNotice)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [entries, setEntries] = useState<PinnedTrashEntry[]>([])
  const [error, setError] = useState('')
  const [busyToken, setBusyToken] = useState<string | null>(null)

  /** 拉取回收区列表（首次挂载 + 出错重试共用） */
  const load = useCallback((): void => {
    const api = pinnedWriteApi()
    if (api === null) {
      setError(WRITE_NOT_READY_NOTICE)
      setLoadState('error')
      return
    }
    setLoadState('loading')
    void api
      .listPinnedTrash({ pinId })
      .then((result) => {
        if (result.ok) {
          setEntries(result.entries)
          setError('')
          setLoadState('ready')
        } else {
          setError(result.error)
          setLoadState('error')
        }
      })
      .catch(() => {
        setError('读取回收区失败，请重试')
        setLoadState('error')
      })
  }, [pinId])

  useEffect(() => {
    load()
  }, [load])

  /** 还原单条：成功后从列表移除并通知父级刷新；同名冲突由主进程改名并回传 */
  const restore = useCallback(
    (entry: PinnedTrashEntry): void => {
      const api = pinnedWriteApi()
      if (api === null) {
        setNotice(WRITE_NOT_READY_NOTICE)
        return
      }
      if (busyToken !== null) return
      setBusyToken(entry.token)
      void api
        .restorePinnedTrash({ pinId, token: entry.token })
        .then((result) => {
          if (result.ok) {
            setNotice(
              result.renamed
                ? `原位置已有同名项，已还原为 ${result.name}`
                : `已还原「${result.name}」`
            )
            setEntries((prev) => prev.filter((item) => item.token !== entry.token))
            onRestored()
          } else {
            setNotice(result.error)
          }
        })
        .catch(() => setNotice('还原失败，请重试'))
        .finally(() => setBusyToken(null))
    },
    [busyToken, pinId, onRestored, setNotice]
  )

  return (
    <div
      className={`dialog-scrim fixed inset-0 ${zClassForDepth(depth)} flex items-center justify-center p-6`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[min(80vh,640px)] w-full max-w-[520px] flex-col rounded-modal border border-line bg-surface shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 关闭（照确认层：text-primary 标题 / 自绘按钮） */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-tint text-accent">
              <IconTrash width={16} height={16} />
            </span>
            <h2 className="text-base font-semibold text-primary">回收站</h2>
          </div>
          <button
            type="button"
            className="btn btn-ghost !px-2 !py-1"
            onClick={onClose}
            title="关闭"
          >
            <IconClose width={14} height={14} />
          </button>
        </div>

        {/* 主体：加载 / 错误 / 空态 / 条目列表，四态互斥 */}
        <div className="min-h-[180px] overflow-auto px-5 py-4">
          {loadState === 'loading' ? (
            <p className="py-12 text-center text-[13px] text-muted">正在读取回收区…</p>
          ) : loadState === 'error' ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-[13px] text-danger">{error}</p>
              <button type="button" className="btn" onClick={load}>
                重试
              </button>
            </div>
          ) : entries.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-muted">回收区是空的</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((entry) => (
                <li
                  key={entry.token}
                  className="flex items-center gap-3 rounded-md border border-line bg-pill px-3 py-2.5"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-muted">
                    <IconTrash width={15} height={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-primary" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                      <span className="truncate" title={displayFolder(entry.relFolder)}>
                        原位置：{displayFolder(entry.relFolder)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{formatTime(entry.deletedAt)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatSize(entry.size)}</span>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary !py-1"
                    onClick={() => restore(entry)}
                    disabled={busyToken !== null}
                    title="还原到原位置"
                  >
                    还原
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 脚注：明确不做永久删除（铁律），并给一个自绘关闭出口 */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-[12px] text-muted">软件不做永久删除，条目仅可还原到原位置。</span>
          <button type="button" className="btn shrink-0" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
