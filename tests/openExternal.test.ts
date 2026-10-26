/**
 * 「用系统浏览器打开外链」单测 —— 2026-10。
 *
 * 覆盖三块：
 * ① `resolveExternalUrl` 的**白名单语义**：http/https 放行（含大写协议、query、锚点），
 *    其余协议与畸形输入全部拒绝 —— 这是「渲染层被注入后能拉起本机程序」的安全边界；
 * ② 入口永不抛错：任何非法入参都返回结构化结果，且拒绝原因可区分；
 * ③ 源码守卫：main 里 `shell.openExternal` **之前**必须已有白名单判定调用，
 *    preload / ipc / 主进程三处接线都在。
 *
 * 为什么能直接 import：`shared/urlPolicy.ts` 刻意不 import electron / node 内置模块，
 * 所以 `environment: 'node'` 下无需任何 mock。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ALLOWED_EXTERNAL_PROTOCOLS,
  EXTERNAL_URL_MAX_LENGTH,
  isAllowedExternalUrl,
  resolveExternalUrl,
  truncateUrlForLog
} from '../src/shared/urlPolicy'

const read = (rel: string): string =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

/** 构造一个"超长但语法合法"的 URL（超过上限 1 个字符）。 */
const TOO_LONG_URL = `https://example.com/${'a'.repeat(EXTERNAL_URL_MAX_LENGTH)}`

describe('resolveExternalUrl —— 放行', () => {
  it('放行 GitHub Issue 页（设置·关于「在 GitHub 提 Issue」的实际目标）', () => {
    const url = 'https://github.com/chengcheng067/ID-BOX/issues'
    expect(resolveExternalUrl(url)).toEqual({ ok: true, url })
    expect(isAllowedExternalUrl(url)).toBe(true)
  })

  it('放行纯 http', () => {
    expect(resolveExternalUrl('http://example.com')).toEqual({
      ok: true,
      url: 'http://example.com'
    })
  })

  it('协议大小写不敏感（URL 解析器会归一化）', () => {
    expect(isAllowedExternalUrl('HTTPS://EXAMPLE.COM/Path')).toBe(true)
    expect(isAllowedExternalUrl('Http://Example.Com')).toBe(true)
  })

  it('放行带 query / 锚点 / 端口的地址', () => {
    const withQuery =
      'https://github.com/chengcheng067/ID-BOX/issues/new?title=%5BBug%5D&body=hi&labels=bug'
    expect(resolveExternalUrl(withQuery)).toEqual({ ok: true, url: withQuery })
    expect(isAllowedExternalUrl('https://example.com:8443/a/b#section-2')).toBe(true)
    expect(isAllowedExternalUrl('https://example.com/path?q=a%20b#frag')).toBe(true)
  })

  it('放行带中文（非 ASCII）的 query —— GitHub issue body 会拼中文标题', () => {
    expect(isAllowedExternalUrl('https://github.com/x/y/issues/new?title=材质球不显示')).toBe(
      true
    )
  })

  it('去首尾空白后返回，不把空白带进 shell.openExternal', () => {
    expect(resolveExternalUrl('  https://example.com  ')).toEqual({
      ok: true,
      url: 'https://example.com'
    })
  })

  it('返回值是**原串**而非 parsed.href（不能改写 Issue 的 query 语义）', () => {
    // parsed.href 会把 `https://example.com` 补成 `https://example.com/`；
    // 这里断言我们不做这个改写
    expect(resolveExternalUrl('https://example.com')).toEqual({
      ok: true,
      url: 'https://example.com'
    })
  })

  it('白名单常量只含 http/https', () => {
    expect([...ALLOWED_EXTERNAL_PROTOCOLS]).toEqual(['https:', 'http:'])
  })
})

