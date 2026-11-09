/**
 * Release 说明受限解析器单测（2026-11）。
 *
 * 这份文件守两件事，缺一不可：
 * ① **功能**：GitHub Release 说明的真实形态（中文标题 / 无序列表 / 有序列表 / 段落 /
 *    水平线 / 粗体 / 行内代码 / 链接）都能解析成正确的 token；
 * ② **安全**：`parseInline` 的输出里只可能出现 text / strong / code / link 四种 token，
 *    `<script>` 只会作为**文本内容**出现（React 插值转义，不进 DOM 结构），
 *    `javascript:` / `file:` / 相对路径一律降级成纯文本、不产出 link。
 *
 * 为什么安全边界要在这一层测：这是**唯一**把外部输入（GitHub 的 body）翻译成
 * 可渲染结构的地方。上游（主进程）不做清洗，下游（组件）只是 map —— 这一层漏了，
 * 渲染进程就等于拿到了任意 HTML 执行能力（它持有 `window.modvault`）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseInline,
  parseReleaseNotes,
  type InlineSpan,
  type NotesBlock
} from '../src/renderer/logic/releaseNotes'

const read = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

/** 一份形如本仓库真实 Release 说明的 body（中文 Markdown） */
const REAL_BODY = [
  '## 新功能',
  '',
  '- 材质球支持 HDR 环境贴图',
  '- 导入队列支持**批量取消**',
  '',
  '### 修复',
  '',
  '1. 修复深色主题下卡片描边过亮',
  '2. 修复 `MAX_PATH` 超长路径导入失败',
  '',
  '---',
  '',
  '完整说明见 [Release 页面](https://github.com/chengcheng067/ID-BOX/releases)。'
].join('\n')

describe('parseReleaseNotes：块级解析', () => {
  it('真实形态：标题 / 无序列表 / 有序列表 / 水平线 / 段落按序产出', () => {
    const blocks = parseReleaseNotes(REAL_BODY)
    expect(blocks).toEqual<NotesBlock[]>([
      { type: 'heading', level: 2, text: '新功能' },
      {
        type: 'list',
        ordered: false,
        items: ['材质球支持 HDR 环境贴图', '导入队列支持**批量取消**']
      },
      { type: 'heading', level: 3, text: '修复' },
      {
        type: 'list',
        ordered: true,
        items: ['修复深色主题下卡片描边过亮', '修复 `MAX_PATH` 超长路径导入失败']
      },
      { type: 'rule' },
      { type: 'paragraph', text: '完整说明见 [Release 页面](https://github.com/chengcheng067/ID-BOX/releases)。' }
    ])
  })

  it('标题级别：1/2 级照抄，4 级及以上统一归到 3 级', () => {
    const blocks = parseReleaseNotes('# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级')
    expect(blocks).toEqual<NotesBlock[]>([
      { type: 'heading', level: 1, text: '一级' },
      { type: 'heading', level: 2, text: '二级' },
      { type: 'heading', level: 3, text: '三级' },
      { type: 'heading', level: 3, text: '四级' },
      { type: 'heading', level: 3, text: '五级' }
    ])
  })

  it('`#hashtag` 不是标题（`#` 后必须有空白）', () => {
    expect(parseReleaseNotes('#hashtag 只是文本')).toEqual<NotesBlock[]>([
      { type: 'paragraph', text: '#hashtag 只是文本' }
    ])
  })

  it('空标题（`## ` 后面什么都没有）不产出空 heading', () => {
    expect(parseReleaseNotes('## \n正文')).toEqual<NotesBlock[]>([
      { type: 'paragraph', text: '正文' }
    ])
  })

  it('三种水平线都认：--- / *** / ___', () => {
    const blocks = parseReleaseNotes('---\n***\n___')
    expect(blocks).toEqual<NotesBlock[]>([{ type: 'rule' }, { type: 'rule' }, { type: 'rule' }])
  })

  it('三个无序列表符号都认：- / * / +', () => {
    const blocks = parseReleaseNotes('- 甲\n* 乙\n+ 丙')
    expect(blocks).toEqual<NotesBlock[]>([
      { type: 'list', ordered: false, items: ['甲', '乙', '丙'] }
    ])
  })

  it('有序列表 `1.` 与 `1)` 都认，且连续行合成一个列表块', () => {
    const blocks = parseReleaseNotes('1. 甲\n2) 乙\n3. 丙')
    expect(blocks).toEqual<NotesBlock[]>([
      { type: 'list', ordered: true, items: ['甲', '乙', '丙'] }
    ])
  })

  it('有序 ↔ 无序交替 = 两个列表块（不会被并成一个）', () => {
    const blocks = parseReleaseNotes('1. 甲\n- 乙')
    expect(blocks).toEqual<NotesBlock[]>([
      { type: 'list', ordered: true, items: ['甲'] },
      { type: 'list', ordered: false, items: ['乙'] }
    ])
  })

  it('空列表项（只有 `- `）被丢弃，不产出空圆点', () => {
    const blocks = parseReleaseNotes('- 甲\n- \n- 丙')
    expect(blocks).toEqual<NotesBlock[]>([{ type: 'list', ordered: false, items: ['甲', '丙'] }])
  })

  it('连续非空行合成一个段落（软换行合并成空格）', () => {
    const blocks = parseReleaseNotes('第一行\n第二行\n\n第二段')
    expect(blocks).toEqual<NotesBlock[]>([
      { type: 'paragraph', text: '第一行 第二行' },
      { type: 'paragraph', text: '第二段' }
    ])
  })

  it('列表紧接段落：列表先收口，段落不吞掉列表', () => {
    const blocks = parseReleaseNotes('- 甲\n普通行')
    expect(blocks).toEqual<NotesBlock[]>([
      { type: 'list', ordered: false, items: ['甲'] },
      { type: 'paragraph', text: '普通行' }
    ])
  })

  it('边界：null / 空串 / 只有空行与空白 → 空数组', () => {
    expect(parseReleaseNotes(null)).toEqual([])
    expect(parseReleaseNotes('')).toEqual([])
    expect(parseReleaseNotes('   \n\n \t \n')).toEqual([])
  })

  it('CRLF 输入等价于 LF（主进程会归一化，这里再兜一次）', () => {
    expect(parseReleaseNotes('## 标题\r\n- 甲')).toEqual<NotesBlock[]>([
      { type: 'heading', level: 2, text: '标题' },
      { type: 'list', ordered: false, items: ['甲'] }
    ])
  })

  it('超长单行不崩、不丢内容（一个段落装下全部）', () => {
    const long = 'x'.repeat(100_000)
    const blocks = parseReleaseNotes(long)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual<NotesBlock>({ type: 'paragraph', text: long })
  })
})

