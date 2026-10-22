/**
 * 自动检查更新（GitHub Releases）单测 —— 2026-10。
 *
 * 覆盖四块：
 * ① `compareVersions` 的**数字逐段**语义（字符串比较会错的那些用例）；
 * ② `fetchLatestRelease` 的全部失败分支（**注入 fetcher，绝不真联网**）；
 * ③ 设置项 `autoCheckUpdate` 的默认 / 脏值归一化（缺键与脏值都必须回落 true）；
 * ④ 源码守卫：关于页真的渲染了「立即检查」「启动时自动检查更新」，且颜色走 token、
 *    开关复用设置页既有 `Toggle`（用户明确要求不用原生 checkbox）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  GITHUB_LATEST_RELEASE_URL,
  UPDATE_CHECK_TIMEOUT_MS,
  compareVersions,
  fetchLatestRelease,
  normalizeVersion,
  type UpdateFetchInit
} from '../src/main/updateCheck'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { migrateSettings, normalizeSettings, SettingsSchema } from '../src/main/settings'

const read = (rel: string): string =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

/** 构造一个假 Response（只实现模块用到的 ok / status / json） */
function fakeResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

/** 记录最后一次请求，便于断言 URL / 头 / 超时信号 */
function recordingFetcher(respond: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>) {
  const calls: Array<{ url: string; init: UpdateFetchInit }> = []
  const fetcher = async (url: string, init: UpdateFetchInit) => {
    calls.push({ url, init })
    return respond()
  }
  return { calls, fetcher }
}

/** 一份完整的 GitHub release JSON */
function releaseBody(over: Record<string, unknown> = {}) {
  return {
    tag_name: 'v0.6.9',
    html_url: 'https://github.com/chengcheng067/ID-BOX/releases/tag/v0.6.9',
    published_at: '2026-10-26T10:00:00Z',
    prerelease: false,
    draft: false,
    assets: [
      {
        name: 'IDBOX-Setup-0.6.9.exe',
        browser_download_url:
          'https://github.com/chengcheng067/ID-BOX/releases/download/v0.6.9/IDBOX-Setup-0.6.9.exe'
      },
      { name: 'latest.yml', browser_download_url: 'https://example.com/latest.yml' }
    ],
    ...over
  }
}

// ── ① 版本比较 ────────────────────────────────────────────────────────
describe('compareVersions（语义化比较，绝不逐字符比较）', () => {
  it('0.6.10 > 0.6.9（字符串比较会判成更小）', () => {
    expect(compareVersions('0.6.10', '0.6.9')).toBe(1)
    expect(compareVersions('0.6.9', '0.6.10')).toBe(-1)
  })

  it('v 前缀不影响比较：v0.7.0 > 0.6.8', () => {
    expect(compareVersions('v0.7.0', '0.6.8')).toBe(1)
    expect(compareVersions('0.6.8', 'v0.7.0')).toBe(-1)
  })

  it('0.6.8 == v0.6.8（同版本视为相等）', () => {
    expect(compareVersions('0.6.8', 'v0.6.8')).toBe(0)
    expect(compareVersions('V0.6.8', 'v0.6.8')).toBe(0)
  })

  it('位数不齐按缺位 0 补齐：0.7 > 0.6.9，0.7 == 0.7.0', () => {
    expect(compareVersions('0.7', '0.6.9')).toBe(1)
    expect(compareVersions('0.7', '0.7.0')).toBe(0)
    expect(compareVersions('1', '0.9.9')).toBe(1)
  })

  it('正式版大于同号预发布版；构建元数据不参与比较', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBe(1)
    expect(compareVersions('1.0.0+build.9', '1.0.0')).toBe(0)
  })

  it('无法解析时退化为字符串比较（不抛错）', () => {
    expect(() => compareVersions('nightly', 'latest')).not.toThrow()
    expect(compareVersions('abc', 'abc')).toBe(0)
  })

  it('normalizeVersion 只去 v 前缀', () => {
    expect(normalizeVersion('v0.6.8')).toBe('0.6.8')
    expect(normalizeVersion('  V1.2.3  ')).toBe('1.2.3')
    expect(normalizeVersion('0.6.8')).toBe('0.6.8')
  })
})

