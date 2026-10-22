import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useVault } from '../store'
import { resolveRenderParams, type BallParamScales } from '../../shared/ballParams'
import { displayName } from '../../shared/naming'
import { IconClose } from '../icons'
import type { Asset } from '../../shared/types'
import type { MaterialSlots } from '../logic/materialBall'
import { stageController } from '../logic/stageController'
import type { MaterialBallApi } from './MaterialBall'

/**
 * 参数落库防抖窗口（docs/12 §5.1 第 3 条）：滑块 `onChange` 每帧都触发，
 * 不防抖 → 每帧一次 `db.assets.put` + 一次 WebGL 上下文。400ms 静默窗口足够。
 *
 * 持久化挂在 **change 防抖**上，不挂在弹窗关闭：§3.7 的遮罩点击会直接关闭而不保存
 * （拖完滑块点遮罩 → 参数丢失）。
 */
const PARAM_PERSIST_DEBOUNCE_MS = 400

/**
 * three.js 惰性加载：MaterialBall / renderBallToJpeg 只在弹窗真正打开时才进网络
 * （store 的离屏渲球本来就走动态 import，这里若静态引入会把 three 打进主 chunk，
 * 首屏多背 ~1MB——维持既有分包纪律）。
 */
const MaterialBall = lazy(() =>
  import('./MaterialBall').then((m) => ({ default: m.MaterialBall }))
)

/**
 * 自定义渲染独立面板（UI 设计规范 v0.2 §3.7，820×560）。
 *
 * - 左：渲染画布 460×420（底 `--render-canvas-bg`：浅色白 / 深色 #1C1C1E，
 *   v0.2.1 增补 1 覆盖 §3.7 的近黑）+ 底注「实时预览 · 拖动滑块即时重渲」；
 * - 右：三个滑块（v0.2.1 增补 2 拍板顺序）：反光强度（roughness 倍率）、
 *   凹凸强度（normal/displacement 倍率），0-2；UV 大小（贴图平铺倍率）0.1-4，
 *   拖动即时重渲；保存时三参数一并生效；
 * - 底部：`保存 · 设为封面` 实心 accent 通栏钮 → 离屏渲染一帧存 JPG →
 *   `asset:setCoverImage` 落盘 + `setCover`（coverSource='manual'，能力既有）。
 *
 * 入口：DetailPanel 预览区「自定义渲染」按钮。
 * 选型说明：MaterialBall 的**内嵌调参面板保留**（组件级能力，其他调用方仍可用），
 * 本弹窗传 `enableParamPanel={false}` 不走它，滑块按规范放在弹窗右侧。
 */