describe('parseInline：行内解析顺序与安全边界', () => {
  it('`**粗体**` → strong', () => {
    expect(parseInline('前 **粗** 后')).toEqual<InlineSpan[]>([
      { type: 'text', text: '前 ' },
      { type: 'strong', text: '粗' },
      { type: 'text', text: ' 后' }
    ])
  })

  it('行内代码优先：代码里的 `**` 不再解析成粗体', () => {
    expect(parseInline('`**not bold**`')).toEqual<InlineSpan[]>([
      { type: 'code', text: '**not bold**' }
    ])
  })

  it('行内代码与粗体混排', () => {
    expect(parseInline('修 `MAX_PATH` 与**长路径**')).toEqual<InlineSpan[]>([
      { type: 'text', text: '修 ' },
      { type: 'code', text: 'MAX_PATH' },
      { type: 'text', text: ' 与' },
      { type: 'strong', text: '长路径' }
    ])
  })

  it('https 链接 → link（href 原样保留）', () => {
    expect(parseInline('[官网](https://github.com/chengcheng067/ID-BOX)')).toEqual<InlineSpan[]>([
      { type: 'link', text: '官网', href: 'https://github.com/chengcheng067/ID-BOX' }
    ])
  })

  it('http 链接也放行（首字母大小写不敏感）', () => {
    expect(parseInline('[a](HTTP://example.com/x)')).toEqual<InlineSpan[]>([
      { type: 'link', text: 'a', href: 'HTTP://example.com/x' }
    ])
  })

  it('⛔ javascript: 链接降级为纯文本（不产出 link token）', () => {
    expect(parseInline('[点我](javascript:alert(1))')).toEqual<InlineSpan[]>([
      { type: 'text', text: '点我' }
    ])
  })

  it('⛔ file: / data: / ms-settings: / 相对路径一律降级', () => {
    for (const href of [
      'file:///C:/Windows/System32/cmd.exe',
      'data:text/html,<script>alert(1)</script>',
      'ms-settings:',
      '/chengcheng067/ID-BOX',
      '//evil.example.com/x'
    ]) {
      const spans = parseInline(`[危险](${href})`)
      expect(spans.some((s) => s.type === 'link')).toBe(false)
      expect(spans).toEqual<InlineSpan[]>([{ type: 'text', text: '危险' }])
    }
  })

  it('⛔ href 含换行/控制字符（`java\\nscript:`）也降级', () => {
    const spans = parseInline('[x](java\nscript:alert(1))')
    expect(spans.some((s) => s.type === 'link')).toBe(false)
  })

  it('⛔ `<script>alert(1)</script>` 原样当文本（只有一个 text span，不含任何标签结构）', () => {
    const spans = parseInline('<script>alert(1)</script>')
    expect(spans).toEqual<InlineSpan[]>([{ type: 'text', text: '<script>alert(1)</script>' }])
    // 输出里没有 html/raw 这类 token —— 结构上就不可能被当 HTML 插入
    expect(spans.every((s) => ['text', 'strong', 'code', 'link'].includes(s.type))).toBe(true)
  })

  it('⛔ 文本里的 `<img src=x onerror=...>` 也只是字面字符', () => {
    const spans = parseInline('<img src=x onerror=alert(1)>')
    expect(spans).toEqual<InlineSpan[]>([{ type: 'text', text: '<img src=x onerror=alert(1)>' }])
  })

  it('落单的 `**` 原样保留（不静默吞字符）', () => {
    expect(parseInline('2**3 是幂运算')).toEqual<InlineSpan[]>([
      { type: 'text', text: '2**3 是幂运算' }
    ])
  })

  it('空代码 `` 与空粗体 `****` 都当文本，不产出空 token', () => {
    expect(parseInline('``')).toEqual<InlineSpan[]>([{ type: 'text', text: '``' }])
    expect(parseInline('****')).toEqual<InlineSpan[]>([{ type: 'text', text: '****' }])
  })

  it('没闭合的 `[` / `]` / 缺 `(` 都当普通字符（不吞掉后文）', () => {
    expect(parseInline('看 [这里 没有括号')).toEqual<InlineSpan[]>([
      { type: 'text', text: '看 [这里 没有括号' }
    ])
    expect(parseInline('[只有方括号]')).toEqual<InlineSpan[]>([
      { type: 'text', text: '[只有方括号]' }
    ])
  })

  it('边界：空串 → 空数组', () => {
    expect(parseInline('')).toEqual([])
  })
})

