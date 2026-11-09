/**
 * Release 说明的**受限 Markdown 解析器**（纯函数 / 零依赖 / 可单测）。
 *
 * 为什么自己写 80 行而不是引一个 markdown 库：
 * 1. **零新增依赖**是本项目的硬约束（安装包体积 + 供应链风险）；
 * 2. 完整 markdown 库动辄产出 HTML 字符串，而 HTML 字符串进 React 只剩一条路 ——
 *    `dangerouslySetInnerHTML`。Release body 是**外部输入**（谁都能在有仓库权限时写），
 *    一旦走到那条路上，一个 `<img src=x onerror=...>` 就是渲染进程里的任意代码执行，
 *    而渲染进程拿着 `window.modvault`（读写库文件 / openExternal / openPath）——
 *    等于把本机交出去。
 *
 * 因此本模块的**输出没有任何 HTML**：只有结构化的 token 数组，由 React 用
 * `{span.text}` 插值渲染（React 默认转义文本节点）。第一道防线是"我们根本不生成 HTML"，
 * 而不是"过滤掉危险标签"（黑名单永远漏）。
 *
 * 支持范围（够覆盖本仓库 Release 说明的实际形态，多一个字都不做）：
 * - 块级：`#`~`######` 标题（>3 级归到 3 级，弹窗里字号只分三档）/ `- * +` 无序列表 /
 *   `1.` 有序列表 / 单独一行的 `---` `***` `___` 分隔线 / 连续非空行合成段落 / 空行分段
 * - 行内：`` `代码` ``（内部不再解析任何语法）/ `[文字](url)` 链接（仅 http(s)）/ `**粗体**`
 * - **不支持**（刻意）：图片、表格、引用块、嵌套列表、HTML 透传、`*斜体*`、脚注、语法高亮。
 *   不支持的语法**原样当文本**显示 —— 宁可丑，也不能有第二条渲染通路。
 */

// ── 输出类型（结构化 token，绝不含 HTML 字符串） ──────────────────────────

/**
 * 块级 token。
 *
 * 刻意**没有** `html` 成员，也没有 `raw`：渲染层只能渲染这四种形状，
 * 想插 HTML 都没有对应的 token 可用（这是编译期就堵死的一条路）。
 */
export type NotesBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string }
  | { type: 'rule' }

/** 行内 token（`link` 的 href 已通过 http(s) 白名单校验） */
export type InlineSpan =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }

// ── 行内解析 ──────────────────────────────────────────────────────────────

/**
 * 链接 href 的**唯一放行规则**：必须显式以 `http://` 或 `https://` 开头（大小写不敏感）。
 *
 * 为什么是白名单前缀而不是黑名单：`javascript:` / `data:text/html,...` / `file:///C:/Windows/System32/cmd.exe`
 * / `ms-settings:` 这类协议列不完，而 Release 说明里合法的外链只有 http(s) 一种。
 * 相对路径（`/chengcheng067/ID-BOX`）也一并降级 —— 它们没有可打开的绝对地址。
 *
 * 注意这是**第一道**闸：点击时还会走主进程的 `resolveExternalUrl()`（协议白名单 +
 * 控制字符 + 长度 + `new URL` 解析），两道都不放行才真的打不开。
 */
const SAFE_HREF_RE = /^https?:\/\//i

/** 控制字符（C0 + DEL）：`java\nscript:` 这类靠换行绕过的载荷在这里就断掉 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/

/** 代码 / 链接 / 粗体的定界符（集中在这里，避免三处各写一遍字面量） */
const CODE_DELIM = '`'
const STRONG_DELIM = '**'

/** 判断一个 href 是否允许渲染成链接（纯函数，可单测） */
function isSafeHref(href: string): boolean {
  return SAFE_HREF_RE.test(href) && !CONTROL_CHARS_RE.test(href)
}

/** 把若干 span 追加到输出（丢掉空文本；空 span 在 React 里会渲染出多余节点） */
function pushSpan(out: InlineSpan[], span: InlineSpan): void {
  if (!span.text) return
  out.push(span)
}

