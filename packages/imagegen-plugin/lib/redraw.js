// lib/redraw.js —— 局部重绘（DS-10-）支持：模型给图 + 区域 → host 上传原图并烘焙蒙版到 alpha
// （watcher reload 触发点）
//
// 机制（实测确认，ComfyUI server.py /upload/mask）：
//   蒙版编辑器本质 = 一张 RGBA PNG 的 alpha 通道。POST /upload/mask 时服务端会把
//   该 alpha 盖进原图文件的 alpha 通道；LoadImage（DS-10-）输出的 MASK = 1 - alpha，
//   因此「画笔处 = alpha 0 = MASK 1」即重绘区（用户移除工作流里的 InvertMask 后语义如此）。
//   蒙版文件本体：RGB 全黑 + alpha = 重绘区 0 / 保留区 255（与 ComfyUI 前端编辑器产物一致）。
//
// 零依赖：PNG 编码器手写（zlib + CRC32），图片尺寸解析支持 PNG/JPEG/WebP。

import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'

function log(...args) { console.log('[redraw]', ...args) }

// ── CRC32（PNG chunk 校验） ──────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/**
 * 编码一张 RGBA PNG：RGB 全黑，alpha 由 alphaAt(x,y) 提供（0..255）。
 * 纯合成图（无源像素参与），filter=0 逐行直出。
 */
export function encodeMaskPng(width, height, alphaAt) {
  if (width < 1 || height < 1) throw new Error(`无效的蒙版尺寸 ${width}x${height}`)
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter: none
    const pxStart = rowStart + 1
    for (let x = 0; x < width; x++) {
      const o = pxStart + x * 4
      raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 0
      raw[o + 3] = alphaAt(x, y)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 读取 PNG/JPEG/WebP 图片尺寸（仅需头部字节）。入参兼容 Buffer/Uint8Array/ArrayBuffer。 */
export function readImageSize(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
    // JPEG: 扫描 SOF 段（C0-CF，除 C4/C8/CC）
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
    throw new Error('JPEG 尺寸解析失败')
  }
  if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const vp = buf.toString('ascii', 12, 16)
    if (vp === 'VP8X') return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) }
    if (vp === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF }
    if (vp === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { width: 1 + (bits & 0x3FFF), height: 1 + ((bits >>> 14) & 0x3FFF) }
    }
  }
  throw new Error('仅支持 PNG/JPG/WebP 图片重绘（其他格式请先转换）')
}

/** 重绘区域规格 → 归一化矩形 [x1,y1,x2,y2]（0..1，已排序/夹取）。 */
/**
 * 解析重绘区域描述 → 区域对象 { bbox:[x1,y1,x2,y2], polygon:[[x,y],...]|null }
 * 支持：关键词（全图/中心/上下左右半部/四角）、归一化矩形 [x1,y1,x2,y2]、
 *      归一化多边形 [[x1,y1],[x2,y2],...]（沿元素轮廓点 3..24 个点，逆/顺时针均可）。
 */