describe('源码守卫：渲染通路只有一条（结构化 token → React 插值）', () => {
  /**
   * 剥掉注释再断言。
   *
   * 必须剥：`releaseNotes.ts` 的文件头**正是在解释"为什么不用危险写法"**，
   * 里面必然出现那个标识符。裸正则守卫会把这个说明当成违规命中 —— 守卫误报比没有守卫更糟
   * （下一个人会把守卫删掉）。`(^|[^:])//` 的 `[^:]` 是为了不切掉 `https://` 这类 URL。
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('解析器与弹窗都**没有** dangerouslySetInnerHTML / innerHTML 赋值', () => {
    for (const file of [
      'renderer/logic/releaseNotes.ts',
      'renderer/components/UpdateNotesDialog.tsx'
    ]) {
      const source = stripComments(read(file))
      expect(source).not.toContain('dangerouslySetInnerHTML')
      // `innerHTML =` / `outerHTML =` 同样是绕过 React 转义的写法
      expect(source).not.toMatch(/\.(inner|outer)HTML\s*=/)
    }
  })

  it('弹窗不产出 `<a href>`（Electron 里没有 will-navigate 兜底，一个漏写的 preventDefault 就是整页导航）', () => {
    const source = read('renderer/components/UpdateNotesDialog.tsx')
    // 只认真正的标签属性写法：`href="` / `href={'`；`title={span.href}` 这种不该误命中
    expect(source).not.toMatch(/href\s*=\s*["'{]/)
    expect(source).toContain('openExternal')
  })

  it('弹窗不新增 `dark:` 变体（主题切换走 [data-theme] 属性选择器）', () => {
    const source = read('renderer/components/UpdateNotesDialog.tsx')
    expect(source).not.toMatch(/(^|[\s"'`])dark:[a-z]/)
  })
})
