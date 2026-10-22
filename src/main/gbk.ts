import iconv from 'iconv-lite'

/**
 * GBK 编解码（P0-2 / K1）
 *
 * - 运行时首选 `new TextDecoder('gbk')`（Node 22 / Electron 全 ICU，零依赖路径）
 * - 小 ICU 构建抛错时兜底 `iconv-lite`（R9）
 * - `TextEncoder` 不支持 GBK，所以"编码"方向一律用 iconv-lite（生成测试 fixture 也靠它）
 */

/** adm-zip 的自定义 decoder 形状（0.5.16+ 支持 `new AdmZip(src, { decoder })`） */
export interface AdmZipDecoder {
  /** 置位时 adm-zip 按 UTF-8 处理文件名 */
  efs: boolean
  encode(data: string): Buffer
  decode(data: Buffer): string
}

export type DecodeMode = 'gbk' | 'utf8'

/**
 * @types/node 只把 `TextDecoder` 声明成值（global var），没有同名类型，
 * 所以这里用 `InstanceType<typeof TextDecoder>` 取实例类型。
 */
type TextDecoderLike = InstanceType<typeof TextDecoder>

let cached: TextDecoderLike | null | undefined

function getGbkDecoder(): TextDecoderLike | null {
  if (cached === undefined) {
    try {
      cached = new TextDecoder('gbk')
    } catch {
      cached = null
    }
  }
  return cached
}

/** GBK 字节 → UTF-8 字符串 */
export function decodeGbk(bytes: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const dec = getGbkDecoder()
  if (dec) return dec.decode(buf)
  return iconv.decode(buf, 'gbk')
}

/** UTF-8 字符串 → GBK 字节（TextEncoder 不支持 GBK，必须 iconv-lite） */
export function gbkEncode(s: string): Buffer {
  return iconv.encode(s, 'gbk')
}

/** 供 adm-zip 使用的 decoder；gbk 模式不置 UTF-8 flag，直接按 GBK 解码原始字节 */
export function makeAdmZipDecoder(mode: DecodeMode): AdmZipDecoder {
  if (mode === 'gbk') {
    return {
      efs: false,
      encode: (data: string) => gbkEncode(data),
      decode: (data: Buffer) => decodeGbk(data)
    }
  }
  return {
    efs: true,
    encode: (data: string) => Buffer.from(data, 'utf8'),
    decode: (data: Buffer) => data.toString('utf8')
  }
}