// ── ② fetchLatestRelease（注入 fetcher） ───────────────────────────────
describe('fetchLatestRelease（全部路径都不抛错）', () => {
  it('请求固定端点 + GitHub 头；不带 Authorization；有 8 秒超时信号', async () => {
    const { calls, fetcher } = recordingFetcher(async () => fakeResponse(releaseBody()))
    await fetchLatestRelease({ current: '0.6.8', fetcher })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(GITHUB_LATEST_RELEASE_URL)
    expect(calls[0].init.headers.Accept).toBe('application/vnd.github+json')
    expect(calls[0].init.headers['User-Agent']).toBe('IDBOX/0.6.8')
    expect(Object.keys(calls[0].init.headers).map((k) => k.toLowerCase())).not.toContain(
      'authorization'
    )
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(8000)
  })

  it('有新版本：hasUpdate=true + 安装包直链 + Release 页 + 发布时间', async () => {
    const { fetcher } = recordingFetcher(async () => fakeResponse(releaseBody()))
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher, now: 1_700_000_000_000 })

    expect(info).toEqual({
      current: '0.6.8',
      latest: '0.6.9',
      hasUpdate: true,
      url: 'https://github.com/chengcheng067/ID-BOX/releases/tag/v0.6.9',
      assetUrl:
        'https://github.com/chengcheng067/ID-BOX/releases/download/v0.6.9/IDBOX-Setup-0.6.9.exe',
      publishedAt: '2026-10-26T10:00:00Z',
      checkedAt: 1_700_000_000_000,
      error: null
    })
  })

  it('已是最新：tag == current → hasUpdate=false', async () => {
    const { fetcher } = recordingFetcher(async () => fakeResponse(releaseBody({ tag_name: 'v0.6.8' })))
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.hasUpdate).toBe(false)
    expect(info.latest).toBe('0.6.8')
    expect(info.error).toBeNull()
  })

  it('本地版本更新的情况不会"降级"：latest < current → hasUpdate=false', async () => {
    const { fetcher } = recordingFetcher(async () => fakeResponse(releaseBody({ tag_name: 'v0.6.7' })))
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.hasUpdate).toBe(false)
  })

  it('HTTP 404 → error="http"，其余字段保持安全默认值', async () => {
    const { fetcher } = recordingFetcher(async () => fakeResponse({ message: 'Not Found' }, false, 404))
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.error).toBe('http')
    expect(info.latest).toBeNull()
    expect(info.hasUpdate).toBe(false)
    expect(info.assetUrl).toBeNull()
  })

  it('网络抛错（断网 / DNS / 超时）→ error="network"', async () => {
    const fetcher = async () => {
      throw new Error('ENOTFOUND api.github.com')
    }
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.error).toBe('network')
    expect(info.hasUpdate).toBe(false)
  })

  it('没有 fetch 能力（fetcher:null）→ error="network"，不抛错', async () => {
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher: null })
    expect(info.error).toBe('network')
  })

  it('JSON 缺 tag_name → error="parse"', async () => {
    const { fetcher } = recordingFetcher(async () => fakeResponse({ html_url: 'https://x' }))
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.error).toBe('parse')
    expect(info.hasUpdate).toBe(false)
  })

  it('JSON 不是对象 / json() 抛错 → error="parse"', async () => {
    const badJson = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('unexpected token')
      }
    })
    expect((await fetchLatestRelease({ current: '0.6.8', fetcher: badJson })).error).toBe('parse')

    const arrayBody = async () => fakeResponse([1, 2, 3])
    expect((await fetchLatestRelease({ current: '0.6.8', fetcher: arrayBody })).error).toBe('parse')
  })

  it('tag 不是版本号（nightly）→ error="parse"', async () => {
    const { fetcher } = recordingFetcher(async () => fakeResponse(releaseBody({ tag_name: 'nightly' })))
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.error).toBe('parse')
  })

  it('prerelease=true → 当作"无更新"（不是错误）', async () => {
    const { fetcher } = recordingFetcher(async () =>
      fakeResponse(releaseBody({ tag_name: 'v0.7.0', prerelease: true }))
    )
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.error).toBeNull()
    expect(info.hasUpdate).toBe(false)
    expect(info.latest).toBe('0.7.0')
  })

  it('draft=true → 同样当作"无更新"', async () => {
    const { fetcher } = recordingFetcher(async () =>
      fakeResponse(releaseBody({ tag_name: 'v0.7.0', draft: true }))
    )
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.error).toBeNull()
    expect(info.hasUpdate).toBe(false)
  })

  it('assets 里没有 IDBOX-Setup-*.exe 时 assetUrl=null（不猜别的资产）', async () => {
    const { fetcher } = recordingFetcher(async () =>
      fakeResponse(releaseBody({ assets: [{ name: 'latest.yml', browser_download_url: 'https://x/a.yml' }] }))
    )
    const info = await fetchLatestRelease({ current: '0.6.8', fetcher })
    expect(info.hasUpdate).toBe(true)
    expect(info.assetUrl).toBeNull()
  })

  it('current 带 v 前缀会被归一化（避免 v0.6.8 与 0.6.8 比错）', async () => {
    const { fetcher } = recordingFetcher(async () => fakeResponse(releaseBody()))
    const info = await fetchLatestRelease({ current: 'v0.6.8', fetcher })
    expect(info.current).toBe('0.6.8')
    expect(info.hasUpdate).toBe(true)
  })
})