export function CustomRenderDialog({
  asset,
  slots,
  onClose
}: {
  asset: Asset
  slots: MaterialSlots
  onClose: () => void
}) {
  // 初值读回该资产已存的参数（docs/12 §3.4 表 / §5.2 末段）——弹窗内 useState 仍保留
  // （即时重渲预览需要），只是不再从 DEFAULT 起步，否则网格与弹窗显示不一致。
  const [scales, setScales] = useState<BallParamScales>(() => resolveRenderParams(asset))
  const [saving, setSaving] = useState(false)
  const renderable = useMemo(() => !!slots.albedo, [slots])

  // 防抖落库（§5.1）：滑块停下 400ms 才写库 + 入队重渲。
  // 必须在 `if (!renderable) return null` 之前声明——hook 顺序不能随分支变化。
  const debounceRef = useRef<number | null>(null)
  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      void useVault.getState().persistRenderParams(asset.id, scales)
    }, PARAM_PERSIST_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [asset.id, scales])

  // ── 舞台球 ↔ 弹窗球交接（2026-10，0.6.2） ──────────────────────────────
  // 目标是"同一颗球飞进去、保存后再飞回来"，而不是屏幕上有两颗球。
  // 判定：只有舞台**正在展示同一个资产、且还没交接**时才走交接；
  // 其余入口（详情面板里对非舞台资产开弹窗）保持原来的"弹窗自带一颗球"。
  const ballApiRef = useRef<MaterialBallApi | null>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  /** 弹窗球是否可见：交接时先隐身，等舞台球飞到位才显形 */
  const [ballShown, setBallShown] = useState(() => {
    const st = stageController.get()
    return !(st.phase === 'active' && st.assetId === asset.id && !st.handedOff)
  })
  /** 是否真的发起过交接（决定关闭时要不要让舞台球从弹窗位置飞回去） */
  const handoffRef = useRef(false)
  const closeTimerRef = useRef<number | null>(null)

  const stagePhase = useSyncExternalStore(
    stageController.subscribe,
    stageController.get,
    stageController.get
  )

  // ① 发起交接：等 canvas 布局就绪（懒加载 chunk / Suspense 可能晚一帧），
  //    用 `sphereScreenDiameter()` 算落点 —— 球在 canvas 里只占一部分，
  //    直接拿 canvas 尺寸当球径会在交接瞬间"跳一下"。
  useEffect(() => {
    if (ballShown) return
    let frame = 0
    let tries = 0
    const attempt = (): void => {
      const api = ballApiRef.current
      const canvas = canvasWrapRef.current?.querySelector('canvas')
      if (!api || !canvas) {
        // 还没就绪：最多再等 5 帧；仍拿不到就老实显示弹窗球（宁可两颗，也不能永远不显示）
        if (++tries <= 5) {
          frame = requestAnimationFrame(attempt)
          return
        }
        setBallShown(true)
        return
      }
      const r = canvas.getBoundingClientRect()
      const dia = api.sphereScreenDiameter()
      if (!(dia > 8) || r.width < 2 || r.height < 2) {
        setBallShown(true) // 尺寸不可用就别硬演
        return
      }
      // 球心投影 = 画布中心（见 sphereScreenDiameter 的公式说明），所以按中心对齐
      const target = new DOMRect(
        r.left + r.width / 2 - dia / 2,
        r.top + r.height / 2 - dia / 2,
        dia,
        dia
      )
      handoffRef.current = true
      stageController.handoff(target)
    }
    frame = requestAnimationFrame(attempt)
    return () => cancelAnimationFrame(frame)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ② 交接完成（舞台球已隐身）→ 弹窗球淡入显形。
  //    与 ① 分开两个 effect：一个只负责"发起"，一个只负责"接收"，互不改 deps。
  useEffect(() => {
    if (ballShown) return
    if (stagePhase.phase === 'active' && stagePhase.handedOff) setBallShown(true)
  }, [stagePhase.phase, stagePhase.handedOff, ballShown])

  // ③ 兜底看门狗：交接万一没回执（舞台被卸载 / 状态异常），1.2s 后也必须让球出现 ——
  //    空画布比"多一颗球"更不能接受。正常路径 300ms 内就会被 ② 抢先清掉这个 timer。
  useEffect(() => {
    if (ballShown) return
    const t = window.setTimeout(() => setBallShown(true), 1200)
    return () => window.clearTimeout(t)
  }, [ballShown])

  // 卸载兜底：清掉"延迟关闭"的 timer（用户连点两下关闭时不能触发两次 onClose）
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    },
    []
  )

  /**
   * 关闭 / 保存前的「球回家」：舞台球从**弹窗位置**飞回**顶栏槽位**（`handback`），
   * 弹窗球淡出 120ms 之后才真正卸载弹窗。
   *
   * ⚠️ 必须用 `handback()` 而不是 `close()`：`close()` 的语义是「退文件视图 → 回网格」，
   * 终点是双击时拍下的卡片坐标（此刻早已不在屏幕上）→ 球会朝错误目标飞然后消失。
   * 顺序不能反：先让舞台球在弹窗位置复活，否则这 120ms 里屏幕上一颗球都没有。
   */
  const beginClose = (): void => {
    if (!handoffRef.current) {
      onClose()
      return
    }
    stageController.handback()
    setBallShown(false)
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      onClose()
    }, 120)
  }

  if (!renderable) return null

  /** 保存：当前参数离屏渲一帧 JPG → 写进资产文件夹 → coverSource='manual'（§3.7） */
  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      const { renderBallToJpeg, blobToBase64, paperColor } = await import('./MaterialBall')
      // v0.2.1 增补 1：背景走主题化 paperColor()（读 --render-canvas-bg），不再硬编码近黑
      const blob = await renderBallToJpeg(asset.relFolder, slots, {
        size: 480,
        params: scales,
        background: paperColor()
      })
      const base64 = await blobToBase64(blob)
      if (!base64) throw new Error('离屏渲染读帧失败')
      const res = await window.modvault.setCoverImage({
        assetId: asset.id,
        folder: asset.folder,
        source: 'clipboard',
        data: base64
      })
      if (!res) throw new Error('封面写盘失败')
      // 后半程复用既有 setCover：coverSource='manual' + RA3 缩略图重生
      await useVault.getState().setCover(asset.id, res.rel)
      useVault.setState({ notice: '已保存自定义渲染并设为封面' })
      // 保存成功后同样走"球回家"，不要直接卸载弹窗（否则球会凭空消失）
      beginClose()
    } catch (err) {
      console.warn('[CustomRenderDialog] 保存失败：', err)
      useVault.setState({ notice: '保存失败：渲染或写盘未成功，请重试' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="dialog-scrim fixed inset-0 z-50 flex items-center justify-center p-6"
      onClick={beginClose}
    >
      {/* 走查 v0.2.2 B4 拍板（分组件）：渲染弹窗 r12（画布 2:242 浅）/ 深色 r14（画布 2:842）
          → --radius-modal-render 按主题各一套 */}
      <div
        className="flex h-[560px] w-[820px] flex-col overflow-hidden rounded-modal-render border border-line bg-card shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏（§3.7 截图：自定义渲染 · 资产名） */}
        <div className="flex shrink-0 items-center justify-between px-6 pb-1 pt-4">
          <h2 className="text-[16px] font-semibold text-primary">
            自定义渲染 <span className="mx-1 text-muted">·</span>
            <span className="text-[14px] font-medium text-secondary">{displayName(asset.name)}</span>
          </h2>
          <button
            className="btn btn-ghost !p-1.5"
            onClick={beginClose}
            title="关闭"
          >
            <IconClose />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 gap-6 px-6 pb-2 pt-2">
          {/* 左：渲染画布 460×420，深色近黑底（§3.7） */}
          <div className="flex w-[460px] shrink-0 flex-col">
            {/* 画布圆角独立一档：画布 2:249（浅）/ 2:851（深）均 r14，不随右栏 --radius-preview 的深色覆盖 */}
            <div
              ref={canvasWrapRef}
              className="h-[420px] w-[460px] overflow-hidden rounded-render-canvas bg-render-canvas"
            >
              <Suspense
                fallback={
                  <div className="flex h-full w-full items-center justify-center text-[12px] text-muted">
                    正在加载渲染引擎…
                  </div>
                }
              >
                {/* 透明度只作用在**球那一层**，不动画布底（否则会连底色一起闪） */}
                <div
                  className="h-full w-full transition-opacity duration-[120ms]"
                  style={{ opacity: ballShown ? 1 : 0 }}
                >
                  <MaterialBall
                    relFolder={asset.relFolder}
                    slots={slots}
                    showShapeSwitch={false}
                    enableParamPanel={false}
                    params={scales}
                    apiRef={ballApiRef}
                    className="!bg-transparent"
                  />
                </div>
              </Suspense>
            </div>
            <div className="mt-2 text-[11px] text-muted">实时预览 · 拖动滑块即时重渲</div>
          </div>

          {/* 右：三个滑块（§3.7 两滑块 + v0.2.1 增补 2 的 UV 大小）+ 底部保存 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <label className="block">
              <span className="flex items-baseline justify-between text-[13px] text-secondary">
                反光强度
                <span className="text-[12px] font-medium text-accent-text">×{scales.roughness.toFixed(1)}</span>
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={scales.roughness}
                onChange={(e) => setScales((s) => ({ ...s, roughness: Number(e.target.value) }))}
                className="slider-accent mt-2 w-full"
                title="roughness 倍率：越大越哑光（0 = 镜面）"
              />
            </label>
            <label className="mt-5 block">
              <span className="flex items-baseline justify-between text-[13px] text-secondary">
                凹凸强度
                <span className="text-[12px] font-medium text-accent-text">×{scales.bump.toFixed(1)}</span>
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={scales.bump}
                onChange={(e) => setScales((s) => ({ ...s, bump: Number(e.target.value) }))}
                className="slider-accent mt-2 w-full"
                title="法线 / 置换倍率：越大凹凸越明显（0 = 拍平）"
              />
              <div className="mt-2 text-[11px] text-muted">作用于 Normal / Displacement 槽位倍率</div>
            </label>
            {/* v0.2.1 增补 2：第三个滑块 UV 大小（贴图平铺倍率），与另两个同口径 */}
            <label className="mt-5 block">
              <span className="flex items-baseline justify-between text-[13px] text-secondary">
                UV 大小
                <span className="text-[12px] font-medium text-accent-text">×{scales.uv.toFixed(1)}</span>
              </span>
              <input
                type="range"
                min={0.1}
                max={4}
                step={0.1}
                value={scales.uv}
                onChange={(e) => setScales((s) => ({ ...s, uv: Number(e.target.value) }))}
                className="slider-accent mt-2 w-full"
                title="贴图平铺倍率：越大贴图越小（平铺越密）"
              />
              <div className="mt-2 text-[11px] text-muted">贴图平铺倍率 · 默认 1.0（0.1–4.0）</div>
            </label>

            <div className="mt-auto">
              {/* §3.7：保存 · 设为封面（实心 accent 通栏钮） */}
              <button className="btn-solid w-full !h-10 !text-[13px]" disabled={saving} onClick={() => void save()}>
                {saving ? '渲染中…' : '保存 · 设为封面'}
              </button>
              {/* 2026-10-21 走查 P2⑤：这里原来写的是「离屏渲染一帧 JPG · coverSource=manual（§3.3）」
                  —— 全是实现细节与需求书章节号，用户读不懂也不需要读。改成说人话：会发生什么、能不能反悔。 */}
              <div className="mt-2 text-[11px] text-muted">
                保存后会把当前这一帧存成封面，之后可随时在这里或详情面板换回
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
