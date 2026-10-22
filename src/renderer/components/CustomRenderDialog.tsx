import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useVault } from '../store'
import { resolveRenderParams, resolveRenderShape, type NormalizedBallParams } from '../../shared/ballParams'
import { displayName } from '../../shared/naming'
import { IconClose } from '../icons'
import type { Asset } from '../../shared/types'
import type { MaterialSlots } from '../logic/materialBall'
import { renderActionPlan, type RenderAction } from '../logic/materialBall'
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
 * - 右：六个滑块（0.6.9 用户拍板顺序）：光线强度（环境光照度 0.2-2）、
 *   反光强度（roughness 倍率）、凹凸强度（normal/displacement 倍率）0-2、
 *   金属度（metalness 绝对值 0-1）、透明度（0.1-1）、UV 大小（平铺倍率 0.1-4）；
 *   拖动即时重渲；保存时六参数一并生效；
 * - 底部：**两个**出口（0.7.0 用户拍板拆分）：主按钮「保存」只持久化六个参数、不碰封面；
 *   次按钮「设为封面」另外离屏渲一帧存 JPG → `asset:setCoverImage` 落盘 +
 *   `setCover`（coverSource='manual'，能力既有）。分流的判据见 `renderActionPlan`。
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
  // 类型用规范化形态：六参数全部就位，滑块才是受控的（历史参数只有三个字段）。
  const [scales, setScales] = useState<NormalizedBallParams>(() => resolveRenderParams(asset))
  /**
   * 正在执行哪个出口（0.7.0 拆成两个按钮后必须区分）：
   * `null` = 空闲；`'params'` → 保存中…；`'cover'` → 渲染中…。
   * 两个按钮在任一动作进行中都要禁用，避免"保存"和"设为封面"并发写同一份参数。
   */
  const [busy, setBusy] = useState<RenderAction | null>(null)
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

  /**
   * 两个出口共用一条主干（0.7.0）：先**强制**落库六个参数，再按 `renderActionPlan`
   * 决定要不要渲封面。
   *
   * - `'params'`（保存）：只记参数 → 关闭弹窗 → `已保存渲染参数`。
   *   **绝不动封面、绝不动 coverSource** —— 用户原话「既有的 PBR 材质不需要我们的球成为封面」；
   * - `'cover'`（设为封面）：离屏渲一帧 JPG → 写进资产文件夹 → `coverSource='manual'`
   *   → 原文案 → 球回家。
   *
   * 为什么先显式 `persistRenderParams` 而不是等 400ms 防抖：用户可能拖完滑块立刻点按钮，
   * 防抖窗口还没到就关了弹窗，参数就丢了。`persistRenderParams` 内部按 `paramsKey`
   * 去重（无变化直接 return），所以这次强制落库是幂等的、不会重复写库。
   */
  const runAction = async (action: RenderAction) => {
    if (busy) return
    const plan = renderActionPlan(action)
    setBusy(action)
    try {
      await useVault.getState().persistRenderParams(asset.id, scales)

      if (plan.writeCover) {
        const { renderBallToJpeg, blobToBase64, paperColor } = await import('./MaterialBall')
        // 形态必须跟着"用户正看着的那颗球"（2026-10 缓存策略）：用户看到平面却渲出球，
        // 封面就和预览不一致。`getShape()` 拿的是场景当前形态；API 还没就绪时回落到资产记忆值。
        const shape = ballApiRef.current?.getShape() ?? resolveRenderShape(asset)
        // v0.2.1 增补 1：背景走主题化 paperColor()（读 --render-canvas-bg），不再硬编码近黑
        const blob = await renderBallToJpeg(asset.relFolder, slots, {
          size: 480,
          params: scales,
          shape,
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
      }

      useVault.setState({ notice: plan.notice })
      // 两条路径都走"球回家"，不要直接卸载弹窗（否则球会凭空消失）
      beginClose()
    } catch (err) {
      console.warn(`[CustomRenderDialog] ${action === 'cover' ? '设为封面' : '保存'}失败：`, err)
      // 两条路径各自的失败文案：说清楚是哪一步没成，别共用一句
      useVault.setState({
        notice:
          action === 'cover'
            ? '封面保存失败：渲染或写盘未成功，请重试'
            : '保存失败：参数未能写入，请重试'
      })
    } finally {
      setBusy(null)
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
                    // 形态是球图身份的一部分（2026-10 缓存策略）：卡片上的球图按
                    // `resolveRenderShape(asset)` 渲，弹窗这颗必须同形态，否则图文不一致。
                    // 当前资产永远是 'sphere'（全仓没有形态 UI），这两行先让契约闭环。
                    defaultShape={resolveRenderShape(asset)}
                    onShapeChange={(s) => void useVault.getState().setRenderShape(asset.id, s)}
                    params={scales}
                    apiRef={ballApiRef}
                    className="!bg-transparent"
                  />
                </div>
              </Suspense>
            </div>
            <div className="mt-2 text-[11px] text-muted">实时预览 · 拖动滑块即时重渲</div>
          </div>

          {/* 右：六个滑块（0.6.9：光线强度 / 反光强度 / 凹凸强度 / 金属度 / 透明度 / UV 大小）
              + 底部保存。滑块区可滚动：六块内容比原来的三块高，收起时不留滚动条，超出才有。 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              <label className="block">
                <span className="flex items-baseline justify-between text-[13px] text-secondary">
                  光线强度
                  <span className="text-[12px] font-medium text-accent-text">×{scales.light.toFixed(1)}</span>
                </span>
                <input
                  type="range"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={scales.light}
                  onChange={(e) => setScales((s) => ({ ...s, light: Number(e.target.value) }))}
                  className="slider-accent mt-1.5 w-full"
                  title="环境光照度：只把球照亮 / 调暗，不改贴图颜色（值越小越暗）"
                />
                <div className="mt-1 text-[11px] text-muted">光照强度 · 默认 1.0（0.2–2.0）</div>
              </label>
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
                  className="slider-accent mt-1.5 w-full"
                  title="roughness 倍率：越大越哑光（0 = 镜面）"
                />
                <div className="mt-1 text-[11px] text-muted">粗糙度倍率 · 默认 1.0（0.0–2.0）· 越大越哑光</div>
              </label>
              <label className="block">
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
                  className="slider-accent mt-1.5 w-full"
                  title="法线 / 置换倍率：越大凹凸越明显（0 = 拍平）"
                />
                <div className="mt-1 text-[11px] text-muted">法线 / 置换倍率 · 默认 1.0（0.0–2.0）</div>
              </label>
              <label className="block">
                <span className="flex items-baseline justify-between text-[13px] text-secondary">
                  金属度
                  <span className="text-[12px] font-medium text-accent-text">{Math.round(scales.metal * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={scales.metal}
                  onChange={(e) => setScales((s) => ({ ...s, metal: Number(e.target.value) }))}
                  className="slider-accent mt-1.5 w-full"
                  title="金属度：0 = 非金属，1 = 纯金属（金属靠环境反射出质感）"
                />
                <div className="mt-1 text-[11px] text-muted">无金属贴图，直接设定 · 0–100%</div>
              </label>
              <label className="block">
                <span className="flex items-baseline justify-between text-[13px] text-secondary">
                  透明度
                  <span className="text-[12px] font-medium text-accent-text">{Math.round(scales.alpha * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={scales.alpha}
                  onChange={(e) => setScales((s) => ({ ...s, alpha: Number(e.target.value) }))}
                  className="slider-accent mt-1.5 w-full"
                  title="不透明度：100% = 完全不透明（默认），越小越透"
                />
                <div className="mt-1 text-[11px] text-muted">不透明度 · 默认 100%（10%–100%）</div>
              </label>
              <label className="block">
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
                  className="slider-accent mt-1.5 w-full"
                  title="贴图平铺倍率：越大贴图越小（平铺越密）。球面已按 2:1 弧长补偿，方块贴图不会被拉长"
                />
                <div className="mt-1 text-[11px] text-muted">平铺倍率 · 默认 1.0（0.1–4.0）</div>
              </label>
            </div>

            <div className="mt-3 shrink-0">
              {/* 0.7.0 用户拍板：拆成两个出口。
                  主按钮 = 保存（只记参数，不碰封面）；次按钮 = 设为封面（渲一帧覆盖封面）。
                  用户原话：「既有的 PBR 的材质是不需要我们的球成为封面的」。 */}
              <div className="flex items-center gap-2">
                <button
                  className="btn-solid !h-10 flex-1 !text-[13px]"
                  disabled={busy !== null}
                  onClick={() => void runAction('params')}
                >
                  {busy === 'params' ? '保存中…' : '保存'}
                </button>
                {/* 次按钮走既有 `.btn`（border-line + bg-card，无自造色值），高度与主按钮一致 */}
                <button
                  className="btn !h-10 shrink-0 !text-[13px] disabled:opacity-40"
                  disabled={busy !== null}
                  onClick={() => void runAction('cover')}
                >
                  {busy === 'cover' ? '渲染中…' : '设为封面'}
                </button>
              </div>
              {/* 两句说明各自的后果，别让用户猜哪个会把球变成封面 */}
              <div className="mt-2 text-[11px] text-muted">
                保存只记住这六个参数，不影响封面 · 设为封面会把当前这一帧存成封面图
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
