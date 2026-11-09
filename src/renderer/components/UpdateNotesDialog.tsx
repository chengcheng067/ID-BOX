/**
 * 「发现新版本」弹窗 —— 把 GitHub Release 的**发布说明**渲染给用户看（2026-11）。
 *
 * 用户需求：「idbox 现在不是有检测新版本的能力嘛，它能自己去 GitHub 的 releases note
 * 上把更新内容扒下来，然后在我们的软件里弹窗给用户显示更新内容」。
 *
 * 三条设计纪律（改这个文件前请先读完）：
 *
 * 1. **绝不 `dangerouslySetInnerHTML`**。`info.notes` 是外部输入（谁有仓库权限谁就能写），
 *    渲染进程拿着 `window.modvault`（读写库文件 / `openExternal` / `openPath`），
 *    一次 HTML 注入就等于把本机交出去。本文件的所有文本都通过 React 文本插值进入 DOM
 *    （自动转义）；结构由 `logic/releaseNotes.ts` 的 token 数组决定，本文件只做 map。
 *
 * 2. **点链接 = 交给系统浏览器**，绝不在应用内导航：主进程**没有** `will-navigate` /
 *    `setWindowOpenHandler` 兜底，所以本文件连 `<a href>` 都不产出（用 `<button>`
 *    + `openExternal`）—— 没有 href 就没有"默认导航"这条路径，也就不可能靠漏写
 *    `preventDefault` 把整个界面导航走。`onClick` 里仍然 `preventDefault()`，双保险。
 *
 * 3. **Esc = 稍后**：走 `useEscLayer`（与设置 / 预览等自绘弹窗同一套层栈），
 *    不用手写 keydown —— 手写会和 App 的全局 Esc 抢键，一次按键关两层。
 *
 * 交互（已拍板）：「稍后」= 本次启动不再弹；「跳过这个版本」= 该版本永不再弹。
 * 两个动作的语义与持久化都在 `logic/updateState.ts`（`dismissUpdateDialog` /
 * `skipUpdateVersion`），本文件只负责调用。
 */
import { useEffect, useRef } from 'react'
import { parseInline, parseReleaseNotes } from '../logic/releaseNotes'
import type { InlineSpan, NotesBlock } from '../logic/releaseNotes'
import { dismissUpdateDialog, skipUpdateVersion, useUpdateState } from '../logic/updateState'
import { useEscLayer } from '../logic/escLayer'
import { zClassForDepth } from '../logic/zStack'

/**
 * 用系统默认浏览器打开外链（**唯一**的打开方式，与设置页「去下载」逐字一致）。
 *
 * 三道兜底：桥不存在（老 preload / 非 Electron）→ 静默返回；`openExternal` 不存在
 * （老版本 preload）→ 静默返回；Promise reject（系统无默认浏览器）→ 静默吞掉。
 * 全是"点了没反应"，但**绝不**降级成 `location.href`（那会把界面导航走）。
 *
 * 真正的协议白名单校验在主进程（`shared/urlPolicy.ts` 的 `resolveExternalUrl`）；
 * 本层 `parseInline` 已经把非 http(s) 的 href 降级成纯文本，两道都不放行才真的打不开。
 */
function openExternalSafe(url: string): void {
  try {
    const api = window.modvault
    if (!api || typeof api.openExternal !== 'function') return
    void api.openExternal(url).catch(() => undefined)
  } catch {
    // 桥缺失 / 调用同步抛错：静默（弹窗不该因为一个外链打不开而崩）
  }
}

/**
 * 把 ISO 时间格式化成本地时区的 `YYYY-MM-DD`。
 *
 * 为什么不用 `toLocaleDateString()`：它受系统 locale 影响（可能给出 `2026/11/9`、
 * `11/9/2026`），同一个界面在不同机器上形状不一致；这里要的是稳定的中文语境短日期。
 * 无效 / 空值返回空串（调用方据此决定整段要不要显示）。
 */
