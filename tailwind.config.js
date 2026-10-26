/**
 * ID BOX Tailwind 配置（2026-10 UI 设计规范 v0.2 对齐）。
 *
 * 颜色一律映射到 `src/renderer/styles.css` 里的 CSS 变量 token
 * （[data-theme="light"] Soft UI / [data-theme="dark"] Vibrancy，逐色照抄规范 §1），
 * 组件里不再出现硬编码色值；带透明度修饰（如 `bg-accent/40`）时用 color-mix 兜底
 * （Chromium 111+，Electron 33 支持）。
 *
 * 兼容别名：旧组件里的 paper/card/ink/muted/line/accent/accent-soft 保留，
 * 全部改指新 token，存量类名无需逐一改名即自动随主题切换。
 */

/**
 * token → Tailwind 颜色（支持 /opacity 修饰，经 color-mix 实现）。
 *
 * ⚠️ 2026-10-14 装机缺陷修复：Tailwind 在**不带 /opacity 修饰**的用法里也会调用本函数，
 * 且 `ctx.opacityValue` 传的是字符串 `'var(--tw-bg-opacity, 1)'`（不是数字）。
 * 旧实现直接 parseFloat → NaN → 产出 `color-mix(in srgb, var(--x) NaN%, transparent)`，
 * 该声明无效被 Chromium 整条丢弃 → 所有 token 色全部失效（构建产物 51 处）。
 * 因此只有当 opacityValue 是**有限数字**时才走 color-mix；否则等价于不透明度 1，
 * 直接返回 `var(--x)`。`bg-accent/40` 这类真数字修饰仍走 color-mix。
 */
const token = (variable: string) => (ctx: { opacityValue?: string }): string => {
  const raw = ctx?.opacityValue
  if (raw === undefined) return `var(${variable})`
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return `var(${variable})`
  const pct = Math.round(n * 100)
  return `color-mix(in srgb, var(${variable}) ${pct}%, transparent)`
}

