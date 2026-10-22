/**
 * 批量重命名 / 命名模板（0.6.0，docs/22 §3.4）—— **纯函数，零 IO、零依赖**。
 *
 * 三层职责严格分开，任何一层都不越界：
 * 1. `applyRenameTemplate()`：只做占位符文本替换，**不清洗**（未知占位符原样保留，
 *    由 `unknownTokensOf()` 报给调用方提示，绝不静默吞掉用户写错的花括号）；
 * 2. `sanitizeFolderName()`：只做 Windows 文件夹名清洗（非法字符 / 首尾空格与点 / 连续空格）；
 * 3. `planRenames()`：把「模板 + 一批资产」变成**可预览、可拦截**的改名计划
 *    （重名 `dup` / 保留名 `invalid` / 未变化 `unchanged`）。
 *
 * ⚠️ 第一版范围（用户 2026-10 拍板）：**只改资产文件夹名，不改包里的文件名**。
 * 因此这里输出的永远是**单段文件夹名**，不含任何路径分隔符。
 */

import { displayName } from './naming'

/** 模板里可用的占位符（设置页 / 重命名弹窗的说明表与「点一下插入」共用同一份数据） */
export interface RenamePlaceholder {
  /** 字面占位符，如 `{n}` */
  token: string
  /** 简短名（表格第一列） */
  label: string
  /** 说明（表格第二列，必须写清取值来源） */
  hint: string
  /** 示例（表格第三列，帮助用户理解 `{n:2}` 的补零效果） */
  example: string
}

/**
 * 占位符清单（顺序即 UI 展示顺序）。
 *
 * `{name}` 用的是**显示名**（`displayName()` 剥掉知末 `ID_1234567` 段）——
 * 用户看到的卡片标题就是这个，模板里再写一遍原始 ID 没有意义。
 */
export const RENAME_PLACEHOLDERS: readonly RenamePlaceholder[] = [
  {
    token: '{name}',
    label: '原名',
    hint: '当前文件夹名（已剥掉知末 ID 段，与卡片标题一致）',
    example: '现代衣柜'
  },
  {
    token: '{c1}',
    label: '一级分类',
    hint: '资产所属一级分类目录名（未分类时就是「未分类」）',
    example: '家具'
  },
  {
    token: '{c2}',
    label: '二级分类',
    hint: '资产所属二级分类目录名',
    example: '衣柜'
  },
  {
    token: '{year}',
    label: '导入年份',
    hint: '该资产的导入年份（四位数字）',
    example: '2026'
  },
  {
    token: '{n}',
    label: '序号',
    hint: '按当前列表顺序从 1 开始编号；写 `{n:2}` 补零成 01、`{n:3}` 补成 001',
    example: '1'
  }
]

/** 模板求值上下文（`n` 由调用方按列表顺序给，从 1 起） */
export interface RenameContext {
  /** 原始名称（`planRenames` 会先过 `displayName()`） */
  name: string
  /** 一级分类 */
  c1: string
  /** 二级分类 */
  c2: string
  /** 导入年份（四位数字） */
  year: number
  /** 序号，从 1 起 */
  n: number
}

/**
 * 占位符语法：`{key}` 或 `{key:arg}`。
 * - key 允许字母 + 数字（`{c1}` / `{c2}` 必须命中），但必须以字母开头；
 * - arg 允许任意非花括号字符，交给具体占位符自己校验（`{n:2}`）；
 * - **必须**是完整花括号：`{ name }` 里的空格不匹配 → 原样保留（用户能一眼看出没生效）。
 */
const TOKEN_RE = /\{([a-zA-Z][a-zA-Z0-9]*)(?::([^{}]*))?\}/g

/** 允许的 key 集合（小写比较，`{NAME}` 也认） */
const KNOWN_KEYS: ReadonlySet<string> = new Set(['name', 'c1', 'c2', 'year', 'n'])

/** `{n:2}` 的补零宽度上限：再宽就只是把文件名撑长，没有收益 */
const MAX_PAD_WIDTH = 6

/**
 * 解析 `{n:width}` 的宽度。
 *
 * @returns 补零后的序号；宽度非法（`{n:x}` / `{n:0}` / `{n:99}`）返回 `null`
 *          → 调用方按「未知占位符」原样保留，而不是猜一个宽度
 */
function formatSequence(n: number, arg: string | undefined): string | null {
  const value = Number.isFinite(n) ? Math.trunc(n) : 1
  if (arg === undefined) return String(value)
  const width = Number(arg)
  if (!Number.isInteger(width) || width < 1 || width > MAX_PAD_WIDTH) return null
  return String(value).padStart(width, '0')
}