/**
 * 第 ① 遍：按反引号切出**行内代码**。
 *
 * 代码段一旦切出来就冻结了 —— 后续的链接 / 粗体解析只看 `kind:'text'` 的片段，
 * 于是 `` `**not bold**` `` 里的 `**` 不会被当成粗体（这正是我们要的语义）。
 */
function splitCode(text: string): Array<{ kind: 'code'; text: string } | { kind: 'text'; text: string }> {
  const parts: Array<{ kind: 'code'; text: string } | { kind: 'text'; text: string }> = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf(CODE_DELIM, cursor)
    // 没有反引号了（或只剩下一个孤立的）：剩下的全是文本
    if (open < 0) {
      parts.push({ kind: 'text', text: text.slice(cursor) })
      break
    }
    const close = text.indexOf(CODE_DELIM, open + 1)
    // 孤立反引号（`a `b` 只有一个）：当普通字符，继续往后找
    if (close < 0) {
      parts.push({ kind: 'text', text: text.slice(cursor) })
      break
    }
    if (open > cursor) parts.push({ kind: 'text', text: text.slice(cursor, open) })
    const inner = text.slice(open + 1, close)
    // 空代码 `` 没有意义：原样当文本（避免产出空 code span）
    if (inner) parts.push({ kind: 'code', text: inner })
    else parts.push({ kind: 'text', text: text.slice(open, close + 1) })
    cursor = close + 1
  }
  return parts
}

/**
 * 第 ② 遍：在纯文本片段里切 `[文字](url)`。
 *
 * **降级规则（关键安全点）**：href 不满足 `isSafeHref` 时，**不产出 link token**，
 * 只把可读的 label 当文本输出（href 连同括号一起丢弃）。用户看到的是「文字」而不是
 * `[文字](javascript:alert(1))` 这串源码 —— 既不可点击，也不执行。
 *
 * href 用**括号配平**的方式找结尾（不是"下一个右括号"）：`javascript:alert(1)` 里的
 * `)` 只是载荷的一部分，按第一个 `)` 切会把 `)` 漏成正文（既难看，也说明切法不可靠）；
 * 配平还能正确处理 `https://en.wikipedia.org/wiki/Foo_(bar)` 这类合法地址。
 *
 * 图片语法 `![alt](url)` 会先命中这里的 `[`，于是渲染成前面一个 `!` + 链接文字，
 * **不会**产出 `<img>`（本模块根本没有 image token）。
 */
function splitLinks(text: string): InlineSpan[] {
  const out: InlineSpan[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('[', cursor)
    if (open < 0) {
      pushSpan(out, { type: 'text', text: text.slice(cursor) })
      break
    }
    const close = text.indexOf(']', open + 1)
    // 没闭合 / 后面不是 `(`：这个 `[` 是普通字符，往后挪一格继续
    if (close < 0 || text[close + 1] !== '(') {
      pushSpan(out, { type: 'text', text: text.slice(cursor, open + 1) })
      cursor = open + 1
      continue
    }
    // 从 `(` 之后开始配平括号（深度 1 = 已进入 href 内部）
    let depth = 1
    let index = close + 2
    while (index < text.length && depth > 0) {
      const ch = text[index]
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
      index += 1
    }
    // 没有配平的右括号：整个 `[` 当普通字符，往后继续扫
    if (depth !== 0) {
      pushSpan(out, { type: 'text', text: text.slice(cursor, open + 1) })
      cursor = open + 1
      continue
    }
    const paren = index - 1
    const before = text.slice(cursor, open)
    const label = text.slice(open + 1, close)
    const href = text.slice(close + 2, paren).trim()
    pushSpan(out, { type: 'text', text: before })
    if (label && isSafeHref(href)) {
      pushSpan(out, { type: 'link', text: label, href })
    } else {
      // 危险协议 / 相对路径 / 空 label：降级成纯文本（只留可读的 label）
      pushSpan(out, { type: 'text', text: label || text.slice(open, paren + 1) })
    }
    cursor = paren + 1
  }
  return out
}

/**
 * 合并相邻的 text span。
 *
 * 必要性：三轮解析各自会切出"半截文本"（`[` 前面一段、`[` 后面一段），不合并的话
 * 一次 `parseInline` 可能吐出七八个相邻 text 节点 —— 对渲染结果没影响，但会让
 * 输出难读、单测断言变成"数节点"而不是"看内容"。
 */