export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── 规范 §1 token（新命名） ─────────────────────────────
        canvas: token('--bg-canvas'),
        sidebar: token('--bg-sidebar'),
        elevated: token('--bg-elevated'),
        surface: token('--surface-card'),
        line: token('--border'),
        /** 走查 v0.2.2 B2#4 / B2#5：描边三档并存（通用 / 面板 / 槽位组） */
        'panel-line': token('--border-panel'),
        'soft-line': token('--border-soft'),
        primary: token('--text-primary'),
        secondary: token('--text-secondary'),
        tertiary: token('--text-tertiary'),
        muted: token('--text-muted'),
        accent: token('--accent'),
        'accent-text': token('--accent-text'),
        'accent-tint': token('--accent-tint'),
        /** 走查 v0.2.2 拍板：中性灰 tint 专用 token（.badge + 顶层导航选中） */
        'neutral-tint': token('--tint-neutral'),
        'neutral-tint-text': token('--tint-neutral-text'),
        /** 走查 v0.2.2 B2#4：右栏白卡（浅 #FFFFFF / 深 #161618） */
        panel: token('--panel-bg'),
        danger: token('--danger'),
        'danger-tint': token('--danger-tint'),
        success: token('--success'),
        /** 顶栏「Preview」测试版徽标专用（用户指定紫色，不参与功能语义） */
        preview: token('--preview'),
        'preview-tint': token('--preview-tint'),
        /** 顶栏视图分段控件选中段底（§3.1：浅 #FFFFFF / 深 #2C2C2E，规范原文给值） */
        'seg-active': token('--seg-active'),
        /** 多选操作条底（§3.3：浅白卡 / 深 #242428） */
        floatbar: token('--bg-floatbar'),
        /** 自定义渲染画布底（§3.7：#0D0A07 深色近黑，双主题固定） */
        'render-canvas': token('--render-canvas-bg'),
        /** 走查 v0.2.2 B6#20/#21：胶囊控件底（中栏头排序 `2:83` 浅 #F1F5F9 / 深 `2:361` #1C1C1E） */
        pill: token('--pill-bg'),
        /** 走查 v0.2.2 B6#22：toast 条底（画布浅 `2:168` #F8FAFC / 深 `2:446` #161618） */
        toast: token('--toast-bg'),
        // ── 存量别名（老组件类名继续可用，全部指向 token） ──────
        paper: token('--bg-canvas'),
        card: token('--surface-card'),
        ink: token('--text-primary'),
        'accent-soft': token('--accent-tint')
      },
      fontFamily: {
        sans: ['var(--font-family)']
      },
      /**
       * 走查 v0.2.2 B5#16（用户拍板：按画布实测值）：网格 gap 14。
       * ⚠️ Tailwind 的 `gap-*` 读的是 `theme.spacing`，不是 `borderRadius`/`colors`。
       * 此前 `gap-card` 因为 `card` 不在 spacing 里 → 构建产物里**根本没生成**
       * （`grep -o "\.gap-card{...}" out/renderer/assets/*.css` 无命中）→ 网格实际无间距。
       * 这里必须显式补 spacing，`gap-card` 才会真正产出。
       */
      spacing: {
        card: 'var(--gap-card)'
      },
      borderRadius: {
        btn: 'var(--radius-btn)',
        modal: 'var(--radius-modal)',
        'modal-settings': 'var(--radius-modal-settings)',
        'modal-render': 'var(--radius-modal-render)',
        card: 'var(--radius-card)',
        nav: 'var(--radius-nav)',
        chip: 'var(--radius-chip)',
        badge: 'var(--radius-badge)',
        preview: 'var(--radius-preview)',
        'render-canvas': 'var(--radius-render-canvas)',
        coverbar: 'var(--radius-coverbar)',
        slotgroup: 'var(--radius-slotgroup)',
        'danger-btn': 'var(--radius-danger-btn)',
        toast: 'var(--radius-toast)',
        'toast-undo': 'var(--radius-toast-undo)',
        floatbar: 'var(--radius-floatbar)',
        pill: 'var(--radius-pill)',
        'pill-header': 'var(--radius-pill-header)',
        // 走查 v0.2.2 C#14/C#15/B5#18：顶栏控件与主题卡分主题圆角
        logo: 'var(--radius-logo)',
        /** 走查 v0.2.2 C#15：关于页 Logo r16（画布 `2:955`），与顶栏 Logo r6 不同档 */
        'logo-lg': 'var(--radius-logo-lg)',
        seg: 'var(--radius-seg)',
        'seg-group': 'var(--radius-seg-group)',
        search: 'var(--radius-search)',
        cta: 'var(--radius-cta)',
        'theme-card': 'var(--radius-theme-card)',
        'toast-undo-inner': 'var(--radius-toast-undo-inner)',
        tab: 'var(--radius-tab)',
        winbtn: 'var(--radius-winbtn)'
      },
      /**
       * 弹窗层级（0.7.8 T-ZSTACK）：`z-60 / z-70 / z-80` 必须在这里显式登记。
       *
       * Tailwind 默认的 zIndex 只有 0/10/20/30/40/50 —— `z-60` 这类类名即使出现在源码里
       * 也**不会**生成 CSS（不是"tree-shaken"，是压根没有这个工具类）。弹窗层级由层栈
       * 深度算出（`src/renderer/logic/zStack.ts`：第 2 层 60、第 3 层 70、第 4 层起 80），
       * 少了这三档，多层弹窗会全部退回文档流默认层级 → 叠放顺序变成"碰运气"。
       */
      zIndex: {
        60: '60',
        70: '70',
        80: '80'
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        'card-active': 'var(--shadow-card-active)',
        modal: 'var(--shadow-modal)',
        floatbar: 'var(--shadow-floatbar)',
        // 存量别名
        soft: 'var(--shadow-card)',
        pop: 'var(--shadow-modal)'
      }
    }
  },
  plugins: []
}
