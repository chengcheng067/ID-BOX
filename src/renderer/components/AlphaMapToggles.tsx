/**
 * 「按贴图灰度做透明」的两个开关（0.7.6，用户拍板）。
 *
 * 用户原话（docs/25「未来需求 · 渐变贴图按灰度做透明度」）：
 * 「渐变贴图按灰度做透明度——用贴图的灰度值当 alpha，白色不透明、黑色透明，
 *  再加一个反转灰度的开关」。
 *
 * 产品口径（已拍板，**不要自行扩展**）：
 * - 灰度来源 = **albedo 本身**（当前已经作为颜色贴图加载的那张图）。
 *   不做文件选择器、不新增 PBR 槽位 —— 所以 `shared/pbrSlots.ts` 一个字都不改；
 * - **默认关**：关着的时候全库成像一个像素都不变、球图缓存名一个字节都不变；
 * - 第二个开关「反转灰度」在第一个未勾选时禁用（没有灰度图时反转无意义）；
 * - 现有的「透明度」滑块是**整体强度**，灰度图是**分布**：three 原生就是
 *   `a = opacity × map.a × alphaMap.g`，滑块天然乘在最外层，不做乘算语义改动。
 *
 * 抽成独立组件是因为它有**两个入口**（详情面板的内嵌调参面板 + 自定义渲染弹窗右栏）。
 * 两份各写一遍必然漂移（文案不一致、关掉灰度时忘了归零反转值），所以只留一份实现。
 */
export interface AlphaMapTogglesProps {
  /** 是否按贴图灰度做透明（默认 false） */
  alphaFromMap: boolean
  /** 是否反转灰度（深色 = 不透明）；`alphaFromMap` 为 false 时一律视为 false */
  invertAlpha: boolean
  onChange: (next: { alphaFromMap: boolean; invertAlpha: boolean }) => void
  /** 紧凑排版（详情面板内嵌小面板用；弹窗右栏用常规字号） */
  compact?: boolean
  className?: string
}

export function AlphaMapToggles({
  alphaFromMap,
  invertAlpha,
  onChange,
  compact = false,
  className
}: AlphaMapTogglesProps) {
  const labelSize = compact ? 'text-[11px]' : 'text-[12px]'
  const hintSize = compact ? 'text-[10px]' : 'text-[11px]'
  return (
    <div className={className}>
      <label className={`flex items-center gap-2 ${labelSize} text-secondary`}>
        <input
          type="checkbox"
          checked={alphaFromMap}
          onChange={(e) => {
            const next = e.target.checked
            // 关掉灰度图时把「反转」一起归零：否则会在参数里留下一个**看不见的真值**
            // → paramsKey 多一段、球图换名重渲一次，而画面毫无变化（用户会以为坏了）。
            onChange({ alphaFromMap: next, invertAlpha: next ? invertAlpha : false })
          }}
        />
        <span>按贴图灰度做透明</span>
      </label>
      <label
        className={`mt-1 flex items-center gap-2 ${labelSize} text-secondary ${
          alphaFromMap ? '' : 'opacity-50'
        }`}
        title={
          alphaFromMap
            ? '默认白 = 不透明、黑 = 透明；勾上后反过来（深色 = 不透明）'
            : '先勾选「按贴图灰度做透明」才生效'
        }
      >
        <input
          type="checkbox"
          checked={alphaFromMap && invertAlpha}
          disabled={!alphaFromMap}
          onChange={(e) => onChange({ alphaFromMap, invertAlpha: e.target.checked })}
        />
        <span>反转灰度（深色 = 不透明）</span>
      </label>
      <p className={`mt-1 leading-relaxed text-muted ${hintSize}`}>
        灰度图决定透明度分布，上面的滑块整体缩放
      </p>
    </div>
  )
}