export function parseRedrawRegion(spec) {
  if (spec === undefined || spec === null || String(spec).trim() === '' || String(spec).trim() === '全图') {
    return { bbox: [0, 0, 1, 1], polygon: null }
  }
  const s = String(spec).trim()
  const KW = {
    '中心': [0.25, 0.25, 0.75, 0.75],
    '上半部': [0, 0, 1, 0.5], '下半部': [0, 0.5, 1, 1],
    '左半部': [0, 0, 0.5, 1], '右半部': [0.5, 0, 1, 1],
    '左上': [0, 0, 0.5, 0.5], '右上': [0.5, 0, 1, 0.5],
    '左下': [0, 0.5, 0.5, 1], '右下': [0.5, 0.5, 1, 1],
  }
  if (s in KW) return { bbox: KW[s], polygon: null }
  // 归一化多边形：[[x1,y1],[x2,y2],...]
  const pm = s.match(/^\[\s*(\[[0-9.]+\s*,\s*[0-9.]+\]\s*)(?:,\s*\[[0-9.]+\s*,\s*[0-9.]+\]\s*)*\]$/)
  if (pm && s.includes('],[')) {
    const pairs = s.match(/\[([0-9.]+)\s*,\s*([0-9.]+)\]/g)
    const points = pairs.map((p) => {
      const m = p.match(/\[([0-9.]+)\s*,\s*([0-9.]+)\]/)
      let x = Number(m[1]), y = Number(m[2])
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`重绘区域数值无效：${s}`)
      x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y))
      return [x, y]
    })
    if (points.length < 3) throw new Error(`多边形区域至少需要 3 个顶点：${s}`)
    if (points.length > 24) throw new Error(`多边形区域顶点过多（≤24）：${s}`)
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const [x, y] of points) {
      if (x < x1) x1 = x; if (y < y1) y1 = y
      if (x > x2) x2 = x; if (y > y2) y2 = y
    }
    if (x2 - x1 < 0.01 || y2 - y1 < 0.01) throw new Error(`重绘区域过小：${s}`)
    return { bbox: [x1, y1, x2, y2], polygon: points }
  }
  // 归一化 bbox：接受 [x1,y1,x2,y2] 或 x1,y1,x2,y2
  const m = s.match(/^\[?\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]?$/)
  if (m) {
    let [x1, y1, x2, y2] = m.slice(1).map(Number)
    if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) throw new Error(`重绘区域数值无效：${s}`)
    x1 = Math.min(1, Math.max(0, x1)); y1 = Math.min(1, Math.max(0, y1))
    x2 = Math.min(1, Math.max(0, x2)); y2 = Math.min(1, Math.max(0, y2))
    if (x1 > x2) [x1, x2] = [x2, x1]
    if (y1 > y2) [y1, y2] = [y2, y1]
    if (x2 - x1 < 0.01 || y2 - y1 < 0.01) throw new Error(`重绘区域过小：${s}`)
    return { bbox: [x1, y1, x2, y2], polygon: null }
  }
  throw new Error(`无法识别的重绘区域："${s}"（可用：全图/中心/上下左右半部/四角，或 [x1,y1,x2,y2] 归一化矩形，或沿轮廓的 [[x1,y1],[x2,y2],...] 归一化多边形）`)
}

/** 射线法：点 (x,y) 是否在多边形 pts 内（归一化坐标）。 */
function pointInPolygon(x, y, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1]
    const xj = pts[j][0], yj = pts[j][1]
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** 归一化区域 → 蒙版 PNG（重绘区 alpha=0，其余 255；支持多边形与矩形）。 */
export function buildMaskPng(width, height, region) {
  const bbox = region.bbox
  const polygon = region.polygon || null
  const [x1, y1, x2, y2] = bbox
  const px1 = Math.max(0, Math.round(x1 * width))
  const py1 = Math.max(0, Math.round(y1 * height))
  const px2 = Math.min(width, Math.round(x2 * width))
  const py2 = Math.min(height, Math.round(y2 * height))
  log(`mask ${width}x${height} region px=(${px1},${py1})-(${px2},${py2}) poly=${polygon ? polygon.length + 'pts' : 'rect'}`)
  if (!polygon) {
    return encodeMaskPng(width, height, (x, y) => (x >= px1 && x < px2 && y >= py1 && y < py2 ? 0 : 255))
  }
  // 多边形：bbox 内逐像素射线判定
  return encodeMaskPng(width, height, (x, y) => {
    if (x < px1 || x >= px2 || y < py1 || y >= py2) return 255
    return pointInPolygon((x + 0.5) / width, (y + 0.5) / height, polygon) ? 0 : 255
  })
}