function formatPublishedAt(iso: string | null): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 行内 token → React 节点（`parseInline` 的唯一消费点）。
 *
 * - `strong`：`font-semibold text-primary`（正文用 secondary，粗体提亮，层次靠明度）；
 * - `code`：`bg-elevated` 底 + `text-primary` 字（对比度见交付报告）；
 * - `link`：`<button>` + 常驻下划线。**颜色刻意不用 accent-text**：浅色档
 *   `#007aff` 在白底上只有 4.02:1（< WCAG AA 的 4.5:1），而正文级字号必须达标；
 *   这里用 `text-primary`（浅 14.7:1 / 深 15.2:1）+ accent 下划线提供可点击暗示，
 *   hover 才转 accent-text。没有新造任何色值。
 * - `text`：原样插值（HTML 标签在这里只是可见字符，不会进 DOM 结构）。
 */
function InlineText({ text }: { text: string }) {
  const spans: InlineSpan[] = parseInline(text)
  return (
    <>
      {spans.map((span, index) => {
        if (span.type === 'strong') {
          return (
            <strong key={index} className="font-semibold text-primary">
              {span.text}
            </strong>
          )
        }
        if (span.type === 'code') {
          return (
            <code
              key={index}
              className="rounded-[4px] bg-elevated px-1 py-[1px] text-[11.5px] text-primary"
            >
              {span.text}
            </code>
          )
        }
        if (span.type === 'link') {
          return (
            <button
              key={index}
              type="button"
              title={span.href}
              className="inline cursor-pointer text-left align-baseline text-primary underline decoration-accent/70 decoration-1 underline-offset-2 transition hover:text-accent-text"
              onClick={(event) => {
                // 没有 href，本来就不会导航；仍然显式阻止默认行为（双保险 + 读代码的人一眼看到）
                event.preventDefault()
                openExternalSafe(span.href)
              }}
            >
              {span.text}
            </button>
          )
        }
        return <span key={index}>{span.text}</span>
      })}
    </>
  )
}

/** 块级 token → React 节点（标题走语义化 h3/h4/h5，弹窗自身标题是 h2） */
function NotesBody({ blocks }: { blocks: NotesBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          // 三档字号对应 1/2/3 级；行高比正文紧一档（标题不该有段间距）
          const size = block.level === 1 ? 'text-[13.5px]' : block.level === 2 ? 'text-[13px]' : 'text-[12.5px]'
          const className = `mt-3 mb-1 font-semibold text-primary ${size}`
          if (block.level === 1) {
            return (
              <h3 key={index} className={className}>
                <InlineText text={block.text} />
              </h3>
            )
          }
          if (block.level === 2) {
            return (
              <h4 key={index} className={className}>
                <InlineText text={block.text} />
              </h4>
            )
          }
          return (
            <h5 key={index} className={className}>
              <InlineText text={block.text} />
            </h5>
          )
        }
        if (block.type === 'rule') {
          // 用 div + border-t 而不是 <hr>：`<hr>` 自带 UA 的 border/背景/外边距，
          // 要覆盖三处才能跟 token 对齐，用 div 一条描边最省事（与仓内其它分隔线一致）。
          return <div key={index} role="separator" className="my-3 border-t border-line" />
        }
        if (block.type === 'list') {
          // `list-disc` / `list-decimal` + 左内边距：卡片里没有排版容器，必须自备
          const listClass = block.ordered
            ? 'my-1.5 list-decimal pl-5 text-[12.5px] leading-[1.7] text-secondary'
            : 'my-1.5 list-disc pl-5 text-[12.5px] leading-[1.7] text-secondary'
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex} className="marker:text-tertiary">
              <InlineText text={item} />
            </li>
          ))
          return block.ordered ? (
            <ol key={index} className={listClass}>
              {items}
            </ol>
          ) : (
            <ul key={index} className={listClass}>
              {items}
            </ul>
          )
        }
        // paragraph：12.5px / 1.7 —— 深色档 #98989e on #1c1c1e = 5.93:1（AA 达标）
        return (
          <p key={index} className="my-1.5 text-[12.5px] leading-[1.7] text-secondary">
            <InlineText text={block.text} />
          </p>
        )
      })}
    </>
  )
}

