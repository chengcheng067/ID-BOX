/**
 * 钉选根内部隐藏回收区单测（网络映射盘删除兜底）。
 *
 * 全部用 Node 临时目录，不依赖 electron / vitest jsdom —— 直接 run in node。
 * 覆盖：同盘 rename + meta、文件还原、重名追加 -2、源不存在、跨盘拒绝、
 * 回收区名拒绝、坏 meta 跳过、restore 失败保留 meta。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PINNED_TRASH_DIR,
  listPinnedTrash,
  moveToPinnedTrash,
  restorePinnedTrash
} from '../src/main/pinnedTrash'

const TOKEN_RE = /^[0-9a-f-]{36}$/

const tempDirs: string[] = []
let tmp = ''

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-pinned-trash-'))
  tempDirs.push(tmp)
})

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function metaPathOf(pin: string, token: string): string {
  return path.join(pin, PINNED_TRASH_DIR, '.meta', `${token}.json`)
}

describe('moveToPinnedTrash — 同盘原子移动 + 先 meta 后 rename', () => {
  it('目录条目：同盘 rename 成功，meta 落盘，原位置消失', async () => {
    const pin = path.join(tmp, 'pin')
    const src = path.join(pin, '子目录', '千山茶屋')
    await fs.mkdir(path.join(src, '内层'), { recursive: true })
    await fs.writeFile(path.join(src, '内层', '沙发.skp'), 'x'.repeat(12))

    const entry = await moveToPinnedTrash(pin, '子目录', '千山茶屋')

    expect(entry.name).toBe('千山茶屋')
    expect(entry.relFolder).toBe('子目录')
    expect(entry.isDirectory).toBe(true)
    expect(entry.size).toBe(12)
    expect(entry.deletedAt).toBeGreaterThan(0)
    expect(TOKEN_RE.test(entry.token)).toBe(true)
    expect(await exists(src)).toBe(false)

    const body = path.join(pin, PINNED_TRASH_DIR, entry.token)
    expect((await fs.stat(body)).isDirectory()).toBe(true)
    expect(await exists(path.join(body, '内层', '沙发.skp'))).toBe(true)

    const raw = JSON.parse(await fs.readFile(metaPathOf(pin, entry.token), 'utf-8'))
    expect(raw).toMatchObject({
      token: entry.token,
      name: '千山茶屋',
      relFolder: '子目录',
      isDirectory: true
    })
  })

  it('文件条目：能原样还原回钉选根（relFolder 为空）', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(pin, { recursive: true })
    const src = path.join(pin, '木纹.jpg')
    await fs.writeFile(src, 'image-bytes')

    const entry = await moveToPinnedTrash(pin, '', '木纹.jpg')
    expect(entry.relFolder).toBe('')
    expect(entry.isDirectory).toBe(false)
    expect(entry.size).toBe('image-bytes'.length)
    expect((await fs.stat(path.join(pin, PINNED_TRASH_DIR, entry.token))).isFile()).toBe(true)

    const restored = await restorePinnedTrash(pin, entry.token)
    expect(restored).toEqual({ name: '木纹.jpg', relFolder: '', renamed: false })
    expect(await fs.readFile(src, 'utf-8')).toBe('image-bytes')
    expect(await exists(metaPathOf(pin, entry.token))).toBe(false)
    expect(await listPinnedTrash(pin)).toEqual([])
  })

  it('原位置被占用：还原追加 -2，两份都在，renamed=true', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(path.join(pin, '贴图'), { recursive: true })
    const src = path.join(pin, '贴图', '木纹.jpg')
    await fs.writeFile(src, 'old')

    const entry = await moveToPinnedTrash(pin, '贴图', '木纹.jpg')
    // 删除后用户又放了一份同名文件在原位
    await fs.writeFile(src, 'new')

    const restored = await restorePinnedTrash(pin, entry.token)
    expect(restored).toEqual({
      name: '木纹-2.jpg',
      relFolder: '贴图',
      renamed: true
    })
    expect(await fs.readFile(src, 'utf-8')).toBe('new')
    expect(await fs.readFile(path.join(pin, '贴图', '木纹-2.jpg'), 'utf-8')).toBe('old')
  })

  it('文件重名：-2 插在扩展名前，还原出的 PNG 仍保持可识别类型与原始内容', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(pin, { recursive: true })
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const src = path.join(pin, '材质贴图.png')
    await fs.writeFile(src, pngBytes)

    const entry = await moveToPinnedTrash(pin, '', '材质贴图.png')
    // 原位被用户新放的同名文件占住
    await fs.writeFile(src, 'occupant')

    const restored = await restorePinnedTrash(pin, entry.token)
    expect(restored).toEqual({ name: '材质贴图-2.png', relFolder: '', renamed: true })
    expect(path.extname(restored.name)).toBe('.png')
    const target = path.join(pin, '材质贴图-2.png')
    expect(await exists(target)).toBe(true)
    expect(await fs.readFile(target)).toEqual(pngBytes)
    expect(await fs.readFile(src, 'utf-8')).toBe('occupant')
  })

  it('点文件无扩展名：末尾追加序号，连号占用时递增到 -3', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(pin, { recursive: true })
    await fs.writeFile(path.join(pin, '.gitignore'), 'original')

    const entry = await moveToPinnedTrash(pin, '', '.gitignore')
    await fs.writeFile(path.join(pin, '.gitignore'), 'new')
    await fs.writeFile(path.join(pin, '.gitignore-2'), 'taken')

    const restored = await restorePinnedTrash(pin, entry.token)
    expect(restored.name).toBe('.gitignore-3')
    expect(restored.renamed).toBe(true)
    expect(await fs.readFile(path.join(pin, '.gitignore-3'), 'utf-8')).toBe('original')
  })

  it('源不存在：抛中文错，不写 meta', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(pin, { recursive: true })
    await expect(moveToPinnedTrash(pin, '', '不存在.skp')).rejects.toThrow(/不存在/)
    expect(await exists(path.join(pin, PINNED_TRASH_DIR))).toBe(false)
  })

  it('跨盘：断言失败，源保留、meta 不落盘（绝不退化 cp+rm）', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(pin, { recursive: true })
    const src = path.join(pin, '沙发.skp')
    await fs.writeFile(src, 'keep-me')

    const realParse = path.parse.bind(path)
    const spy = vi.spyOn(path, 'parse').mockImplementation((p: string) => {
      const parsed = realParse(p)
      // 让「回收区目标」看起来在另一个盘根上，触发 assertSameDrive
      if (p.split(/[\\/]/).includes(PINNED_TRASH_DIR)) {
        return { ...parsed, root: `${parsed.root}X` }
      }
      return parsed
    })
    try {
      await expect(moveToPinnedTrash(pin, '', '沙发.skp')).rejects.toThrow(/跨盘/)
    } finally {
      spy.mockRestore()
    }

    expect(await fs.readFile(src, 'utf-8')).toBe('keep-me')
    expect(await exists(path.join(pin, PINNED_TRASH_DIR, '.meta'))).toBe(false)
  })

  it('拒绝把回收区自身当条目删除', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(path.join(pin, PINNED_TRASH_DIR), { recursive: true })
    await expect(moveToPinnedTrash(pin, '', PINNED_TRASH_DIR)).rejects.toThrow(/回收站/)
    expect(await exists(path.join(pin, PINNED_TRASH_DIR))).toBe(true)
  })
})

describe('listPinnedTrash — 坏 meta / 幽灵 meta 跳过', () => {
  it('截断 JSON / 非 UUID 文件名不抛，只返回好条目且按 deletedAt 倒序', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(pin, { recursive: true })
    await fs.writeFile(path.join(pin, 'a.txt'), 'a')
    await fs.writeFile(path.join(pin, 'b.txt'), 'b')
    const first = await moveToPinnedTrash(pin, '', 'a.txt')
    const second = await moveToPinnedTrash(pin, '', 'b.txt')

    const metaDir = path.join(pin, PINNED_TRASH_DIR, '.meta')
    await fs.writeFile(path.join(metaDir, 'broken.json'), '{ not json')
    await fs.writeFile(path.join(metaDir, 'not-a-uuid.json'), '{"name":"x"}')

    const entries = await listPinnedTrash(pin)
    expect(entries.map((e) => e.token)).toEqual([second.token, first.token])
  })

  it('没有回收区时返回空数组，不抛', async () => {
    await expect(listPinnedTrash(path.join(tmp, 'never-created'))).resolves.toEqual([])
  })

  it('幽灵 meta（本体已移走但 meta 残留）不展示，正常条目仍能列出', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(pin, { recursive: true })
    await fs.writeFile(path.join(pin, 'ghost.txt'), 'ghost')
    await fs.writeFile(path.join(pin, 'alive.txt'), 'alive')
    const ghost = await moveToPinnedTrash(pin, '', 'ghost.txt')
    const alive = await moveToPinnedTrash(pin, '', 'alive.txt')

    // 模拟还原成功后网络盘 fs.unlink(meta) 失败：本体已被 rename 走，meta 残留
    await fs.unlink(path.join(pin, PINNED_TRASH_DIR, ghost.token))

    const entries = await listPinnedTrash(pin)
    expect(entries.map((e) => e.token)).toEqual([alive.token])
    // 孤儿 meta 只跳过展示，**不删文件**（网络盘删除不可靠 / 绝不永久删除）
    expect(await exists(metaPathOf(pin, ghost.token))).toBe(true)
  })
})

describe('restorePinnedTrash — 失败保留 meta 可重试', () => {
  it('目标目录无法重建时抛错，meta 与回收区本体都还在', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(path.join(pin, '子目录'), { recursive: true })
    await fs.writeFile(path.join(pin, '子目录', '沙发.skp'), 'still-recoverable')
    const entry = await moveToPinnedTrash(pin, '子目录', '沙发.skp')

    // 模拟原位被一个同名「文件」占住（mkdir -p 必然失败）
    await fs.rmdir(path.join(pin, '子目录'))
    await fs.writeFile(path.join(pin, '子目录'), 'blocker')

    await expect(restorePinnedTrash(pin, entry.token)).rejects.toThrow()
    expect(await exists(metaPathOf(pin, entry.token))).toBe(true)
    expect(await exists(path.join(pin, PINNED_TRASH_DIR, entry.token))).toBe(true)

    // 清掉障碍后原样重试仍可成功
    await fs.unlink(path.join(pin, '子目录'))
    const restored = await restorePinnedTrash(pin, entry.token)
    expect(restored).toEqual({ name: '沙发.skp', relFolder: '子目录', renamed: false })
    expect(await fs.readFile(path.join(pin, '子目录', '沙发.skp'), 'utf-8')).toBe(
      'still-recoverable'
    )
  })

  it('token 白名单：路径穿越串直接拒绝', async () => {
    const pin = path.join(tmp, 'pin')
    await fs.mkdir(pin, { recursive: true })
    await expect(restorePinnedTrash(pin, '../../etc/passwd')).rejects.toThrow(/回收编号/)
    await expect(restorePinnedTrash(pin, 'not-a-uuid')).rejects.toThrow(/回收编号/)
  })
})