// ── ComfyUI HTTP 辅助（手写 multipart，避开 FormData/Blob 兼容性问题） ──
async function fetchTimeout(url, init, timeoutMs = 120000, signal) {
  const ac = new AbortController()
  let timer = null
  const onAbort = () => ac.abort(signal && signal.reason !== undefined ? signal.reason : new Error('已取消'))
  if (signal) {
    if (signal.aborted) throw new Error('已取消')
    signal.addEventListener('abort', onAbort, { once: true })
  }
  timer = setTimeout(() => ac.abort(new Error(`ComfyUI 响应超时（${timeoutMs}ms）`)), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function multipart(fields, fileField, fileName, fileBytes) {
  const boundary = '----dsh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf-8'))
  }
  const mime = extToMedia(extname(fileName).toLowerCase() || '.png')
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`, 'utf-8'))
  parts.push(fileBytes)
  parts.push(Buffer.from('\r\n', 'utf-8'))
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function uploadPart(baseUrl, endpoint, fields, fileField, fileName, fileBytes, signal) {
  const { body, contentType } = multipart(fields, fileField, fileName, fileBytes)
  const r = await fetchTimeout(baseUrl + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
    body,
  }, 120000, signal)
  const text = await r.text()
  if (r.status !== 200) throw new Error(`ComfyUI ${endpoint} 返回 ${r.status}：${text.slice(0, 200)}`)
  let j
  try { j = JSON.parse(text) } catch { throw new Error(`${endpoint} 响应不是 JSON：${text.slice(0, 200)}`) }
  if (!j || !j.name) throw new Error(`${endpoint} 响应缺少 name：${text.slice(0, 200)}`)
  return j
}

// ── 图片来源解析 ────────────────────────────────────────────────
/** 当前会话最近一条「用户发的图」的 attachment 引用（role 为 user 的图片块）。 */
export function findLatestUserImageRef(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  const events = session ? session.events : undefined
  if (!events || !Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || typeof ev !== 'object') continue
    const parts = []
    if (ev.type === 'user/message') {
      const c = ev.data && ev.data.message && ev.data.message.content
      if (Array.isArray(c)) parts.push(...c)
    } else if (ev.type === 'agent/inbox/spliced' && ev.data && Array.isArray(ev.data.inserted)) {
      for (const msg of ev.data.inserted) {
        if (msg && msg.role === 'user' && Array.isArray(msg.content)) parts.push(...msg.content)
      }
    }
    // 从后往前：取最后一条消息里的最后一张图
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p && p.type === 'image' && p.attachment && p.attachment.attachmentId) return p.attachment
    }
  }
  return null
}

async function fetchBytes(url, signal) {
  const r = await fetchTimeout(url, { method: 'GET' }, 60000, signal)
  if (r.status !== 200) throw new Error(`下载图片失败（${r.status}）: ${url.slice(0, 120)}`)
  return Buffer.from(await r.arrayBuffer())
}

/** ComfyUI 安装根目录（从 workflowPath 上溯：workflows→default→user→ComfyUI→根）。 */
function comfyRoot(workflowPath) {
  let p = dirname(workflowPath)
  for (let i = 0; i < 4; i++) p = dirname(p)
  return p
}

function extOfName(name) {
  const m = String(name || '').match(/\.(png|jpe?g|webp|gif)$/i)
  return m ? '.' + m[1].toLowerCase() : null
}
function extToMedia(ext) {
  const e = String(ext || '').toLowerCase()
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  if (e === '.webp') return 'image/webp'
  if (e === '.gif') return 'image/gif'
  return 'image/png'
}
function extOfMediaType(mediaType) {
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/gif') return '.gif'
  return '.png'
}

async function readAttachment(rctx, attachment, signal) {
  const store = rctx && rctx.ctx ? rctx.ctx.get('attachments') : undefined
  if (!store || typeof store.readImage !== 'function') {
    throw new Error('附件服务不可用，无法读取用户发的图片')
  }
  return store.readImage(attachment, signal)
}

/**
 * 会话内「最近生成结果」提取：用户说"保持这张/刚才那张"时，"这张" = UI 上看到的
 * 最近一张生成结果。直接扫本会话 events（含 fork 投影）里 generate_image 的
 * tool/result 图片块，取最近一次中 name='生成结果'（否则最后一张图）——
 * 100% 本会话视图，与 store 标签/全局时间戳无关。
 */
async function extractSessionLastGeneratedImage(rctx, signal) {
  try {
    const exec = rctx && rctx.exec
    const events = exec && exec.agent && exec.agent.session ? exec.agent.session.events : undefined
    if (!Array.isArray(events)) return null
    const candidates = []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (!ev || typeof ev !== 'object') continue
      if (ev.type !== 'tool/result') continue
      const msg = ev.data && ev.data.message
      const content = msg && Array.isArray(msg.content) ? msg.content : []
      const blocks = []
      for (const c of content) {
        if (c && c.type === 'tool-result' && Array.isArray(c.content)) blocks.push(...c.content)
        else if (c && c.type === 'image' && c.attachment && typeof c.attachment.attachmentId === 'string') blocks.push(c)
      }
      for (const b of blocks) {
        if (b && b.type === 'image' && b.attachment && typeof b.attachment.attachmentId === 'string') {
          candidates.push({ att: b.attachment, name: String(b.attachment.name || '') })
        }
      }
      if (candidates.length > 0) break // 只取最近一次 tool/result
    }
    if (candidates.length === 0) return null
    let pick = null
    for (const c of candidates) if (c.name === '生成结果') { pick = c; break }
    if (!pick) pick = candidates[candidates.length - 1]
    if (!pick || !pick.att) return null
    const stored = await readAttachment(rctx, pick.att, signal)
    const mediaType = pick.att.mediaType || 'image/png'
    return { bytes: Buffer.from(stored.data), ext: extOfMediaType(mediaType), mediaType }
  } catch (err) {
    console.error('[imagegen] extractSessionLastGeneratedImage failed: ' + (err && err.message ? err.message : String(err)))
    return null
  }
}

/**
 * 解析 重绘图像 参数并取回图片字节。
 * @param rctx - { ctx, exec, latestUrls: string[] }（latestUrls = 最近生成的 /view URL 候选）
 * @returns {{ bytes: Buffer, ext: string, display: string, mediaType: string }}
 */
export async function resolveRedrawImage(config, params, rctx, signal) {
  const raw = String(params.redraw_image || '').trim()
  if (!raw) throw new Error('redraw_image 为空')

  // 1) attachment id（模型可能复读 sha256）
  const sha = raw.match(/^(?:attachment[:I]?|sha256:)?([0-9a-f]{64})$/i)
  if (sha) {
    const id = 'sha256:' + sha[1]
    const attachment = findLatestUserImageRef(rctx && rctx.exec)
    if (attachment && String(attachment.attachmentId) === id) {
      const stored = await readAttachment(rctx, attachment, signal)
      const mediaType = attachment.mediaType || extToMedia(extOfName(attachment.name) || '.png')
      // 官方 readImage 的 data 可能是 Uint8Array——必须 Buffer 化（readImageSize 用 Buffer 方法）
      return { bytes: Buffer.from(stored.data), ext: extOfMediaType(mediaType), display: id, mediaType }
    }
    const base = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'attachments', 'v1', 'objects', sha[1].slice(0, 2), sha[1])
    if (existsSync(base)) {
      return { bytes: readFileSync(base), ext: '.png', display: id, mediaType: 'image/png' }
    }
    throw new Error(`找不到附件 ${id}`)
  }

  // 2) 用户图关键词
  if (/^(用户|用户(发|给|提供|上传)的图|用户(发|给|提供|上传)的图片|这张图|刚才那张图|刚发的图|用户图|用户图片)$/.test(raw)) {
    const attachment = findLatestUserImageRef(rctx && rctx.exec)
    if (!attachment) throw new Error(`"${raw}"：当前会话最近没有找到用户发的图片`)
    const stored = await readAttachment(rctx, attachment, signal)
    const mediaType = attachment.mediaType || 'image/png'
    return { bytes: Buffer.from(stored.data), ext: extOfMediaType(mediaType), display: String(attachment.attachmentId), mediaType }
  }

  // 3) 最近一张（本插件生成的、且必须是【本会话】生成）
  if (/^(最近(生成|画|做)的(一?张)?图|最近一张|最后一张|上?一次生成的图|上张图|上一张)$/.test(raw)) {
    // ① 本会话「最近一张」干净字节缓存（持久化）：绝对的干净磁盘结果图（不叠红框），首选。
    if (rctx && rctx.lastRedraw && Buffer.isBuffer(rctx.lastRedraw.bytes)) {
      return { bytes: rctx.lastRedraw.bytes, ext: rctx.lastRedraw.ext || '.png', display: '最近一张', mediaType: 'image/png' }
    }
    // ② store 本会话最新变体的 /view URL → 干净磁盘结果图（ComfyUI 原始输出，绝不叠红框）。
    //    把它提前到「会话历史提取」之前：历史提取可能拿到带红框的标注图，引起"上次的框残留"。
    const urls = (rctx && Array.isArray(rctx.latestUrls)) ? rctx.latestUrls : []
    for (const url of urls) {
      try {
        const bytes = await fetchBytes(url, signal)
        return { bytes, ext: extOfName(url) || '.png', display: '最近一张', mediaType: 'image/png' }
      } catch { /* 试试下一个 */ }
    }
    // ③ 会话历史 events 提取（最后兜底：缓存/URL 都不可用时才回溯历史，可能带旧标注框）。
    const sessImg = await extractSessionLastGeneratedImage(rctx, signal)
    if (sessImg && Buffer.isBuffer(sessImg.bytes)) {
      return { bytes: sessImg.bytes, ext: sessImg.ext || '.png', display: '最近一张', mediaType: sessImg.mediaType || 'image/png' }
    }
    throw new Error(`"${raw}"：本会话还没有生成过图片；如要修改用户发的图请填 "用户发的图"`)
  }

  // 4) 本地文件路径
  if (existsSync(raw)) {
    const bytes = readFileSync(raw)
    const ext = extOfName(raw) || '.png'
    return { bytes, ext, display: raw, mediaType: extToMedia(ext) }
  }

  // 5) ComfyUI input/output 目录文件名
  const root = comfyRoot(config.workflowPath)
  for (const sub of ['input', 'output']) {
    const p = join(root, sub, raw)
    if (existsSync(p)) {
      const bytes = readFileSync(p)
      const ext = extOfName(p) || '.png'
      return { bytes, ext, display: raw, mediaType: extToMedia(ext) }
    }
  }
  throw new Error(`找不到重绘图片："${raw}"（支持：用户发的图/最近一张/文件路径/ComfyUI input、output 目录文件名/sha256 附件 id）`)
}

function latestGeneratedImage(config) {
  try {
    const dir = config.outputDir
    if (existsSync(dir)) {
      const files = readdirSync(dir)
        .filter((f) => /\.(png|jpe?g)$/i.test(f))
        .map((f) => ({ f, t: safeMtime(join(dir, f)) }))
        .sort((a, b) => b.t - a.t)
      if (files.length > 0) return join(dir, files[0].f)
    }
  } catch { /* ignore */ }
  return null
}
function safeMtime(p) { try { return statSync(p).mtimeMs } catch { return 0 } }

/** 源图字节 → sha256 十六进制（用户画框与源图绑定的指纹：框只对"当时那张图"有效）。 */
export function sourceShaOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 「用户已画框」关键词（client 端用户拖动红框并确认后，模型用此词取宿主记录的精确框）。 */
export function isUserRegionKeyword(spec) {
  return /^(用户(已|自己)?画(的)?框|沿用用户框|用用户框|用户框|手动画框)$/.test(String(spec || '').trim())
}

/** 仅解析重绘源图字节与归一化区域（不上传 ComfyUI）——「区域框定预览」用，秒级。
 *  rctx.userRegions: [{ srcSha, region:{bbox,polygon} }]（本会话用户确认过的框，按 ts 倒序）；
 *  redraw_region 为「用户已画框」关键词时，取与当前源图 sha 匹配的最新记录。 */
export async function resolveRedrawRegion(config, params, rctx, signal) {
  const resolved = await resolveRedrawImage(config, params, rctx, signal)
  let region = null
  if (isUserRegionKeyword(params.redraw_region)) {
    const sha = sourceShaOf(resolved.bytes)
    const recs = (rctx && Array.isArray(rctx.userRegions)) ? rctx.userRegions : []
    const hit = recs.find((r) => r && typeof r.srcSha === 'string' && r.srcSha === sha && r.region && Array.isArray(r.region.bbox))
    if (!hit) {
      throw new Error('redraw_region="用户已画框"：当前重绘源图与用户确认框的图不一致（或用户还没拖框确认），请先画框让用户确认，或用归一化坐标直接指定区域')
    }
    region = hit.region
  } else {
    region = parseRedrawRegion(params.redraw_region)
  }
  return { region, sourceBytes: resolved.bytes, ext: resolved.ext }
}

/**
 * 重绘主流程：解析图 → 上传原图 → 生成并上传蒙版 → 返回 ComfyUI 文件名。
 * @param rctx - { ctx, exec, latestUrls }
 * @returns {{ filename: string, region: {bbox:number[],polygon:number[][]|null}, sourceBytes: Uint8Array }}
 */
export async function prepareRedraw(config, params, rctx, signal) {
  const { region, sourceBytes, ext } = await resolveRedrawRegion(config, params, rctx, signal)
  const size = readImageSize(sourceBytes)
  const maskPng = buildMaskPng(size.width, size.height, region)

  const baseUrl = String(config.comfyuiBaseUrl).replace(/\/+$/, '')
  const fileName = `dsh_redraw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`
  const up = await uploadPart(baseUrl, '/upload/image', {
    type: 'input', subfolder: '', overwrite: 'true',
  }, 'image', fileName, sourceBytes, signal)
  log('uploaded image:', up.name)
  const ref = JSON.stringify({ filename: up.name, subfolder: '', type: 'input' })
  const mk = await uploadPart(baseUrl, '/upload/mask', {
    type: 'input', subfolder: '', overwrite: 'true', original_ref: ref,
  }, 'image', `mask_${fileName}`, maskPng, signal)
  // ⚠️ /upload/mask 的返回名才是「烘焙了 alpha 的原图」：server 把 putalpha 后的原图
  // 保存到【上传的 mask 文件路径】并返回该文件名——DS-10- 必须指它（原图文件保持无 alpha）。
  // LoadImage 输出 MASK = 1 - alpha → 画笔区(alpha 0) = MASK 1 = 重绘区。
  log('uploaded mask, baked image:', mk.name)
  // region（归一化区域，含 bbox 与可选 polygon）与源图字节一并返回：host 用它生成
  // 「区域示意」高亮预览（给用户看）与模型视图的区域框叠加（给模型自查）。
  return { filename: mk.name, region, sourceBytes }
}