// ── ③ 设置项 autoCheckUpdate ──────────────────────────────────────────
describe('autoCheckUpdate 设置（默认开，缺键 / 脏值都回落 true）', () => {
  const base = (): Partial<Settings> => ({ libraryDir: 'E:\\ModVault\\Library' })

  it('默认值为 true', () => {
    expect(DEFAULT_SETTINGS.autoCheckUpdate).toBe(true)
    expect(normalizeSettings(base()).autoCheckUpdate).toBe(true)
  })

  it('显式关闭被保留', () => {
    expect(normalizeSettings({ ...base(), autoCheckUpdate: false }).autoCheckUpdate).toBe(false)
  })

  it('脏值（字符串 / 数字 / null / 对象）一律回落 true，不抛错', () => {
    const dirty: unknown[] = ['yes', 'false', 1, 0, null, {}, []]
    for (const v of dirty) {
      const s = normalizeSettings({ ...base(), autoCheckUpdate: v } as unknown as Partial<Settings>)
      expect(s.autoCheckUpdate).toBe(true)
    }
  })

  it('zod 单项降级：脏值不拖垮整份设置（libraryDir 仍在）', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: 'E:\\ModVault\\Library',
      autoCheckUpdate: 'yes'
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const settings = migrateSettings(parsed.data)
    expect(settings.autoCheckUpdate).toBe(true)
    expect(settings.libraryDir).toBe('E:\\ModVault\\Library')
  })

  it('旧档缺键 → migrateSettings 回落 true', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\ModVault\\Library' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(migrateSettings(parsed.data).autoCheckUpdate).toBe(true)
  })
})

// ── ④ 源码守卫（UI 真的接上了） ─────────────────────────────────────────
describe('关于页「检查更新」接线守卫', () => {
  const dialog = read('renderer/components/SettingsDialog.tsx')

  it('渲染了「立即检查」「启动时自动检查更新」两个入口', () => {
    expect(dialog).toContain('立即检查')
    expect(dialog).toContain('启动时自动检查更新')
  })

  it('四态文案齐全（发现新版本 / 已是最新 / 正在检查 / 失败）', () => {
    expect(dialog).toContain('发现新版本')
    expect(dialog).toContain('已是最新版本')
    expect(dialog).toContain('正在检查')
    expect(dialog).toContain('检查失败，可稍后重试')
    expect(dialog).toContain('去下载')
  })

  it('颜色走既有 token，不写死颜色', () => {
    expect(dialog).toContain('text-secondary')
    expect(dialog).toContain('text-accent-text')
    expect(dialog).toContain('bg-elevated')
    expect(dialog).toContain('border-line')
    expect(dialog).toContain('btn-primary')
    // 关于页不出现硬编码十六进制颜色（tab 栏与卡片以外也一并守住）
    const aboutBlock = dialog.slice(dialog.indexOf('const aboutTab = ('), dialog.indexOf('const forceGone'))
    expect(aboutBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(aboutBlock).not.toMatch(/rgb\(/)
  })

  it('开关复用设置页既有 Toggle，且不是原生 checkbox', () => {
    const aboutBlock = dialog.slice(dialog.indexOf('const aboutTab = ('), dialog.indexOf('const forceGone'))
    expect(aboutBlock).toMatch(/<Toggle[\s\S]{0,200}autoCheckUpdate/)
    expect(aboutBlock).not.toContain('type="checkbox"')
  })

  it('自动检查在渲染进程入口显式触发（不依赖组件 import 时机）', () => {
    const entry = read('renderer/main.tsx')
    // 入口必须显式调用：即使设置弹窗将来被改成 lazy()，自动检查也不会静默失效
    expect(entry).toMatch(/startAutoCheck\(\)/)
    expect(entry).toContain("from './logic/updateState'")
    // 组件里不得再有任何调用（连注释都刻意不提函数名，便于这条守卫做全串断言）
    expect(dialog).not.toContain('startAutoCheck')
  })

  it('主进程 / preload / 通道三处都接线了', () => {
    expect(read('shared/ipc.ts')).toContain("checkUpdate: 'app:checkUpdate'")
    expect(read('shared/ipc.ts')).toContain("openExternal: 'shell:openExternal'")
    expect(read('preload/index.ts')).toContain('ipcRenderer.invoke(IPC.checkUpdate')
    expect(read('preload/index.ts')).toContain('ipcRenderer.invoke(IPC.openExternal')
    expect(read('main/index.ts')).toContain('ipcMain.handle(IPC.checkUpdate')
    expect(read('main/index.ts')).toContain('ipcMain.handle(IPC.openExternal')
  })

  it('主进程缓存 10 分钟，且失败不缓存', () => {
    const main = read('main/index.ts')
    expect(main).toContain('const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000')
    expect(main).toMatch(/updateCache = info\.error === null \? info : null/)
  })

  it('updateCheck 模块不 import electron（保证 node 环境可单测）', () => {
    const mod = read('main/updateCheck.ts')
    expect(mod).not.toMatch(/from 'electron'/)
    expect(mod).toContain('AbortSignal.timeout')
    // 未认证请求：不得出现 Authorization 头（注释里说明"不带"可以，实际头不行）
    expect(mod).not.toMatch(/['"]Authorization['"]/)
  })
})
