/**
 * `thumb:list`（只读目录列举）的主进程侧测试（2026-10 数据救援）。
 *
 * 只测两件真正会出事的事：
 * ① **只读**——调用前后目录内容完全一致（绝不会像 `pruneThumbs` 那样删东西）；
 * ② **只回缩略图**——非 `<id>-<8hex>.(jpg|png)` 的杂项一律不出现在结果里。
 *
 * `thumbsDir()` 依赖 electron 的 `app.getPath('userData')`（见 `main/paths.ts:21`），
 * 因此这里整体 mock `electron` 并把 userData 指到 tmp 目录——与
 * `tests/ballThumb.test.ts` 同一套写法；被测代码本身不 import electron。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const env = vi.hoisted(() => ({ userDataRoot: '' }))
vi.mock('electron', () => ({
  nativeImage: { createFromPath: () => null },
  app: { getPath: () => env.userDataRoot }
}))

const { listThumbFiles } = await import('../src/main/thumb')

const ID = 'a1b2c3d4-1111-4222-8333-444455556666'
const OTHER = 'ffffffff-0000-4000-8000-000000000000'

let root = ''
let dir = ''

beforeEach(async () => {
  env.userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-list-'))
  root = env.userDataRoot
  dir = path.join(root, 'thumbs')
  await fs.mkdir(dir, { recursive: true })
})

afterEach(async () => {
  if (env.userDataRoot) {
    await fs.rm(env.userDataRoot, { recursive: true, force: true }).catch(() => {})
  }
  env.userDataRoot = ''
})

async function write(name: string, bytes = 32): Promise<void> {
  await fs.writeFile(path.join(dir, name), Buffer.alloc(bytes, 1))
}

describe('main/thumb · listThumbFiles（thumb:list）', () => {
  it('只返回能解析成缩略图名的文件，杂项一律忽略', async () => {
    await write(`${ID}-1234abcd.png`)
    await write(`${OTHER}-deadbeef.jpg`)
    await write('notes.txt') // 非缩略图（无 `-hash` 尾）
    await write('readme.jpg') // 同上
    await write(`${ID}-zzzzzzzz.png`) // hash 非十六进制
    await fs.mkdir(path.join(dir, `${OTHER}-11111111.png`)) // 同名目录也不算

    const list = await listThumbFiles()
    const names = list.map((f) => f.name).sort()
    expect(names).toEqual([`${ID}-1234abcd.png`, `${OTHER}-deadbeef.jpg`].sort())
  })

  it('裸 `<id>.png` 会被贪心正则解析成"另一个 id"（末位 hex 当 salt）——永远匹配不上资产，故无害', async () => {
    // `parseThumbFileName` 的 `(.+)` 是贪婪的：`…-444455556666.png` → id 少吃一个 6 当 salt。
    // 这不是 bug（文件名格式就是这样），但它意味着**计划层必须要求"解析出的 id 完全相等"**，
    // 不能用 `startsWith(asset.id)` 之类的近似匹配。
    await write(`${ID}.png`)
    const list = await listThumbFiles()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe(`${ID}.png`)
    // 解析出来的 id 必然不等于真实 id（少了一个字符）
    const { parseThumbFileName } = await import('../src/shared/thumb')
    expect(parseThumbFileName(list[0]!.name)!.id).not.toBe(ID)
  })

  it('返回 size / mtimeMs（救援"取最新"的判据），且 0 字节文件也如实列出（由计划层过滤）', async () => {
    await write(`${ID}-1234abcd.png`, 123)
    await write(`${OTHER}-deadbeef.png`, 0)

    const list = await listThumbFiles()
    const a = list.find((f) => f.name === `${ID}-1234abcd.png`)!
    expect(a.size).toBe(123)
    expect(Number.isFinite(a.mtimeMs)).toBe(true)
    expect(a.mtimeMs).toBeGreaterThan(0)
    expect(list.find((f) => f.name === `${OTHER}-deadbeef.png`)!.size).toBe(0)
  })

  it('**只读**：调用前后目录内容逐字节一致（绝不能像 prune 那样删文件）', async () => {
    await write(`${ID}-1234abcd.png`)
    await write(`${OTHER}-deadbeef.jpg`)
    await write('orphan-not-ours.bin')
    const before = (await fs.readdir(dir)).sort()

    await listThumbFiles()
    await listThumbFiles()

    expect((await fs.readdir(dir)).sort()).toEqual(before)
  })

  it('目录不存在 → 空数组（首次运行；`ensureThumbsDir` 会建目录，与既有口径一致）', async () => {
    await fs.rm(dir, { recursive: true, force: true })
    await expect(listThumbFiles()).resolves.toEqual([])
  })
})