function mergeTextSpans(spans: InlineSpan[]): InlineSpan[] {
  const out: InlineSpan[] = []
  for (const span of spans) {
    const last = out[out.length - 1]
    if (span.type === 'text' && last !== undefined && last.type === 'text') {
      out[out.length - 1] = { type: 'text', text: last.text + span.text }
      continue
    }
    out.push(span)
  }
  return out
}


/**
 * 第 ③ 遍：在纯文本片段里切 `**粗体**`。
 *
 * 落单的 `**`（没有配对的）原样当文本：Release 说明里偶尔有人写 `2**3` 这种东西，
 * 静默吞掉一个会让人以为内容丢了。
 */
function splitStrong(text: string): InlineSpan[] {
  const out: InlineSpan[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf(STRONG_DELIM, cursor)
    if (open < 0) {
      pushSpan(out, { type: 'text', text: text.slice(cursor) })
      break
    }
    const close = text.indexOf(STRONG_DELIM, open + STRONG_DELIM.length)
    if (close < 0) {
      pushSpan(out, { type: 'text', text: text.slice(cursor) })
      break
    }
    const inner = text.slice(open + STRONG_DELIM.length, close)
    pushSpan(out, { type: 'text', text: text.slice(cursor, open) })
    // 空粗体 `****`：当文本，不产出空 strong
    if (inner) pushSpan(out, { type: 'strong', text: inner })
    else pushSpan(out, { type: 'text', text: text.slice(open, close + STRONG_DELIM.length) })
    cursor = close + STRONG_DELIM.length
  }
  return out
}

/**
 * 行内解析（对外唯一入口）：Markdown 行内语法 → span 数组。
 *
 * **解析顺序（不可调整）**：先切 code → 再切 link → 再切 strong → 剩余为 text。
 * 顺序即优先级，理由：
 * - code 最先：反引号内的内容**不再解析任何语法**（`` `**a**` `` 是字面 `**a**`）；
 * - link 先于 strong：`[**a**](url)` 的 label 里虽然含 `**`，但链接语义更明确，
 *   先按链接切开后 label 再走一遍 strong 太复杂 —— 本实现让 label 原样进 link.text
 *   （label 里的 `**` 会显示成字面星号，可接受，且绝不产生第二条渲染通路）；
 * - 剩下没有构造的才当 text。
 *
 * 安全边界：无论输入是什么（`<script>alert(1)</script>` / `<img onerror=x>`），
 * 输出里**只有四种 token**，HTML 标签只会作为 `text` 的字面内容出现 —— 由 React
 * 文本插值转义后显示为可见字符，不会进 DOM 树。
 *
 * @param text 一行（或一段合并后的）文本
 * @returns span 数组；空串返回 `[]`
 */
export function parseInline(text: string): InlineSpan[] {
  if (typeof text !== 'string' || !text) return []
  const out: InlineSpan[] = []
  for (const part of splitCode(text)) {
    if (part.kind === 'code') {
      pushSpan(out, { type: 'code', text: part.text })
      continue
    }
    for (const afterLink of splitLinks(part.text)) {
      if (afterLink.type !== 'text') {
        out.push(afterLink)
        continue
      }
      for (const span of splitStrong(afterLink.text)) out.push(span)
    }
  }
  return mergeTextSpans(out)
}

// ── 块级解析 ──────────────────────────────────────────────────────────────

/** 分隔线：`---` / `***` / `___`（各 3 个及以上，整行只有这些字符） */
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/

/**
 * 标题：`#` 后必须有空白（`#hashtag` 不是标题）。
 * 4 级及以上统一归到 3 级 —— 弹窗里只准备了三档字号，多出来的档位没有视觉意义。
 */
const HEADING_RE = /^(#{1,6})\s+(.*)$/

/** 无序列表：`- ` / `* ` / `+ `（**必须**有空白，否则 `-5°` 这种是普通文本） */
const UNORDERED_RE = /^[-*+]\s+(.*)$/

/** 有序列表：`1. ` / `1) `（最多 9 位数字，够用且能避免把超长数字串当列表） */
const ORDERED_RE = /^\d{1,9}[.)]\s+(.*)$/

