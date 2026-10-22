/**
 * 按资产的封面写入互斥闸门（DEF-Z8）——**纯模块，零 store / window / db 依赖**。
 *
 * ── 为什么需要它（竞态的真实方向）──────────────────────────────────
 * `writeCoverImageInto()` 在磁盘上是 `removeStaleCovers()` → `writeFile()` **两步**
 * （主进程不再加锁/重试：竞态在渲染层的"写入事务粒度"上，主进程看不到这个语义）。
 * 而渲染层的"写文件"与"写索引"原本是分开的两个 await 段，于是有两个方向的双写：
 *
 * ```
 * 方向 1（用户赢在文件层、输在索引层）
 *   auto: 写 F_zhimo（删同族）→ [用户: 写 F_user（删 F_zhimo）→ commit cover=F_user]
 *   → auto: commit cover=F_zhimo  ⇒ 索引指向已被删除的文件（卡片空白）
 *
 * 方向 2（自动赢在文件层，用户的文件被删）
 *   用户: 写 F_user → auto: 写 F_zhimo（删掉 F_user）→ 用户 commit cover=F_user
 *   ⇒ 用户刚设的封面文件已被删，索引指空
 * ```
 *
 * 结论：**同一资产的「写文件 + 写索引」必须是一个原子段**。本模块就提供这个段：
 * 同一个 `asset.id` 的任务按调用顺序串成 promise 链，不同 id 的链互不阻塞
 * （不能退化成全局串行，否则大批量抓取时用户操作会被整批卡住）。
 *
 * ── 三条实现纪律 ──────────────────────────────────────────────────
 * ① **前一个失败不能让后一个卡死**：链上挂的是 `prev.catch(() => {})`；
 * ② **只有自己仍是队尾才删 Map 条目**：否则会把后来者的链一起删掉（后续调用就绕过了锁）；
 * ③ **用户操作排队等待、绝不拒绝**：一次封面写入约 0.5–0.6s，等一会儿可以接受；
 *    拒绝（"正在忙，请稍后再试"）才是坏体验。等待超过阈值只给**一条**提示。
 */

/** 排队多久后提示用户（毫秒）。做成常量便于单测注入更短的值 */
export const COVER_LOCK_NOTICE_MS = 3000

/** 每个资产一条队列：key = `asset.id` */
const chains = new Map<string, Promise<unknown>>()

export interface CoverLockOptions {
  /** 覆盖提示阈值（单测用；默认 `COVER_LOCK_NOTICE_MS`） */
  notifyAfterMs?: number
  /** 排队超过阈值时调用一次（传了才会真的挂定时器） */
  onWaitNotice?: () => void
}

/**
 * 在 `id` 对应的封面写入锁内执行 `fn`。
 *
 * - **串行**：同 id 的多次调用严格按调用顺序依次执行（前一个完成后才开始下一个）；
 * - **不阻塞别人**：不同 id 完全并行；
 * - **失败隔离**：`fn` 抛错只影响本次调用的返回值；链上后续任务照常执行；
 * - **可观测**：排队超过 `notifyAfterMs` 时调用 `onWaitNotice`（**只调一次**）。
 *
 * ⚠️ 不要在 `fn` 内部再对**同一个 id** 调 `withAssetCoverLock`（会自己等自己，永不返回）。
 * 需要复用的落库逻辑请直接调用被包裹的**内层函数**（如 `commitCover`）。
 */
export function withAssetCoverLock<T>(
  id: string,
  fn: () => Promise<T>,
  opts?: CoverLockOptions
): Promise<T> {
  const key = String(id ?? '')
  const prev = chains.get(key)
  const notifyAfterMs = opts?.notifyAfterMs ?? COVER_LOCK_NOTICE_MS

  // 只有"确实要排队"时才可能提示（锁空闲时写盘慢不该算排队）
  let timer: ReturnType<typeof setTimeout> | null = null
  if (prev && opts?.onWaitNotice) {
    timer = setTimeout(() => {
      timer = null
      opts.onWaitNotice?.()
    }, Math.max(0, notifyAfterMs))
  }

  const run = (async (): Promise<T> => {
    if (prev) await prev
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    return fn()
  })()

  // 链上挂"永不 reject"的版本：① 前一个失败不阻断后一个；② 便于 finally 清理
  const tail = run.catch(() => undefined)
  chains.set(key, tail)
  void tail.finally(() => {
    // 只有自己仍是队尾才删（后来者已经把自己的 tail 放上去了 → 不能动）
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

/** 当前还有多少个资产有未完成的写入（0 = 全部空闲）。**单测用**。 */
export function pendingCoverLocks(): number {
  return chains.size
}
