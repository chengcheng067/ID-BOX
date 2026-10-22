import { describe, expect, it } from 'vitest'
import {
  routeVaultHost,
  isWithinRoot,
  vaultHostUrl,
  vaultResponseHeaders,
  applyVaultCorsHeaders
} from '../src/shared/vault'

describe('routeVaultHost', () => {
  it('asset → asset（原图，库根目录）', () => {
    expect(routeVaultHost('asset')).toBe('asset')
  })

  it('thumb → thumb（缩略图缓存目录）', () => {
    expect(routeVaultHost('thumb')).toBe('thumb')
  })

  it('大小写不敏感（URL host 会被小写化）', () => {
    expect(routeVaultHost('ASSET')).toBe('asset')
    expect(routeVaultHost('Thumb')).toBe('thumb')
  })

  it('未知 host → null（调用方回 404）', () => {
    expect(routeVaultHost('file')).toBeNull()
    expect(routeVaultHost('')).toBeNull()
    expect(routeVaultHost('C:')).toBeNull()
  })
})

describe('isWithinRoot', () => {
  const root = 'E:\\ModVault\\Library'
  const sep = '\\'

  it('等于 root 本身算在内', () => {
    expect(isWithinRoot(root, root, sep)).toBe(true)
  })

  it('子路径算在内', () => {
    expect(isWithinRoot(root, 'E:\\ModVault\\Library\\模型\\沙发\\a.png', sep)).toBe(true)
  })

  it('目录穿越被挡住', () => {
    expect(isWithinRoot(root, 'E:\\ModVault\\secret.txt', sep)).toBe(false)
    expect(isWithinRoot(root, 'E:\\', sep)).toBe(false)
    expect(isWithinRoot(root, 'E:\\ModVault\\Library2\\a.png', sep)).toBe(false)
  })

  it('前缀相同但不是子目录时不能放行（Library vs Library2）', () => {
    expect(isWithinRoot('E:\\Lib', 'E:\\Lib2\\a.png', sep)).toBe(false)
  })

  it('root 已带分隔符时不重复拼接', () => {
    expect(isWithinRoot('E:\\Lib\\', 'E:\\Lib\\a.png', sep)).toBe(true)
  })

  it('thumb 目录同样受保护', () => {
    const thumbs = 'C:\\Users\\me\\AppData\\Roaming\\ModVault\\thumbs'
    expect(isWithinRoot(thumbs, `${thumbs}\\a1b2-salt.jpg`, sep)).toBe(true)
    expect(isWithinRoot(thumbs, 'C:\\Users\\me\\AppData\\Roaming\\ModVault\\settings.json', sep)).toBe(false)
  })

  it('posix 分隔符同样适用', () => {
    expect(isWithinRoot('/lib', '/lib/a/b.png', '/')).toBe(true)
    expect(isWithinRoot('/lib', '/libbak/a.png', '/')).toBe(false)
  })

  it('空串一律不放行', () => {
    expect(isWithinRoot('', '/lib/a', '/')).toBe(false)
    expect(isWithinRoot('/lib', '', '/')).toBe(false)
  })
})

describe('vaultHostUrl', () => {
  it('逐段编码中文与空格', () => {
    expect(vaultHostUrl('asset', '模型/某 沙发/a.png')).toBe(
      'vault://asset/%E6%A8%A1%E5%9E%8B/%E6%9F%90%20%E6%B2%99%E5%8F%91/a.png'
    )
  })

  it('thumb host 拼出缓存 URL', () => {
    expect(vaultHostUrl('thumb', 'a1b2-salt.jpg')).toBe('vault://thumb/a1b2-salt.jpg')
  })
})

/**
 * CORS 响应头（2026-10 材质球阻塞修复）。
 *
 * 这里是**纯函数断言**——不 import electron、不起协议，只钉住"响应头必须带
 * 放行字段"这个契约。`protocol.ts` 的接线（net.fetch 后透传 + 补头）由
 * typecheck + 真机验证兜底。
 */
describe('vaultResponseHeaders（CORS 放行）', () => {
  const REQUIRED = [
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Headers',
    'Cross-Origin-Resource-Policy'
  ]

  it('成功响应带三个必需 CORS 头', () => {
    const h = vaultResponseHeaders(200)
    for (const k of REQUIRED) expect(h[k]).toBeTruthy()
    expect(h['Access-Control-Allow-Origin']).toBe('*')
    expect(h['Cross-Origin-Resource-Policy']).toBe('cross-origin')
  })

  it('403 / 404 也带同样三个头（避免把 CORS 失败和文件不存在混成一种现象）', () => {
    for (const status of [403, 404, 204]) {
      const h = vaultResponseHeaders(status)
      for (const k of REQUIRED) expect(h[k]).toBeTruthy()
    }
  })

  it('默认 status=200', () => {
    expect(vaultResponseHeaders()).toEqual(vaultResponseHeaders(200))
  })

  it('applyVaultCorsHeaders 往现有头里补（鸭子类型 set，不依赖 DOM Headers）', () => {
    const collected: Record<string, string> = { 'Content-Type': 'image/jpeg' }
    const fake = {
      set: (k: string, v: string) => {
        collected[k] = v
      }
    }
    applyVaultCorsHeaders(fake, 200)
    expect(collected['Content-Type']).toBe('image/jpeg') // 原有头保留
    for (const k of REQUIRED) expect(collected[k]).toBeTruthy()
  })
})
