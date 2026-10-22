/**
 * 封面图片输入的**纯逻辑**（2026-10 装机反馈，任务 3）——不 import React /
 * store / window.modvault（仅在默认参数里触达），可在 vitest 直接单测。
 *
 * 三个来源统一收敛成 `CoverImageInput`：
 *   ① 剪贴板粘贴（paste 事件的 clipboardData.items 里取图片 File）；
 *   ② 拖一张图片进详情面板 / 换封面弹窗（DataTransfer.files）；
 *   ③ 选择本地文件（<input type="file">）。
 * File → IPC 入参的转换：能拿到绝对路径就走 `source:'file'`（大图不占 IPC），
 * 拿不到（剪贴板的 File 常见）退化为 base64 `source:'clipboard'`。
 */

/** 送给 main 的封面图片来源（对应 SetCoverImagePayload 的 source/data/path） */
export type CoverImageInput =
  | { source: 'file'; path: string }
  | { source: 'clipboard'; data: string }

/** 是否是图片 File（MIME 前缀判定；空 type 的通不过——main 还会按魔数二次校验） */
export function isImageFile(file: File | null | undefined): boolean {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/')
}

/** 从 DataTransfer（拖放）里取第一个图片文件；没有返回 null */
export function firstImageFileOfDataTransfer(dt: DataTransfer | null | undefined): File | null {
  if (!dt || !dt.files) return null
  for (const f of Array.from(dt.files)) {
    if (isImageFile(f)) return f
  }
  return null
}

/**
 * 从 paste 事件的 clipboardData 里取第一个图片文件。
 * `items` 优先（`getAsFile` 能拿到粘贴的截图位图），`files` 兜底
 * （部分浏览器/路径只填 files）。
 */
export function firstImageFileOfClipboard(cd: DataTransfer | null | undefined): File | null {
  if (!cd) return null
  if (cd.items) {
    for (const item of Array.from(cd.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) return f
      }
    }
  }
  return firstImageFileOfDataTransfer(cd)
}

/** FileReader 读 dataURL 并剥掉前缀拿 base64（默认实现，测试可注入） */
function readAsBase64Default(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** coverImageInputOf 的可注入依赖（默认走全局 window.modvault / FileReader） */
export interface CoverImageInputDeps {
  getPathForFile?: (file: File) => string
  readAsBase64?: (file: File) => Promise<string>
}

/**
 * File → CoverImageInput。优先走文件绝对路径（Electron 的 webUtils 对
 * input/drop 的 File 可用，省一次 base64 大字符串过 IPC）；拿不到路径
 * （典型：剪贴板截图）就退化成 base64。
 *
 * @returns null = 不是图片 / 两条路都失败（调用方应提示用户）
 */
export async function coverImageInputOf(
  file: File,
  deps: CoverImageInputDeps = {}
): Promise<CoverImageInput | null> {
  if (!isImageFile(file)) return null
  const getPath = deps.getPathForFile ?? ((f: File) => window.modvault.getPathForFile(f))
  try {
    const abs = getPath(file)
    if (abs) return { source: 'file', path: abs }
  } catch {
    /* 拿不到路径就退化 base64 */
  }
  const readBase64 = deps.readAsBase64 ?? readAsBase64Default
  try {
    const data = await readBase64(file)
    if (data) return { source: 'clipboard', data }
  } catch {
    /* 读失败 */
  }
  return null
}