/**
 * 「发现新版本」弹窗。
 *
 * **无 props**：内容与动作全部来自 `logic/updateState.ts`（唯一数据源），
 * 挂载与否由 App 用 `useUpdateDialogOpen()` 决定 —— 这样"什么时候弹"只有一个判定点，
 * 不会出现"挂载了但不该显示"的两套真相。
 */
export function UpdateNotesDialog() {
  const info = useUpdateState()
  // ⚠️ 所有 hook 必须在任何 early return 之前（React 的调用顺序约束）
  const escDepth = useEscLayer(dismissUpdateDialog, true)
  const laterButtonRef = useRef<HTMLButtonElement | null>(null)

  // 焦点默认落在「稍后」：避免用户"回车/空格"顺手把安装包下下来。
  // 用 ref + effect（不是 autoFocus）：autoFocus 在弹窗反复挂载时会抢走用户已经在用的焦点。
  useEffect(() => {
    laterButtonRef.current?.focus()
  }, [])

  if (!info || !info.latest) return null

  const blocks = parseReleaseNotes(info.notes)
  const downloadTarget = info.assetUrl || info.url
  const published = formatPublishedAt(info.publishedAt)
  const subtitle = published ? `当前 ${info.current} · 发布于 ${published}` : `当前 ${info.current}`

  return (
    <div
      className={`dialog-scrim fixed inset-0 ${zClassForDepth(escDepth)} flex items-center justify-center p-6`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-notes-title"
      data-update-notes-dialog=""
      onPointerDown={(event) => {
        // 点遮罩 = 稍后（不写 localStorage，重启后同一版本还会弹一次）
        if (event.target === event.currentTarget) dismissUpdateDialog()
      }}
    >
      <div
        className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-modal border border-line bg-card shadow-modal"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* 头部：标题带版本号（用户一眼知道"新在哪"），副标题是当前版本 + 发布日期 */}
        <div className="shrink-0 px-5 pb-3 pt-4">
          <h2 id="update-notes-title" className="text-[15px] font-semibold text-primary">
            发现新版本 v{info.latest}
          </h2>
          <div className="mt-1 text-[11.5px] text-secondary">{subtitle}</div>
        </div>

        {/* 正文：可滚动区。`min(52vh, 420px)` —— 小窗时不撑破窗口，大屏时不至于只露三行。
            滚动的只是这一块，头/脚永远在位（按钮不会跟着滚走）。 */}
        <div className="max-h-[min(52vh,420px)] overflow-y-auto border-t border-line px-5 py-2">
          {blocks.length > 0 ? (
            <NotesBody blocks={blocks} />
          ) : (
            <p className="my-2 text-[12.5px] leading-[1.7] text-secondary">
              这个版本没有写更新说明
            </p>
          )}
        </div>

        {/* 底部按钮（从右到左：主 / 次 / 次）。
            左起「稍后」= 视觉最弱的位置，也是初始焦点所在 —— 误触只会"稍后再说"。 */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            ref={laterButtonRef}
            type="button"
            className="btn btn-ghost !px-3 !py-1 text-[12px] text-secondary"
            onClick={() => dismissUpdateDialog()}
            title="本次启动不再提示（重启后仍会提示）"
          >
            稍后
          </button>
          <button
            type="button"
            className="btn btn-ghost !px-3 !py-1 text-[12px] text-secondary"
            onClick={() => skipUpdateVersion()}
            title={`不再提示 v${info.latest}（下一个版本仍会提示）`}
          >
            跳过这个版本
          </button>
          {downloadTarget ? (
            <button
              type="button"
              className="btn btn-primary !px-3 !py-1 text-[12px]"
              onClick={() => openExternalSafe(downloadTarget)}
            >
              前往下载
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