describe('resolveExternalUrl —— 拒绝（安全边界）', () => {
  it('拒绝 javascript:（可在浏览器上下文执行脚本）', () => {
    expect(resolveExternalUrl('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'protocol'
    })
  })

  it('拒绝 file:（直接拉起本地程序 / 读本地文件）', () => {
    expect(resolveExternalUrl('file:///C:/Windows/System32/cmd.exe')).toEqual({
      ok: false,
      reason: 'protocol'
    })
    expect(resolveExternalUrl('file:///C:/Windows')).toEqual({
      ok: false,
      reason: 'protocol'
    })
  })

  it('拒绝 ms-settings: 等 ms-* 系统面板协议', () => {
    expect(resolveExternalUrl('ms-settings:')).toEqual({ ok: false, reason: 'protocol' })
    expect(resolveExternalUrl('ms-msdt:/id')).toEqual({ ok: false, reason: 'protocol' })
  })

  it('拒绝 data:（data:text/html 可执行脚本）', () => {
    expect(resolveExternalUrl('data:text/html,<script>alert(1)</script>')).toEqual({
      ok: false,
      reason: 'protocol'
    })
  })

  it('拒绝 about:（about:blank 等浏览器内部页）', () => {
    expect(resolveExternalUrl('about:blank')).toEqual({ ok: false, reason: 'protocol' })
  })

  it('拒绝其它自定义协议（ftp / steam / vscode / smb ...）', () => {
    for (const url of [
      'ftp://example.com/x',
      'steam://run/123',
      'vscode://file/C:/x',
      'smb://host/share',
      'chrome://settings'
    ]) {
      expect(resolveExternalUrl(url).ok).toBe(false)
    }
  })

  it('拒绝空串 / 纯空白', () => {
    expect(resolveExternalUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(resolveExternalUrl('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(resolveExternalUrl('\t\n')).toEqual({ ok: false, reason: 'empty' })
  })

  it('拒绝非字符串（null / undefined / number / object / array / boolean）', () => {
    for (const raw of [null, undefined, 42, 0, {}, [], true, Symbol('x')]) {
      expect(resolveExternalUrl(raw)).toEqual({ ok: false, reason: 'not-string' })
    }
  })

  it('拒绝没有 host 的 https://', () => {
    expect(resolveExternalUrl('https://')).toEqual({ ok: false, reason: 'unparsable' })
    expect(resolveExternalUrl('http://')).toEqual({ ok: false, reason: 'unparsable' })
  })

  it('拒绝超长串（> 2048）', () => {
    expect(TOO_LONG_URL.length).toBeGreaterThan(EXTERNAL_URL_MAX_LENGTH)
    expect(resolveExternalUrl(TOO_LONG_URL)).toEqual({ ok: false, reason: 'too-long' })
  })

  it('恰好 2048 字符仍放行（边界闭合）', () => {
    const prefix = 'https://example.com/'
    const exact = prefix + 'a'.repeat(EXTERNAL_URL_MAX_LENGTH - prefix.length)
    expect(exact.length).toBe(EXTERNAL_URL_MAX_LENGTH)
    expect(isAllowedExternalUrl(exact)).toBe(true)
  })

  it('拒绝含控制字符的输入（java\\nscript: 这类绕过手法）', () => {
    expect(resolveExternalUrl('java\nscript:alert(1)')).toEqual({
      ok: false,
      reason: 'control-char'
    })
    expect(resolveExternalUrl('https://example.com/\u0000x')).toEqual({
      ok: false,
      reason: 'control-char'
    })
  })

  it('永不抛错：任意脏输入都返回结构化结果', () => {
    const nasty: unknown[] = [
      '',
      ' ',
      '://',
      'https://',
      'https:///',
      'https://%',
      'https://[',
      '\u0000',
      'a'.repeat(10000),
      { toString: () => 'https://example.com' },
      (() => 'https://example.com') as unknown
    ]
    for (const raw of nasty) {
      expect(() => resolveExternalUrl(raw)).not.toThrow()
      expect(resolveExternalUrl(raw).ok).toBe(false)
    }
  })
})

describe('truncateUrlForLog', () => {
  it('短串原样返回', () => {
    expect(truncateUrlForLog('https://example.com')).toBe('https://example.com')
  })

  it('长串截断并标注原长度（避免把 4KB 噪声整段写进日志）', () => {
    const long = 'x'.repeat(500)
    const out = truncateUrlForLog(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain('len=500')
  })
})

describe('源码守卫 —— 三层接线', () => {
  it('ipc.ts 声明了通道（沿用既有 shell: 前缀命名）', () => {
    const ipc = read('shared/ipc.ts')
    expect(ipc).toContain("openExternal: 'shell:openExternal'")
  })

  it('preload 显式暴露 openExternal 并返回 Promise<boolean>', () => {
    const preload = read('preload/index.ts')
    expect(preload).toContain('ipcRenderer.invoke(IPC.openExternal, url)')
    expect(preload).toMatch(/openExternal: \(url: string\): Promise<boolean>/)
  })

  it('main 注册了 handler，且**白名单判定在 shell.openExternal 之前**', () => {
    const main = read('main/index.ts')
    const handlerAt = main.indexOf('ipcMain.handle(IPC.openExternal')
    expect(handlerAt).toBeGreaterThan(-1)

    const guardAt = main.indexOf('resolveExternalUrl(url)', handlerAt)
    const openAt = main.indexOf('shell.openExternal', handlerAt)
    expect(guardAt).toBeGreaterThan(handlerAt)
    expect(openAt).toBeGreaterThan(handlerAt)
    // 关键顺序断言：判定必须早于真正的 openExternal 调用，否则等于没校验
    expect(guardAt).toBeLessThan(openAt)
  })

  it('main 里没有残留的正则白名单（曾允许 "https://" 这种无 host 输入）', () => {
    const main = read('main/index.ts')
    // 旧实现：/^https?:\/\//i —— 只做前缀匹配，放过了 `https://`（无 host）与超长串
    expect(main).not.toContain('^https?:\\/\\/')
  })

  it('拒绝 / 失败都记 app:open-external-failed 并返回 false（不抛给渲染层）', () => {
    const main = read('main/index.ts')
    expect(main).toContain("logWarn('app:open-external-failed'")
    const handlerBody = main.slice(main.indexOf('ipcMain.handle(IPC.openExternal'))
    expect(handlerBody).toContain('return false')
    // handler 里不允许有 throw
    const handlerEnd = handlerBody.indexOf('// ── 2026-10 诊断日志')
    expect(handlerBody.slice(0, handlerEnd > 0 ? handlerEnd : undefined)).not.toContain('throw ')
  })

  it('urlPolicy 不 import electron（保证 node 环境可直接单测）', () => {
    const policy = read('shared/urlPolicy.ts')
    expect(policy).not.toMatch(/from 'electron'/)
    expect(policy).not.toMatch(/require\('electron'\)/)
  })
})