/**
 * 套用命名模板（纯文本替换，**不清洗、不截断**）。
 *
 * - 未知占位符（`{foo}` / `{n:x}`）**原样保留**，可用 `unknownTokensOf()` 取清单提示用户；
 * - 模板为空 / 全是空白 → 返回 `''`（`planRenames` 会在清洗时回退到原名 = 不改名）；
 * - 不做任何大小写、空格、非法字符处理 —— 那是 `sanitizeFolderName()` 的职责。
 */
export function applyRenameTemplate(tpl: string, ctx: RenameContext): string {
  const text = typeof tpl === 'string' ? tpl : ''
  if (text.trim() === '') return ''
  return text.replace(TOKEN_RE, (raw: string, key: string, arg: string | undefined): string => {
    switch (key.toLowerCase()) {
      case 'name':
        return typeof ctx.name === 'string' ? ctx.name : ''
      case 'c1':
        return typeof ctx.c1 === 'string' ? ctx.c1 : ''
      case 'c2':
        return typeof ctx.c2 === 'string' ? ctx.c2 : ''
      case 'year':
        return Number.isFinite(ctx.year) && ctx.year > 0 ? String(Math.trunc(ctx.year)) : ''
      case 'n': {
        const padded = formatSequence(ctx.n, arg)
        return padded === null ? raw : padded
      }
      default:
        // 未知占位符：原样保留（用户能看到自己写错了什么，不会得到半个名字）
        return raw
    }
  })
}

/**
 * 模板里**无效**的占位符清单（去重、按出现顺序）。
 *
 * 调用方（重命名弹窗 / 设置页）必须把它显示出来：静默保留 `{foo}` 会让用户
 * 以为模板没生效，而不是"我写错了"。
 */
export function unknownTokensOf(tpl: string): string[] {
  const out: string[] = []
  for (const m of String(tpl ?? '').matchAll(TOKEN_RE)) {
    const key = m[1].toLowerCase()
    let known = KNOWN_KEYS.has(key)
    // `{n:x}` 这种宽度非法的情况，按未知处理（与 applyRenameTemplate 的原样保留一致）
    if (known && key === 'n' && m[2] !== undefined) known = formatSequence(1, m[2]) !== null
    const token = m[0]
    if (!known && !out.includes(token)) out.push(token)
  }
  return out
}

/** Windows 非法文件名字符（含控制字符）；`/` 与 `\` 一并替换，保证结果永远是单段名 */
const ILLEGAL_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]/g

/** 只有下划线 / 空白 / 点组成的名字视为"清洗后为空"（`///` → `___`） */
const ONLY_PLACEHOLDER_RE = /^[_]+$/

/** 清洗后仍为空时的兜底名（与 `shared/naming.sanitizeName` 同口径） */
export const FALLBACK_FOLDER_NAME = '未命名'

/** Windows 设备保留名：这些名字建目录会直接失败，必须在预览阶段就标红 */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** 是否是 Windows 保留设备名（`CON` / `con.txt` / `LPT1` …） */
export function isReservedFolderName(name: string): boolean {
  return RESERVED_NAME_RE.test(String(name ?? '').trim())
}

/**
 * 首尾的去点/去空格（**两轮**：`trim` 之后末尾可能又露出一个点）。
 * 例：`' .沙发. '` → `'沙发'`；`'..'` → `''`。
 */
function stripEdgeDots(s: string): string {
  let out = s.replace(/^[. ]+/, '').replace(/[. ]+$/, '')
  out = out.replace(/^[. ]+/, '').replace(/[. ]+$/, '')
  return out
}

/**
 * 清成一个合法的 Windows 文件夹名（**单段**）。
 *
 * 规则（顺序固定）：
 * 1. 非法字符 `\ / : * ? " < > |` 与控制字符 → `_`（`/` 必须在第一步就换掉，
 *    否则「椅子/凳子」会变成两段路径，直接把资产搬进别的目录）；
 * 2. 连续空白合成一个空格；
 * 3. 去掉首尾的空格与点（Windows 不允许尾部点/空格）；
 * 4. 结果为空（或只剩 `_`）→ 回退 `fallback`；`fallback` 也不可用 → `未命名`。
 *
 * @param raw      待清洗的文本（模板求值结果）
 * @param fallback 兜底名，**传资产原名**即实现"空结果回退原名"
 */