/**
 * 空标题 / 空列表项（整行只有 `##` 或只有 `-`）—— 这两种行**没有任何内容**，
 * 既不产出 heading 也不产出空圆点，同时**不打断**当前列表（`- 甲\n-\n- 丙` 仍是一个列表）。
 *
 * 不处理的话它们会掉进"普通行"分支变成段落里的两个 `##` / `-` 字面字符 —— 那是 bug 的形状。
 */
const EMPTY_MARKER_RE = /^(?:#{1,6}|[-*+]|\d{1,9}[.)])$/

/** 标题级别收敛到 1|2|3（`####` 及更深 → 3） */
function headingLevel(hashes: string): 1 | 2 | 3 {
  if (hashes.length <= 1) return 1
  if (hashes.length === 2) return 2
  return 3
}

/**
 * 块级解析（对外唯一入口）：Markdown → `NotesBlock[]`。
 *
 * 规则（与 `types.ts` 里 `UpdateInfo.notes` 的注释配套）：
 * - 行首 `#`~`######` + 空白 → heading（1/2/3 级；4 级及以上归 3 级）；
 * - 行首 `- `/`* `/`+ ` → 无序列表项，连续的同类行合成**一个** list 块；
 * - 行首 `1. ` / `1) ` → 有序列表（同上合成一块）；
 * - 整行 `---`/`***`/`___` → rule；
 * - 其它非空行 → 段落，**连续多行合并成一段**（换行在 Markdown 里本来就是软换行，
 *   用空格拼接后交给浏览器正常折行，不保留硬换行 —— 否则 GitHub 的 80 列折行会
 *   变成一堆断裂的短句）；
 * - 空行 → 结束当前块（段落与列表都刷新）；
 * - 列表项内容为空（只有 `- `）→ 丢弃该项，不产出空圆点。
 *
 * 输入 `null` / 空串 / 全空白 → `[]`（调用方据此显示「没有更新说明」）。
 *
 * @param markdown Release 说明原文（`UpdateInfo.notes`）
 * @returns 块数组，按原文顺序
 */
export function parseReleaseNotes(markdown: string | null): NotesBlock[] {
  if (typeof markdown !== 'string') return []
  // 主进程已归一化过 `\r`，这里再兜一次：本函数也可能被别处直接喂原始文本（单测）
  const normalized = markdown.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return []

  const blocks: NotesBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  const flushList = (): void => {
    if (list === null) return
    if (list.items.length > 0) blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  const flushAll = (): void => {
    flushParagraph()
    flushList()
  }

  for (const rawLine of normalized.split('\n')) {
    // 不做嵌套列表，所以两端的空白都可以裁掉（缩进的列表项当成同级项）
    const line = rawLine.trim()
    if (!line) {
      flushAll()
      continue
    }
    if (RULE_RE.test(line)) {
      flushAll()
      blocks.push({ type: 'rule' })
      continue
    }
    // 空标题 / 空列表项：本行没有内容，直接跳过（不打断段落也不打断列表）
    if (EMPTY_MARKER_RE.test(line)) continue
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const text = heading[2].trim()
      // `## ` 后面什么都没有：不产出空标题（GitHub 上的空标题也只是一条空行）
      if (text) {
        flushAll()
        blocks.push({ type: 'heading', level: headingLevel(heading[1]), text })
      }
      continue
    }
    const unordered = UNORDERED_RE.exec(line)
    if (unordered) {
      flushParagraph()
      // 有序 ↔ 无序交替 = 两个列表块（否则 1. 后面跟 - 会被并成一个）
      if (list === null || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      const item = unordered[1].trim()
      if (item) list.items.push(item)
      continue
    }
    const ordered = ORDERED_RE.exec(line)
    if (ordered) {
      flushParagraph()
      if (list === null || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      const item = ordered[1].trim()
      if (item) list.items.push(item)
      continue
    }
    // 普通行：结束列表，累进当前段落（连续行合成一段）
    flushList()
    paragraph.push(line)
  }

  flushAll()
  return blocks
}