export function sanitizeFolderName(raw: string, fallback = FALLBACK_FOLDER_NAME): string {
  const cleaned = stripEdgeDots(String(raw ?? '').replace(ILLEGAL_CHARS_RE, '_').replace(/\s+/g, ' '))
  if (cleaned && !ONLY_PLACEHOLDER_RE.test(cleaned)) return cleaned
  const fb = stripEdgeDots(
    String(fallback ?? '').replace(ILLEGAL_CHARS_RE, '_').replace(/\s+/g, ' ')
  )
  return fb && !ONLY_PLACEHOLDER_RE.test(fb) ? fb : FALLBACK_FOLDER_NAME
}

/** `planRenames` 的输入项（由渲染层从 `Asset` 投影，避免 shared 反向依赖 renderer） */
export interface RenamePlanItem {
  id: string
  /** 当前磁盘文件夹名（`Asset.name`） */
  name: string
  /** 一级分类（`Asset.category1`，缺失时调用方传「未分类」） */
  c1: string
  /** 二级分类（`Asset.category2`） */
  c2: string
  /** 导入年份（由 `importedAt` 取年） */
  year: number
}

/** 单行预览结果 */
export interface RenamePlanRow {
  id: string
  /** 旧文件夹名（磁盘现状） */
  from: string
  /** 新文件夹名（已清洗；执行时 main 侧再校验一次） */
  to: string
  /**
   * - `dup`：同批里另一行的目标名与本行相同（**不可执行**，Windows 大小写不敏感，故按小写比对）
   * - `invalid`：清洗后仍是 Windows 保留设备名（`CON` 等，**不可执行**）
   * - `unchanged`：新旧同名（**允许跳过，不算错**）
   * - `undefined`：正常待改名
   */
  reason?: 'dup' | 'invalid' | 'unchanged'
}

/** `planRenames` 的返回值 */
export interface RenamePlan {
  /** true = 没有任何 `dup` / `invalid` 行（`unchanged` 不影响）→ 允许执行 */
  ok: boolean
  rows: RenamePlanRow[]
  /** 模板里无法识别的占位符（UI 必须提示，不静默吞） */
  unknownTokens: string[]
}

/**
 * 生成改名计划（**纯函数，零 IO，可对任意批量预演**）。
 *
 * 三条判定：
 * ① `to === from` → `unchanged`（不报错，执行时跳过）；
 * ② 同一批里两行 `to` 相同（忽略大小写）→ **全部**标 `dup`（无法判断该保留谁，交给用户改模板）；
 * ③ `to` 命中 Windows 保留设备名 → `invalid`。
 *
 * ⚠️ 本函数**看不到磁盘**：目标目录上已存在的「同名兄弟目录」（不在本批里的）只能由
 * 主进程在执行前的预检里拦（`main/rename.ts` 的 preflight），拦下来同样零改动。
 *
 * `rows` 与 `items` **等长同序**（预览表直接用下标对齐）。
 */
export function planRenames(items: readonly RenamePlanItem[], tpl: string): RenamePlan {
  const rows: RenamePlanRow[] = items.map((item, index) => {
    const from = String(item.name ?? '')
    const raw = applyRenameTemplate(tpl, {
      // `{name}` = 显示名（与卡片标题一致，已剥知末 ID）
      name: displayName(from),
      c1: String(item.c1 ?? ''),
      c2: String(item.c2 ?? ''),
      year: Number.isFinite(item.year) ? item.year : 0,
      n: index + 1
    })
    const to = sanitizeFolderName(raw, from)
    if (to === from) return { id: item.id, from, to, reason: 'unchanged' }
    if (isReservedFolderName(to)) return { id: item.id, from, to, reason: 'invalid' }
    return { id: item.id, from, to }
  })

  // ② 同批重名：按小写分组，组内 ≥2 行全部标 dup（含 unchanged 行 —— 它同样占着这个名字）
  const byKey = new Map<string, number[]>()
  rows.forEach((row, i) => {
    const key = row.to.toLowerCase()
    const list = byKey.get(key)
    if (list) list.push(i)
    else byKey.set(key, [i])
  })
  for (const indexes of byKey.values()) {
    if (indexes.length < 2) continue
    for (const i of indexes) {
      const row = rows[i]
      if (row) rows[i] = { ...row, reason: 'dup' }
    }
  }

  const ok = rows.every((row) => row.reason !== 'dup' && row.reason !== 'invalid')
  return { ok, rows, unknownTokens: unknownTokensOf(tpl) }
}
