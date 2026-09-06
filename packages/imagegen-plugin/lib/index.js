// lib/index.js —— 生图插件 host 半区（静态 bundle，手写，免构建）
// 功能：注册官方工具 generate_image —— 调用本地 ComfyUI 工作流生图（DS 前缀参数注入系统），
//   经 /queue 轮询 + /history 取图 + /view 下载到配置的输出目录后返回图片 URL 列表；
//   图片只由 client 半区的「生图卡片」显示（经 /imagegen-proxy 取图），
//   工具结果不输出内核图片附件标记 —— 消息中只有一张卡片图，无第二张官方附图。
// 参考：YA code agent-app/src/main/comfyui.ts（F:\YA code），配置默认值取自
//   %APPDATA%\agent-app\config.json 的实测值。
// 依赖：ComfyUI 由用户手动启动（绘世启动器）；工作流 JSON 支持编辑器/API 两种格式。
// 装配：本插件只进 profile node_modules（link 依赖），由「生图模式」preset 行挂载，
//   不进 profile bundles —— 保证 generate_image 只在生图模式会话可见，任何加载问题
//   只影响该模式的会话，伤不到宿主。

import { copyFileSync, existsSync, mkdirSync, promises as fsp, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { generate } from './comfyui.js'
import { prepareRedraw, resolveRedrawRegion, findLatestUserImageRef, sourceShaOf, isUserRegionKeyword, parseRedrawRegion } from './redraw.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, '..', 'comfyui-config.json')
const LOCAL_CONFIG_PATH = join(__dirname, '..', 'comfyui.local.json')

export const name = 'dsh-imagegen'

export const inject = ['tools', 'webServer', 'userQuestions']

/** 默认配置 = 用户 YA code 实测值（%APPDATA%\agent-app\config.json） */
const DEFAULTS = {
  comfyuiBaseUrl: 'http://127.0.0.1:8188',
  workflowPath: join(__dirname, '..', 'workflows', 'anima.json'),
  outputDir: join(__dirname, '..', 'output'),
  // 设备相关（ComfyUI 位置/启动命令），默认空，由会话内/用户配置
  comfyuiCwd: undefined,
  comfyuiStartCommand: undefined,
  comfyuiStartArgs: undefined,
  dsMappings: [
    { prefix: 'DS-01-', param: 'prompt_tags', description: '标签词提示（英文标签）' },
    { prefix: 'DS-02-', param: 'prompt_nl', description: '自然语言描述' },
    { prefix: 'DS-03-', param: 'reference_name', description: '角色参考名' },
    { prefix: 'DS-04-', param: 'width', description: '图片宽度' },
    { prefix: 'DS-05-', param: 'height', description: '图片高度' },
    { prefix: 'DS-07-', param: 'characters', description: '画面人数' },
    { prefix: 'DS-08-', param: 'negative_tags', description: '标签词负面提示' },
    { prefix: 'DS-09-', param: 'mode', description: '文生图/局部重绘（透传，不在工具参数中暴露）' },
    { prefix: 'DS-10-', param: 'redraw_image', description: '重绘图像（host 上传后注入的 ComfyUI 文件名，模型不可见）' },
    { prefix: 'DS-11-', param: 'redraw_strength', description: '重绘强度（局部重绘 denoise，默认 0.9）' },
  ],
}

function loadConfig() {
  let out
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    out = { ...DEFAULTS, ...parsed, dsMappings: Array.isArray(parsed.dsMappings) ? parsed.dsMappings : DEFAULTS.dsMappings }
  } catch {
    out = { ...DEFAULTS, dsMappings: [...DEFAULTS.dsMappings] }
  }
  // 本机配置（gitignore，不入库）：comfyui.local.json 存在则覆盖。每次读 → 改文件即热生效（免重启）
  try {
    const local = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf-8'))
    out = { ...out, ...local, dsMappings: Array.isArray(local.dsMappings) ? local.dsMappings : out.dsMappings }
  } catch { /* 无本机配置则用默认 */ }
  return out
}

/** 探测 ComfyUI 是否就绪（HTTP 200 即认为就绪） */
async function probeComfy(base) {
  try {
    const res = await fetch(base + '/system_stats', { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch { return false }
}

/** 确保 ComfyUI 就绪：已运行直接返回；未运行自动 spawn 启动，并等待就绪（60s 封顶）。 */
async function ensureComfyuiReady(config, signal) {
  const base = String(config.comfyuiBaseUrl).replace(/\/+$/, '')
  if (await probeComfy(base)) return
  try {
    console.log('[imagegen] ComfyUI 未运行，自动启动: ' + config.comfyuiStartCommand + ' ' + (config.comfyuiStartArgs || []).join(' '))
    spawn(config.comfyuiStartCommand, config.comfyuiStartArgs || [], { cwd: config.comfyuiCwd, stdio: 'ignore' })
  } catch (err) {
    console.error('[imagegen] ComfyUI auto-start failed: ' + (err && err.message ? err.message : String(err)))
  }
  for (let i = 0; i < 30; i++) {
    if (signal && signal.aborted) return
    await new Promise((r) => setTimeout(r, 2000))
    if (await probeComfy(base)) {
      console.log('[imagegen] ComfyUI 就绪（自动启动成功）')
      return
    }
  }
  throw new Error('本地 ComfyUI 还不可用。请确认已安装 ComfyUI 并放好 Anima 模型，或告诉我它的路径（如 D:\\ComfyUI），我配好后再生成。')
}

const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

// ── sharp（宿主图片编解码，见文件路径快捷输入插件同款加载方式）────────────
// 用途：①模型视图——生成结果降采样 ≤1024px 并经附件通道给会话模型查看
// （附件限制 3.5MB/2000px，ComfyUI 原图 15-20MB 必须重编码）；
// ②区域示意——源图 + 红色半透明区域块（生图卡片「区域示意」小图）。
// 加载失败则两个功能降级为 no-op，不影响生图主流程。
const require = createRequire(import.meta.url)
let sharp = null
try {
  sharp = require('sharp')
} catch (err) {
  console.error('[imagegen] sharp unavailable, model view / region preview disabled: ' + (err && err.message ? err.message : String(err)))
}

const MODEL_VIEW_MAX_DIM = 1536 // 模型视图最长边（<2000px/3.5MB 附件限制；越大模型读网格刻度越清晰）
const ATTACH_MAX_BYTES = 3.5 * 1024 * 1024 // 与官方 DEFAULT_MAX_IMAGE_BYTES 一致
const PREVIEW_MAX_DIM = 1024 // 区域示意小图最长边（生图参数卡预览显示放大到约280px，源图保持1024 才清晰）
// 区域示意 / 模型视图的文件目录（插件私有，不污染用户输出目录）
const REDRAW_DIR = join(__dirname, '..', '_redraw')

/** 归一化区域 → 红色边框 SVG（模型视图/预览：标出重绘范围；多边形走折线轮廓）。 */
function regionBoxSvg(w, h, region, strokeWidth) {
  if (region && region.polygon) {
    const pts = region.polygon.map(([x, y]) => `${Math.round(x * w)},${Math.round(y * h)}`).join(' ')
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><polygon points="${pts}" fill="none" stroke="#ff3b30" stroke-width="${strokeWidth || 4}" stroke-linejoin="round"/></svg>`
  }
  const [x1, y1, x2, y2] = region ? region.bbox : [0, 0, 1, 1]
  const px = Math.round(x1 * w)
  const py = Math.round(y1 * h)
  const pw = Math.max(2, Math.round((x2 - x1) * w))
  const ph = Math.max(2, Math.round((y2 - y1) * h))
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="none" stroke="#ff3b30" stroke-width="${strokeWidth || 4}"/></svg>`
}

/**
 * 坐标网格 SVG（10% 间隔 + 刻度标号）：叠加到「供模型审框/定位」的预览图上，
 * 让框位置有明确的网格参照——模型不再盲估归一化坐标，而是对照网格精确校准
 * （如"眼睛落在 x≈0.40~0.58 / y≈0.48~0.58 这一格"）。仅加在带 region 的审框图上。
 * 可读性要点：主线 0.5 不透明度 + 1.5px；整 0.1 刻度大字号 + 底部/左侧双标；
 * 0.05 辅线细、0.25 不透明度——主次分明，模型读数不糊。
 * @param w,h - 目标图宽高（px）
 * @returns {string} SVG 字符串
 */
function buildGridSvg(w, h) {
  const parts = []
  // 0.05 辅线（细、低对比）：先画，被主线压住
  for (let i = 1; i < 20; i++) {
    if (i % 2 === 0) continue
    const fx = Math.round((i / 20) * w)
    const fy = Math.round((i / 20) * h)
    parts.push(`<line x1="${fx}" y1="0" x2="${fx}" y2="${h}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`)
    parts.push(`<line x1="0" y1="${fy}" x2="${w}" y2="${fy}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`)
  }
  // 0.10 主线（清晰）：模型对照它读数
  for (let i = 1; i < 10; i++) {
    const gx = Math.round((i / 10) * w)
    const gy = Math.round((i / 10) * h)
    parts.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${h}" stroke="rgba(255,255,255,0.5)" stroke-width="1.5"/>`)
    parts.push(`<line x1="0" y1="${gy}" x2="${w}" y2="${gy}" stroke="rgba(255,255,255,0.5)" stroke-width="1.5"/>`)
  }
  // 边框
  parts.push(`<rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/>`)
  // 刻度标号：底部（x 0.1..0.9）+ 左侧（y 0.1..0.9），加大字号 + 描边保证在任意背景可读
  const fs = Math.max(12, Math.round(Math.max(w, h) * 0.028))
  for (let i = 1; i < 10; i++) {
    const gx = Math.round((i / 10) * w)
    const gy = Math.round((i / 10) * h)
    const v = (i / 10).toFixed(1)
    const label = (t) => `<text x="${t.x}" y="${t.y}" fill="#ffffff" stroke="rgba(0,0,0,0.65)" stroke-width="${Math.max(1, fs * 0.16)}" paint-order="stroke" font-size="${fs}" font-family="monospace" font-weight="700" text-anchor="${t.anchor}">${v}</text>`
    parts.push(label({ x: gx - 3, y: h - 6, anchor: 'start' }))
    parts.push(label({ x: 4, y: gy + fs * 0.38, anchor: 'start' }))
  }
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

/** 归一化区域 → 红色半透明填充 SVG（区域示意：标出重绘范围）。 */
function regionFillSvg(w, h, region) {
  if (region && region.polygon) {
    const pts = region.polygon.map(([x, y]) => `${Math.round(x * w)},${Math.round(y * h)}`).join(' ')
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><polygon points="${pts}" fill="rgba(255,59,48,0.42)"/></svg>`
  }
  const [x1, y1, x2, y2] = region ? region.bbox : [0, 0, 1, 1]
  const px = Math.round(x1 * w)
  const py = Math.round(y1 * h)
  const pw = Math.max(2, Math.round((x2 - x1) * w))
  const ph = Math.max(2, Math.round((y2 - y1) * h))
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="rgba(255,59,48,0.42)"/></svg>`
}

/**
 * 模型视图：源图 → 缩放到 ≤MODEL_VIEW_MAX_DIM →（重绘时）叠加区域标注 → PNG/JPEG 重编码，
 * 保证 ≤ATTACH_MAX_BYTES。返回 { bytes, mediaType } 或 null（不可用/失败）。
 * @param srcBuf - 原始图片字节（ComfyUI 输出）
 * @param region - 归一化区域 {bbox,polygon}（null = 不画框）
 */
async function buildModelViewBytes(srcBuf, region) {
  if (!sharp) return null
  try {
    const meta = await sharp(srcBuf, { failOn: 'none' }).metadata()
    const w0 = meta.width || 0
    const h0 = meta.height || 0
    if (w0 <= 0 || h0 <= 0) return null
    // PNG 先试（视觉模型兼容性最好）；超限降级 JPEG 85 → JPEG 60
    const scale = Math.min(1, MODEL_VIEW_MAX_DIM / Math.max(w0, h0))
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const render = (format, options) => {
      let p = sharp(srcBuf, { failOn: 'none' }).rotate().resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true })
      if (region) {
        // 叠网格（10% 间隔+刻度，供模型定位校准）+ 区域描边框
        p = p.composite([
          { input: Buffer.from(buildGridSvg(w, h)), top: 0, left: 0 },
          { input: Buffer.from(regionBoxSvg(w, h, region, 4)), top: 0, left: 0 },
        ])
      }
      return p.toFormat(format, options).toBuffer()
    }
    const png = await render('png', {})
    if (png.length <= ATTACH_MAX_BYTES) return { bytes: png, mediaType: 'image/png' }
    const jpg = await render('jpeg', { quality: 85, mozjpeg: true })
    if (jpg.length <= ATTACH_MAX_BYTES) return { bytes: jpg, mediaType: 'image/jpeg' }
    const jpg60 = await render('jpeg', { quality: 60, mozjpeg: true })
    return { bytes: jpg60, mediaType: 'image/jpeg' }
  } catch (err) {
    console.error('[imagegen] model view build failed: ' + (err && err.message ? err.message : String(err)))
    return null
  }
}

/** 区域示意：源图 → 缩放到 ≤PREVIEW_MAX_DIM →（可选）红色半透明区域块 → PNG 字节。
 * withRegion=false：纯源图（交互画框卡用——红框由前端交互层绘制，避免"双层红块"观感）。
 * 返回 Buffer 或 null（不可用/失败）。 */
let previewBuildErr = '' // 最近一次 preview 构建失败详情（/status 暴露，便于诊断）
async function buildPreviewPng(srcBuf, region, withRegion = true) {
  if (!sharp) { previewBuildErr = 'no sharp'; return null }
  try {
    const meta = await sharp(srcBuf, { failOn: 'none' }).metadata()
    const w0 = meta.width || 0
    const h0 = meta.height || 0
    if (w0 <= 0 || h0 <= 0) { previewBuildErr = `bad dims ${w0}x${h0}`; return null }
    const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(w0, h0))
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const compos = withRegion && region
      ? [{ input: Buffer.from(regionFillSvg(w, h, region)), top: 0, left: 0 }]
      : []
    const out = await sharp(srcBuf, { failOn: 'none' })
      .rotate()
      .resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true })
      .composite(compos)
      .png()
      .toBuffer()
    previewBuildErr = ''
    return out
  } catch (err) {
    previewBuildErr = String(err && err.message ? err.message : err)
    console.error('[imagegen] region preview build failed: ' + previewBuildErr)
    return null
  }
}

/** 区域示意字节 → 落盘到插件私有目录，返回文件名（供 /imagegen-proxy/preview 读取）。 */
function savePreviewFile(buf) {
  if (!buf) return null
  try {
    mkdirSync(REDRAW_DIR, { recursive: true })
    const name = `preview_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.png`
    writeFileSync(join(REDRAW_DIR, name), buf)
    return name
  } catch (err) {
    console.error('[imagegen] preview save failed: ' + (err && err.message ? err.message : String(err)))
    return null
  }
}

// ── 生图结果图片内存通道 + 磁盘持久化 ──────────────────────────────────
// 工具结果文本对模型完全不含 URL/路径（模型会把图片引用复读进回复，
// 被 markdown 渲染成消息里的第二张图；它连本地路径都贴过）。
// client 半区（生图卡片）按下述接口按 callId 取本次生成的图片 URL：
//   GET  /imagegen-proxy/img?callId=<tool callId> → { imageUrls:[...], variants:[{urls,durationMs,ts}] }
//   POST /imagegen-proxy/regenerate {params,callId} → 不走 LLM，按同一参数重新生成一张并追加为变体
// 记录持久化到插件目录 imagegen-store.json：热重载/重启后历史卡片仍能取到图。
// 条目结构：callId → { ts, variants: [{ ts, urls: string[], durationMs? }] }（variants[0]=原始生图）。
const STORE_PATH = join(__dirname, '..', 'imagegen-store.json')
const IMAGE_STORE_LIMIT = 200
const IMAGE_STORE_TTL_MS = 7 * 24 * 3600 * 1000
const IMAGE_VARIANT_LIMIT = 10 // 每个 callId 最多保留的变体数（原始图 + 重新生成）
const imageStore = new Map() // callId → { ts, variants }

// ── 生图结果本地缓存 ────────────────────────────────────────────────────────
// 生成成功时把产物复制进插件私有缓存目录 _imgcache/（preview 图落盘 _redraw/ 同
// 模式）。/imagegen-proxy/view 在 ComfyUI 离线时优先从这里取图，outputDir 兜底——
// 保证 ComfyUI 未启动/产物目录被清理时历史生图卡片仍能显示。
const IMG_CACHE_DIR = join(__dirname, '..', '_imgcache')

/** 生成成功 → 把产物复制进缓存目录（失败不阻塞生图，只记日志）。 */
function cacheImageFiles(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  try {
    mkdirSync(IMG_CACHE_DIR, { recursive: true })
    for (const p of filePaths) {
      if (typeof p !== 'string' || p === '') continue
      const dest = join(IMG_CACHE_DIR, basename(p))
      try {
        if (statSync(dest).isFile()) continue // 已缓存
        copyFileSync(p, dest)
      } catch (err) {
        console.error('[imagegen] cache copy failed: ' + (err && err.message ? err.message : String(err)))
      }
    }
  } catch (err) {
    console.error('[imagegen] cache dir failed: ' + (err && err.message ? err.message : String(err)))
  }
}

/** 启动时清理超过 TTL 的缓存文件（与 store 条目一致：过期条目已无入口显示）。 */
function pruneImageCache() {
  try {
    if (!existsSync(IMG_CACHE_DIR)) return
    const now = Date.now()
    for (const f of readdirSync(IMG_CACHE_DIR)) {
      try {
        const p = join(IMG_CACHE_DIR, f)
        if (statSync(p).isFile() && now - statSync(p).mtimeMs > IMAGE_STORE_TTL_MS) rmSync(p, { force: true })
      } catch { /* 单个文件失败忽略 */ }
    }
  } catch { /* 清理失败不阻塞 */ }
}

function loadImageStore() {
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    const now = Date.now()
    for (const [k, v] of Object.entries(raw || {})) {
      if (!v || typeof v !== 'object') continue
      if (now - Number(v.ts || 0) > IMAGE_STORE_TTL_MS) continue
      // 兼容旧格式 { ts, urls } → 单变体
      let variants = (Array.isArray(v.variants) && v.variants.length > 0) ? v.variants : null
      if (!variants && Array.isArray(v.urls) && v.urls.length > 0) {
        variants = [{ ts: Number(v.ts || 0), urls: v.urls }]
      }
      if (!Array.isArray(variants) || variants.length === 0) continue
      imageStore.set(k, {
        ts: Number(v.ts || 0),
        variants,
        ...typeof v.preview === 'string' ? { preview: v.preview } : {},
      })
    }
  } catch { /* 首次运行无文件 */ }
}
function saveImageStore() {
  try {
    const obj = {}
    let n = 0
    for (const [k, v] of imageStore) {
      obj[k] = v
      if (++n >= IMAGE_STORE_LIMIT) break
    }
    writeFileSync(STORE_PATH, JSON.stringify(obj))
  } catch { /* 持久化失败不阻塞生图 */ }
}
function trimImageStore() {
  while (imageStore.size > IMAGE_STORE_LIMIT) {
    const oldest = imageStore.keys().next().value
    if (oldest === undefined) break
    imageStore.delete(oldest)
  }
}
/** 原始生图：新建条目（callId 唯一，直接覆盖）。preview = 区域示意文件名（可选）；session = 本会话 id（隔离"最近一张"）；
 * srcSha = 重绘源图 sha256（可选，用户画框与源图绑定用） */
function rememberImages(callId, imageUrls, durationMs, preview, session, srcSha) {
  try {
    if (callId) {
      const ts = Date.now()
      imageStore.set(String(callId), {
        ts,
        session: typeof session === 'string' && session !== '' ? session : '',
        variants: [{ ts, urls: Array.isArray(imageUrls) ? imageUrls : [], durationMs }],
        ...typeof preview === 'string' && preview !== '' ? { preview } : {},
        ...typeof srcSha === 'string' && srcSha !== '' ? { srcSha } : {},
      })
    }
    trimImageStore()
    saveImageStore()
  } catch { /* 内存通道失败不阻塞生图 */ }
}
// ── 用户确认框（client 端用户在画框卡上拖动手动校准的红框）────────────────
// 记录：sessionId → 最多 N 条 { srcSha, region:{bbox,polygon}, ts }（按 ts 倒序）；
// region 与源图 sha 绑定：模型用 redraw_region="用户已画框" 时，host 校验当前
// 重绘源图 sha 与记录一致才采用——杜绝把旧图的框应用到新图上。
// 持久化到磁盘：热重载/重启不丢。
const USER_REGION_PATH = join(__dirname, '..', 'imagegen-userregions.json')
const USER_REGION_MAX_PER_SESSION = 5
const userRegions = new Map() // sessionId → [{srcSha, region, ts}]
function loadUserRegions() {
  try {
    const raw = JSON.parse(readFileSync(USER_REGION_PATH, 'utf-8'))
    for (const [k, v] of Object.entries(raw || {})) {
      if (Array.isArray(v)) {
        userRegions.set(String(k), v.filter((r) => r && typeof r.srcSha === 'string' && r.region && Array.isArray(r.region.bbox)))
      }
    }
  } catch { /* 首次运行无文件 */ }
}
loadUserRegions()
function persistUserRegions() {
  try {
    const obj = {}
    for (const [k, v] of userRegions) obj[k] = v.slice(0, USER_REGION_MAX_PER_SESSION)
    writeFileSync(USER_REGION_PATH, JSON.stringify(obj))
  } catch { /* 持久化失败不阻塞 */ }
}
function rememberUserRegion(sessionId, srcSha, region) {
  try {
    if (!sessionId || typeof srcSha !== 'string' || !region || !Array.isArray(region.bbox)) return
    const key = String(sessionId)
    const list = (userRegions.get(key) || []).filter((r) => r.srcSha !== srcSha)
    list.unshift({ srcSha, region, ts: Date.now() })
    while (list.length > USER_REGION_MAX_PER_SESSION) list.pop()
    userRegions.set(key, list)
    persistUserRegions()
  } catch { /* 记录失败不阻塞 */ }
}
function userRegionsOf(sessionId) {
  const list = sessionId ? userRegions.get(String(sessionId)) : undefined
  return Array.isArray(list) ? list.slice().sort((a, b) => b.ts - a.ts) : []
}

/** 再次生成：在已有条目上追加变体（无条目则新建） */
function rememberRegeneration(callId, imageUrls, durationMs) {
  try {
    if (callId) {
      const key = String(callId)
      const prev = imageStore.get(key)
      const ts = Date.now()
      const variants = (prev && Array.isArray(prev.variants)) ? prev.variants.slice() : []
      variants.push({ ts, urls: Array.isArray(imageUrls) ? imageUrls : [], durationMs })
      while (variants.length > IMAGE_VARIANT_LIMIT) variants.shift()
      imageStore.set(key, {
        ts,
        ...(prev && typeof prev.session === 'string') ? { session: prev.session } : {},
        variants,
        ...(prev && typeof prev.preview === 'string') ? { preview: prev.preview } : {},
      })
    }
    trimImageStore()
    saveImageStore()
  } catch { /* 内存通道失败不阻塞生图 */ }
}
/** 提取调用所属会话 id（隔离"最近一张"：绝不拿到别的会话生成的图）
 * Agent 接口：agent.id 与 session 共享同一 identity（官方 Agent.runtime-types）；
 * session.header.id 亦同（官方 tool-fs-search 用法）。 */
function sessionIdOf(exec) {
  try {
    const agent = exec && exec.agent
    if (!agent) return ''
    const a = agent.session && agent.session.header ? agent.session.header.id : ''
    const s = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
    const id = (typeof agent.id === 'string' && agent.id !== '') ? agent.id : (a || s)
    return typeof id === 'string' ? id : ''
  } catch { return '' }
}
/** 「最近一张」（重绘 DS-10- 用）：imageStore 里【本会话】最新变体 → /view URL 候选列表。
 * 严格按会话过滤——绝不回退到其他会话的生成记录（用户明确要求：最近一张 = 本会话）。 */
function latestImageUrls(sessionId) {
  const entries = []
  for (const v of imageStore.values()) {
    if (!v || !Array.isArray(v.variants) || v.variants.length === 0) continue
    if (sessionId !== undefined && v.session !== sessionId) continue
    const last = v.variants[v.variants.length - 1]
    if (last && Array.isArray(last.urls) && last.urls.length > 0) {
      entries.push({ ts: Number(v.ts || 0), url: last.urls[last.urls.length - 1] })
    }
  }
  entries.sort((a, b) => b.ts - a.ts)
  return entries.map((e) => e.url)
}

/** 本会话最近一次「真正生成的结果图」字节缓存（sessionId → {bytes, ext, ts}）。
 * 「最近一张」首选此缓存——它 100% 是本会话的、且【一定是干净的磁盘结果图】（ComfyUI
 * 原始输出，绝不叠红框）。持久化到磁盘：热重载/重启后缓存不丢，杜绝回退到会话历史
 * 里那种「带旧红框的标注图」，从根上消除"上次的框框残留"。
 *
 * 关键：只在【真正生图成功】后调用（rememberLastRedraw(root)），绝不记录预览/标注
 * 阶段的带框字节——这是源图干净的根本保证。 */
const redrawLastBytes = new Map()
const LAST_REDRAW_PATH = join(__dirname, '..', 'imagegen-lastredraw.json')
function loadLastRedraw() {
  try {
    const raw = JSON.parse(readFileSync(LAST_REDRAW_PATH, 'utf-8'))
    for (const [k, v] of Object.entries(raw || {})) {
      if (v && typeof v.ext === 'string' && typeof v.b64 === 'string' && v.b64) {
        redrawLastBytes.set(String(k), { bytes: Buffer.from(v.b64, 'base64'), ext: v.ext, ts: Number(v.ts || 0) })
      }
    }
  } catch { /* 首次运行无文件 */ }
}
loadLastRedraw()
function persistLastRedraw() {
  try {
    const obj = {}
    for (const [k, v] of redrawLastBytes) {
      if (v && Buffer.isBuffer(v.bytes)) obj[k] = { b64: v.bytes.toString('base64'), ext: v.ext, ts: v.ts }
    }
    writeFileSync(LAST_REDRAW_PATH, JSON.stringify(obj))
  } catch { /* 持久化失败不阻塞 */ }
}
function rememberLastRedraw(sessionId, bytes, ext) {
  try {
    if (sessionId && bytes && Buffer.isBuffer(bytes)) {
      redrawLastBytes.set(String(sessionId), { bytes, ext: ext || '.png', ts: Date.now() })
      persistLastRedraw()
    }
  } catch { /* 缓存失败不阻塞 */ }
}
function lastRedrawOf(sessionId) {
  const rec = sessionId ? redrawLastBytes.get(String(sessionId)) : undefined
  return rec && Buffer.isBuffer(rec.bytes) ? rec : null
}

/** 最近一条用户消息是否带了新图（用于 auto 默认的区分：带图→改用户发的图；不带图→改最近一张） */
function latestUserMsgHasImage(exec) {
  try {
    const events = exec && exec.agent && exec.agent.session ? exec.agent.session.events : undefined
    if (!Array.isArray(events)) return false
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (!ev || typeof ev !== 'object') continue
      if (ev.type === 'user/message') {
        const c = ev.data && ev.data.message && ev.data.message.content
        if (Array.isArray(c) && c.some((p) => p && p.type === 'image')) return true
        return false
      }
      if (ev.type === 'agent/inbox/spliced' && ev.data && Array.isArray(ev.data.inserted)) {
        for (const msg of ev.data.inserted) {
          if (msg && msg.role === 'user' && Array.isArray(msg.content)) {
            if (msg.content.some((p) => p && p.type === 'image')) return true
            return false
          }
        }
      }
    }
  } catch { /* 保守：认定无图 */ }
  return false
}

/** auto 默认 redraw_image：用户最近消息带新图 → '用户发的图'；本会话有生成记录 → '最近一张'；否则 '用户发的图' */
function autoRedrawImage(exec, sessionId) {
  const hasNewUserImage = latestUserMsgHasImage(exec)
  if (hasNewUserImage) return findLatestUserImageRef(exec) ? '用户发的图' : ''
  try {
    if (latestImageUrls(sessionId).length > 0) return '最近一张'
  } catch { /* 查不到就当默认用户图 */ }
  return findLatestUserImageRef(exec) ? '用户发的图' : ''
}
loadImageStore()
pruneImageCache()

function mediaTypeForPath(filePath) {
  return IMAGE_MEDIA_TYPES[extname(filePath).toLowerCase()] || 'image/png'
}

/** 工具参数 → DS 前缀注入字典（同时提供 fallback 用的 prompt/negative_prompt 键） */
const VALUE_DEFAULTS = { width: 812, height: 1216, characters: 1, redraw_strength: 0.9 }

function buildDsArgs(config, args) {
  const out = {}
  for (const m of config.dsMappings) {
    let v = args[m.param]
    // 模型可能不传可选参数（schema default 只是元数据，不会自动填入）——给 4 个默认参数兜底
    if ((v === undefined || v === null) && m.param in VALUE_DEFAULTS) v = VALUE_DEFAULTS[m.param]
    if (v === undefined || v === null) continue
    out[m.prefix] = v
  }
  // 保证必填键存在（即使 dsMappings 被用户改坏/删空）
  if (out['DS-01-'] === undefined && args.prompt_tags !== undefined) out['DS-01-'] = args.prompt_tags
  if (out['DS-02-'] === undefined && args.prompt_nl !== undefined) out['DS-02-'] = args.prompt_nl
  // fallback 键（无 DS 节点工作流用前两个 CLIPTextEncode）
  out.prompt = args.prompt_nl || args.prompt_tags || ''
  out.negative_prompt = args.negative_tags || ''
  return out
}

/** 本次生图实际生效的完整参数（AI 填的 + 默认兜底），供 client 参数卡展示。
 *  AI 未填但 schema 默认/无默认的可选参数：有默认的补出默认值，无默认且未填的跳过。
 *  反向提示词（negative_tags）始终展示：未填时置空，由前端显示「（无）」。 */
const PARAM_KEYS = ['prompt_tags', 'prompt_nl', 'reference_name', 'width', 'height', 'characters', 'mode', 'negative_tags', 'redraw_image', 'redraw_region', 'redraw_strength', 'preview_region_only']
function buildParams(args) {
  const p = {}
  for (const key of PARAM_KEYS) {
    let v = args[key]
    if ((v === undefined || v === null) && key in VALUE_DEFAULTS) v = VALUE_DEFAULTS[key]
    if (v === undefined || v === null) continue
    p[key] = v
  }
  if (p.negative_tags === undefined) p.negative_tags = ''
  return p
}

/** 「参数 → ComfyUI 出图」核心：execute（走 LLM 的工具调用）与 /regenerate（不走 LLM）
 *  共用同一路径，保证再次生成与原始生图行为完全一致。 */
async function generateWithParams(config, params, signal, rctx) {
  const startMs = Date.now()
  await ensureComfyuiReady(config, signal) // 生图前确保 ComfyUI 就绪（未运行则自动启动）
  let finalParams = params
  let redrawActive = false
  let redrawRegion = null // 归一化区域 {bbox,polygon|null}（重绘时）
  let redrawSourceBytes = null // 重绘源图字节（区域示意/模型视图用）
  // 局部重绘（DS-10-）：host 解析模型给出的图 → 上传原图 + 烘焙蒙版 → 注入文件名，
  // 并把 DS-09- 文生图/局部重绘开关强制切到「局部重绘」（false），工作流不再走文生图分支。
  if (params && typeof params.redraw_image === 'string' && params.redraw_image.trim() !== '') {
    const up = await prepareRedraw(config, params, rctx, signal)
    finalParams = { ...params, redraw_image: up.filename }
    redrawActive = true
    redrawRegion = (up.region && Array.isArray(up.region.bbox)) ? up.region : null
    redrawSourceBytes = up.sourceBytes || null
  }
  // 重绘强度（DS-11-）收拢为 0~1 数字（工作流 385 分支的 denoise 必须落在 [0,1]）
  if (redrawActive && finalParams.redraw_strength !== undefined && finalParams.redraw_strength !== '' && finalParams.redraw_strength !== null) {
    const n = Number(finalParams.redraw_strength)
    if (Number.isFinite(n)) finalParams = { ...finalParams, redraw_strength: Math.min(1, Math.max(0, n)) }
  }
  const dsArgs = buildDsArgs(config, finalParams)
  if (redrawActive) dsArgs['DS-09-'] = false
  dsArgs.outDir = config.outputDir
  // 局部重绘用重绘专用工作流（含 DS-10- LoadImage + VAEEncodeForInpaint + DS-11- denoise），
  // 否则用主文生图工作流（config.workflowPath，即 anima.json）。
  // 相对路径（如 workflows/anima.json）相对插件根目录解析，随包走（可移植、无盘符）
  const resolveWf = (p, fallback) => (p && typeof p === 'string' && !isAbsolute(p)) ? join(__dirname, '..', p) : (p || fallback)
  const wfPath = redrawActive
    ? resolveWf(config.redrawWorkflowPath, join(__dirname, '..', 'workflows', 'redraw.json'))
    : resolveWf(config.workflowPath, join(__dirname, '..', 'workflows', 'anima.json'))
  const result = await generate(
    config.comfyuiBaseUrl,
    wfPath,
    config.dsMappings,
    dsArgs,
    config.outputDir,
    signal,
  )
  if (!result.success) return { ok: false, error: result.message }
  const comfyBase = String(config.comfyuiBaseUrl).replace(/\/+$/, '')
  const imageUrls = (result.images || []).map((img) => {
    const qs = [
      `filename=${encodeURIComponent(img.filename)}`,
      `subfolder=${encodeURIComponent(img.subfolder || '')}`,
      `type=${encodeURIComponent(img.type || 'output')}`,
    ]
    return `${comfyBase}/view?${qs.join('&')}`
  })
  // 模型视图（模型自评）：
  //   modelView        —— 结果图（缩略，**不叠红框**）：模型查看「画面结果」。结果图必须干净，
  //                       否则叠加的红框会被当成「上次残留的框框」误导用户/模型，也会在
  //                       用户"保持这张"再改别处时被当作输入源残留旧框。
  //   modelRegionView  —— 源图+红框（仅重绘时）：红框画在「改之前的原图」上，模型
  //                       对照用户要求审「区域框位置对不对」——框偏了只调区域重画，
  //                       而不是对整张结果图挑毛病/全图重绘。
  //                       注意：此图源字节为【干净原图】，本次红框临时叠加上去，绝不残留旧框。
  // 文生图也附带 modelView（模型需要知道自己画了什么才能自查/微调）。
  // previewFilename —— 重绘时的区域示意小图文件名：生图卡片「区域示意」显示。
  let modelView = null
  let modelRegionView = null
  let previewFilename = null
  const src = result.filePaths && result.filePaths.length > 0 ? await readFileSafe(result.filePaths[0]) : null
  if (src) modelView = await buildModelViewBytes(src, null)
  if (redrawActive && redrawSourceBytes) {
    const pv = await buildPreviewPng(redrawSourceBytes, redrawRegion)
    previewFilename = savePreviewFile(pv)
    modelRegionView = await buildModelViewBytes(redrawSourceBytes, redrawRegion)
  }
  // 结果图落盘缓存（ComfyUI 离线也能显示历史卡片）
  cacheImageFiles(result.filePaths)
  return {
    ok: true,
    imageUrls,
    filePaths: result.filePaths,
    durationMs: Date.now() - startMs,
    modelView,
    modelRegionView,
    previewFilename,
  }
}

/** 读文件失败返回 null（模型视图/示意为非必要产物） */
async function readFileSafe(p) {
  try { return await fsp.readFile(p) } catch { return null }
}

/** 重新生成入口参数白名单化：只收已知参数键，长度截断，杜绝任意载荷 */
function sanitizeRegenParams(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const key of PARAM_KEYS) {
    const v = input[key]
    if (typeof v === 'string') {
      const s = v.slice(0, 4000)
      if (s.trim() !== '') out[key] = s
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v
    } else if (typeof v === 'boolean') {
      out[key] = v
    }
  }
  return out
}

/** 严格图片能力 gate（照抄官方 read-image 的运行时逻辑，仅用 ctx.get，不 import 官方包）：
 *  工具结果（image block）进入持久会话历史，路由不支持图片时适配器会拒绝该轮，故必须前置拒绝。 */
async function assertImageCapableRoute(ctx, exec) {
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('无法解析当前模型路由（provider/model/llm 缺失），拒绝生图')
  }
  const active = await llm.resolveModelInfo(provider, model, exec?.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`模型 "${model}" 不支持图片输入；生图工具结果需作为图片进入会话，请切换到支持图片的模型（如 deepseek-v4-flash-vision-exp）`)
  }
}

/** attachment 错误 → 人类可读消息（错误码为封闭字符串，可直接读取，无需 import） */
function mapAttachmentError(err) {
  const code = err && err.code ? err.code : ''
  const detail = err && err.message ? err.message : String(err)
  if (code === 'IMAGE_DIMENSION_TOO_LARGE') return `图片尺寸超过会话附件限制：${detail}。请降低 width/height（例如 1024x1024）后重试`
  if (code === 'IMAGE_TOO_MANY_PIXELS') return `图片像素数超过会话附件限制：${detail}。请降低 width/height 后重试`
  if (code === 'IMAGE_TYPE_MISMATCH') return `图片格式不被会话附件接受：${detail}。请让工作流输出 PNG/JPEG/WebP`
  return `附件提交失败：${detail}`
}

export function apply(ctx) {
  // ── 同源图片代理（/imagegen-proxy/view）──────────────────────────────────
  // client 半区（工具卡片 <img> 与「复制图片」按钮）经此取图：ComfyUI /view
  // 不返回 CORS 头，浏览器直连会被同源策略拦截；代理只面向本机回环 ComfyUI，
  // filename/subfolder/type 全部 URL 编码转发，基址强制 loopback（防 SSRF）。
  // 另挂 /imagegen-proxy/regenerate（POST）：不走 LLM，按卡片参数重新生成并追加变体。
  // ── 全局生成串行化（工具执行 + 再次生成共用一条链）────────────────────
  // ComfyUI 单实例：同一时刻只跑一个生图任务。内核已是 exclusive（工具调用串行），
  // 这里再兜住「再次生成」与工具调用交叉/并发的情况，并暴露运行状态给 client
  // （GET /imagegen-proxy/status → { runningCallId, genActive }）用于区分
  // 「生成中」和队列「排队中」（LLM 连发多张时排队的卡片显示 排队中…）。
  let genChain = Promise.resolve()
  let runningCallId = '' // 当前正在执行的生图调用 id（'' = 空闲）
  function enqueueGeneration(callId, fn) {
    const run = genChain.then(async () => {
      runningCallId = callId
      try { return await fn() } finally { if (runningCallId === callId) runningCallId = '' }
    })
    genChain = run.then(() => {}, () => {}) // 链上吞掉异常，前序失败不阻塞后续
    return run
  }
  const webServer = ctx.webServer
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/imagegen-proxy',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          // 生图图片通道：按工具调用 id 返回本次生成的图片 URL 与全部变体（client 生图卡片取图）
          if (url.pathname === '/imagegen-proxy/img') {
            const callId = url.searchParams.get('callId') || ''
            const rec = callId ? imageStore.get(callId) : undefined
            const variants = rec && Array.isArray(rec.variants) ? rec.variants : []
            const last = variants.length > 0 ? variants[variants.length - 1] : null
            const clean = variants
              .map((v) => ({ urls: Array.isArray(v.urls) ? v.urls : [], durationMs: typeof v.durationMs === 'number' ? v.durationMs : null, ts: Number(v.ts || 0) }))
              .filter((v) => v.urls.length > 0)
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            return res.end(JSON.stringify({
              imageUrls: last && Array.isArray(last.urls) ? last.urls : [],
              variants: clean,
              // 区域示意（局部重绘）：源图 + 红色半透明区域块，client 生图卡片显示
              previewUrl: rec && typeof rec.preview === 'string' && rec.preview !== ''
                ? '/imagegen-proxy/preview?callId=' + encodeURIComponent(callId)
                : null,
            }))
          }
          // 区域示意小图：按 callId 读插件私有目录中的高亮 PNG
          if (url.pathname === '/imagegen-proxy/preview') {
            const callId = url.searchParams.get('callId') || ''
            const rec = callId ? imageStore.get(callId) : undefined
            const name = rec && typeof rec.preview === 'string' ? rec.preview : ''
            if (name === '') {
              res.writeHead(404)
              return res.end('no preview')
            }
            let buf = null
            try { buf = readFileSync(join(REDRAW_DIR, name)) } catch {
              res.writeHead(404)
              return res.end('no preview file')
            }
            res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' })
            return res.end(buf)
          }
          // 运行状态：client 区分「生成中」与内核/全局队列「排队中」
          if (url.pathname === '/imagegen-proxy/status') {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            return res.end(JSON.stringify({ runningCallId, genActive: runningCallId !== '', previewErr: previewBuildErr }))
          }
          // 再次生成（不走 LLM）：POST { params, callId } → 按同一参数重新生成一张，追加为变体
          if (url.pathname === '/imagegen-proxy/regenerate') {
            if (req.method !== 'POST') {
              res.writeHead(405)
              return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
            }
            let body = null
            try {
              const chunks = []
              for await (const chunk of req) {
                chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk))
              }
              if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
            } catch {
              res.writeHead(400)
              return res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
            }
            const callId = body && typeof body.callId === 'string' ? body.callId : ''
            if (callId === '') {
              res.writeHead(400)
              return res.end(JSON.stringify({ ok: false, error: '缺少 callId' }))
            }
            const params = sanitizeRegenParams(body && body.params)
            if (Object.keys(params).length === 0) {
              res.writeHead(400)
              return res.end(JSON.stringify({ ok: false, error: '参数为空，无法重新生成' }))
            }
            try {
              const r = await enqueueGeneration('regen:' + callId, () => generateWithParams(loadConfig(), params, undefined, { ctx, latestUrls: latestImageUrls() }))
              if (!r.ok) return res.end(JSON.stringify({ ok: false, error: r.error }))
              if (r.imageUrls.length > 0) rememberRegeneration(callId, r.imageUrls, r.durationMs)
              return res.end(JSON.stringify({ ok: true, imageUrls: r.imageUrls, filePaths: r.filePaths, durationMs: r.durationMs }))
            } catch (err) {
              return res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }))
            }
          }
          // 用户确认框：client 端用户在「区域框定」卡上拖动手动校准红框后 POST
          // { callId, region } → host 记入本会话（region 与源图 sha 绑定），
          // 模型之后用 redraw_region="用户已画框" 取用。
          if (url.pathname === '/imagegen-proxy/region') {
            if (req.method !== 'POST') {
              res.writeHead(405)
              return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
            }
            let body = null
            try {
              const chunks = []
              for await (const chunk of req) {
                chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk))
              }
              if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
            } catch {
              res.writeHead(400)
              return res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
            }
            const callId = body && typeof body.callId === 'string' ? body.callId : ''
            const rec = callId ? imageStore.get(callId) : undefined
            if (!callId || !rec) {
              res.writeHead(400)
              return res.end(JSON.stringify({ ok: false, error: '缺少/无效 callId（请先画框生成预览卡）' }))
            }
            if (typeof body.region !== 'object' || body.region === null) {
              res.writeHead(400)
              return res.end(JSON.stringify({ ok: false, error: '缺少 region' }))
            }
            let region = null
            try {
              region = parseRedrawRegion(JSON.stringify(body.region))
            } catch (err) {
              res.writeHead(400)
              return res.end(JSON.stringify({ ok: false, error: 'region 无效：' + (err && err.message ? err.message : String(err)) }))
            }
            const srcSha = typeof rec.srcSha === 'string' && rec.srcSha !== '' ? rec.srcSha : ''
            const session = typeof rec.session === 'string' && rec.session !== '' ? rec.session : ''
            if (srcSha === '' || session === '') {
              res.writeHead(400)
              return res.end(JSON.stringify({ ok: false, error: '该卡片缺少源图指纹（旧数据），请重新画框后再确认' }))
            }
            rememberUserRegion(session, srcSha, region)
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            return res.end(JSON.stringify({ ok: true, region, srcSha }))
          }
          if (url.pathname !== '/imagegen-proxy/view') {
            res.writeHead(404)
            return res.end('not found')
          }
          const cf = loadConfig()
          const base = String(cf.comfyuiBaseUrl).replace(/\/+$/, '')
          let hostname = ''
          try { hostname = new URL(base).hostname } catch { hostname = '' }
          if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
            res.writeHead(403)
            return res.end('forbidden: comfyui base url must be loopback')
          }
          const filename = url.searchParams.get('filename')
          if (!filename) {
            res.writeHead(400)
            return res.end('missing filename')
          }
          const subfolder = url.searchParams.get('subfolder') || ''
          const type = url.searchParams.get('type') || 'output'
          const target = `${base}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`
          // 上游 ComfyUI 直连 → 失败（离线/404/超时）时回退本地产物文件，
          // 保证 ComfyUI 未启动时历史图片仍能显示。只接受纯文件名（拒绝路径成分）。
          let buf = null
          let ctype = 'application/octet-stream'
          let upstreamStatus = 0
          try {
            const upstream = await fetch(target, { signal: AbortSignal.timeout(15000) })
            upstreamStatus = upstream.status
            if (upstream.ok) {
              buf = Buffer.from(await upstream.arrayBuffer())
              ctype = upstream.headers.get('content-type') || 'application/octet-stream'
            }
          } catch { /* ComfyUI 离线：走本地回退 */ }
          if (buf === null) {
            const safeName = basename(filename)
            // ① 插件缓存目录（生成时落盘）→ ② outputDir（历史产物兜底）
            for (const dir of [IMG_CACHE_DIR, String(cf.outputDir || '')].filter(Boolean)) {
              try {
                const p = join(dir, safeName)
                if (statSync(p).isFile()) {
                  buf = readFileSync(p)
                  ctype = IMAGE_MEDIA_TYPES[extname(safeName).toLowerCase()] || 'image/png'
                  break
                }
              } catch { /* 该目录无此文件，尝试下一个 */ }
            }
          }
          if (buf === null) {
            res.writeHead(upstreamStatus === 404 ? 404 : 502)
            return res.end(upstreamStatus === 404 ? `upstream 404` : `upstream ${upstreamStatus || 'unreachable'}`)
          }
          res.writeHead(200, {
            'content-type': ctype,
            'content-length': buf.length,
            'cache-control': 'no-store',
          })
          return res.end(buf)
        } catch (err) {
          try {
            res.writeHead(500)
            res.end('imagegen-proxy error: ' + String(err && err.message ? err.message : err))
          } catch { /* ignore */ }
        }
      },
    }), 'imagegen: proxy')
  }

  // 工具注册进当前（preset）挂载层：只有加入生图模式的会话可见
  ctx.effect(() => ctx.tools.register({
    name: 'generate_image',
    description: '生成前会先检测本地 ComfyUI（127.0.0.1:8188）是否可用；若不可用，向用户说明本地 ComfyUI 未就绪，并询问本机 ComfyUI 安装路径，确认后写入配置再重试。通过本地 ComfyUI 工作流生成图片（anima 模型）。参数 prompt_tags（英文标签词）/prompt_nl（英文自然语言描述）必填；可参考角色名、尺寸、人数、负面标签。用户发图有【两种用法，不要混淆】：①参考图（用户说"生成一张类似的"）——不要填 redraw_image，直接描述你看到的用户图片（风格/构图/元素），走文生图；②局部修改（用户说"把这张图的××改成×"）——填 redraw_image + redraw_region 走两阶段。改图（局部重绘）直接生图：用户说"把这张图的××改成×"时，你直接调用 generate_image（填 redraw_image + 你根据用户描述和画面判断的 redraw_region，不必先画框），宿主直接生成改图结果给用户看——用户只看结果，不再要你先画框问确认。如需先预览画框位置再生成，可显式传 preview_region_only=true。redraw_region 推荐用归一化多边形 [[x1,y1],[x2,y2],...]（3~24 个点沿要改元素的轮廓点一圈，贴合形状不框多余背景；矩形 [x1,y1,x2,y2] 仍可用）。★用户可以在画框卡上亲手拖动红框微调位置（系统会记住）——一旦系统提示「用户已拖框确认」，正式生图请把 redraw_region 填 "用户已画框"（宿主直接采用用户校准好的精确框，比自己估坐标准得多）。redraw_image 的选择规则：用户本轮消息带了图片且是局部修改就用"用户发的图"（绝不允许用"最近一张"替代）；用户说"保持这张/就这张/刚才那张/把刚才生成的图改一下"等（指最近生成的结果图）→ redraw_image 填"最近一张"（= 本会话最近一次生成的图，跨会话不可用）。redraw_strength 调重绘强度（默认 0.9＝换色/换元素/去掉东西等大改；用户要「细化/增强细节/高清化/保持原样微调」→ 显式传 0.5~0.6）；禁止 全图/[0,0,1,1] 除非用户明确要求改整张图。禁止用 shell/bash 等工具去探测 ComfyUI 目录、工作流或图片尺寸——插件已封装一切。回复中不要包含任何网址、文件路径或图片展示标记，只用文字描述图片；图片由界面自动显示在会话的「生图卡片」中。所有对用户的回复一律使用简体中文（参数值本身按规则用英文）。需要本地 ComfyUI 服务已启动（绘世启动器）。',
    parameters: {
      type: 'object',
      properties: {
        prompt_tags: { type: 'string', description: '（必填）英文逗号分隔的标签词，描述画面；模型是 anima，标签需适配该模型，尽量精炼（DS-01-）' },
        prompt_nl: { type: 'string', description: '（必填）英文句子描述画面，补充标签词表达不了的内容（DS-02-）' },
        reference_name: { type: 'string', description: '（可选）角色参考名，用原作语言原名（日文角色用日文原名），可多个逗号分隔，2-3 个（DS-03-）' },
        width: { type: 'integer', default: 1920, description: '图片宽度，默认 1920（DS-04-）' },
        height: { type: 'integer', default: 1080, description: '图片高度，默认 1080（DS-05-）' },
        characters: { type: 'integer', default: 1, description: '画面人数，默认 1（DS-07-）' },
        negative_tags: { type: 'string', description: '（可选）英文标签词负面提示；品控负面词已内置，通常无需填写（DS-08-）' },
        redraw_image: { type: 'string', description: '（局部重绘用）原图。用户本轮消息带了图片时必须填 "用户发的图"（这是用户要改的那张，绝不允许用"最近一张"代替）；"最近一张"只表示【本会话】之前生成的图，跨会话无此概念；也可填图片文件路径或 ComfyUI input/output 目录里的文件名（DS-10-）' },
        redraw_region: { type: 'string', description: '（局部重绘时必填）重绘区域，三种格式任选：①归一化矩形 [x1,y1,x2,y2]（0~1，如 [0.4,0.0,0.75,0.15]＝顶部右侧小范围）；②归一化多边形 [[x1,y1],[x2,y2],...]（3~24 个点，**推荐**：沿用户要改元素的轮廓点一圈，贴合形状、不框多余背景，如魔法书用 6~10 个点沿书轮廓）；③关键词 "用户已画框"（**最优先**：用户已在该图的画框卡上手动拖动确认过位置时填它——宿主直接用用户校准好的精确框，绝不要再自己估坐标；若当前源图与用户框不匹配会报错）。先判断用户要改动元素的位置再框小范围；禁止 全图/[0,0,1,1]（除非用户明确要求改整张图）。预设词 中心/上半部/下半部/左半部/右半部/左上/右上/左下/右下 也可用' },
        redraw_strength: { type: 'number', default: 0.9, description: '（可选）重绘强度 0~1，仅当 redraw_image 已填时生效，默认 0.9（换色/换元素/去东西等大改用）；用户要「细化/增强细节/高清化/保持原样微调」→ 显式传 0.5~0.6（DS-11-）' },
        preview_region_only: { type: 'boolean', description: '（两阶段开关，局部重绘第一段不用传=自动生效）本工具对任何局部重绘调用【默认只画框、不生成】——红框画在源图上秒级返回。你审框：①没对准用户要改的位置→调 redraw_region 再调一次（会再弹一张框卡，直到对准）；②对准了→用完全相同参数并传 preview_region_only=false 再调用，本次才真正生图。若卡片提示"用户已手动拖框确认"，则改用 redraw_region="用户已画框" 生图' },
      },
      required: ['prompt_tags', 'prompt_nl'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          filePaths: { type: 'array', items: { type: 'string' } },
          imageUrls: { type: 'array', items: { type: 'string' } },
          params: { type: 'object', additionalProperties: true },
          durationMs: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (args, value) => {
        if (value && value.ok) {
          // ── preview_region_only：区域框定预览（未生图） ──
          if (value.previewOnly === true) {
            const blocks = []
            if (value.modelView && Array.isArray(value.modelView.views)) {
              for (const ref of value.modelView.views) {
                if (ref) blocks.push({ type: 'image', attachment: ref })
              }
            }
            const pre = value.params && value.params.redraw_region ? `（redraw_region=${value.params.redraw_region}）` : ''
            const paramsLine = value.params && typeof value.params === 'object'
              ? `\n<params>${JSON.stringify(value.params)}</params>`
              : ''
            blocks.push({
              type: 'text',
              text: `区域框定预览${pre}：红框 = 本次要重绘的区域（画在改之前的原图上），尚未生图。图上有 10% 间隔的白色坐标网格（底边/左侧标刻 0.1~0.9），红框与网格重叠——请【对照网格】精确校准 redraw_region 的归一化坐标（0~1）：看红框四条边分别落在哪条网格线上，眼睛/鼻子等要改的部位占据哪几个格子，据此给出尽量贴合的四边数值，而不是凭感觉估。请先做「审框」：①红框是否准确框住了用户要求改动的位置（框偏/框大/框小都算不准）？②审框后【必须】调用 ask_user_question 询问用户「这个区域画得对吗？」，选项用「对的，开始生图」/「不对，重新画框」——等用户选择，绝不允许跳过提问直接生图；用户选「不对」→ 调整 redraw_region 后重新以 preview_region_only=true 画框并再次询问；用户选「对的」→ 用相同参数把 preview_region_only 改为 false 重新调用 generate_image 正式生图。${value.userRegionActive === true ? '\n★【重要】用户已在这张卡上手动拖动过红框并确认了位置——正式生图时请把 redraw_region 改为 "用户已画框"（宿主会用用户校准过的精确框，不要再自己估坐标）。' : ''}${paramsLine}`,
            })
            return blocks
          }
          const durLine = typeof value.durationMs === 'number' ? `\n耗时：${(value.durationMs / 1000).toFixed(1)} 秒` : ''
          // 对模型可见的文本保持零 URL/路径（模型会把图片引用复读进回复，被渲染成第二张图）；
          // 模型「看」结果图的通道是 image block（value.modelView 附件引用），不是文本。
          const paramsLine = value.params && typeof value.params === 'object'
            ? `\n<params>${JSON.stringify(value.params)}</params>`
            : ''
          const blocks = []
          // 模型视图（顺序）：①源图+红框区域标注（审「框位置对不对」）②结果图（审画面）。
          // 经图片附件进入会话：模型可直接目视核对，不用猜像素坐标。
          if (value.modelView && Array.isArray(value.modelView.views)) {
            for (const ref of value.modelView.views) {
              if (ref) blocks.push({ type: 'image', attachment: ref })
            }
          } else if (value.modelView && value.modelView.attachment) {
            blocks.push({ type: 'image', attachment: value.modelView.attachment })
          }
          const isRedraw = !!(value.params && value.params.redraw_image)
          const selfCheck = isRedraw
            ? '本次给你两张图：第一张是「重绘区域标注」（本次重绘的红框画在改之前的原图上），第二张是重绘结果。检查顺序：①先看第一张的红框位置是否正确框住了用户要求改动的位置——框偏了/框大了/框小了都属于区域不对，请只调整 redraw_region（用归一化坐标精确框住目标）再次局部重绘，不要改 full 图；②框对了再看第二张的画面内容是否符合要求。'
            : '请检查画面是否呼应了用户的描述。'
          const adjustHint = isRedraw
            ? '若第①步判定区域不对：修改 redraw_region 后重新调用 generate_image（保持 redraw_image 和其余参数不变）。若第②步判定内容不对：调整 redraw_strength（0.9→0.6→0.95，改色/换元素默认就已用 0.9；大改 0.9+，尽量保持原样才调低）或提示词。最多再试 2 次，然后在回复中向用户说明你检查了什么、调整了什么。'
            : '若画面不符合用户意图，请调整提示词/参数再次调用 generate_image（最多再试 2 次），并在回复中说明。'
          const sawBlock = blocks.length > 0
          blocks.push({
            type: 'text',
            text: `生成完成。本次结果图已作为图片附件提供给你查看（生图卡片同步显示）。${selfCheck}${adjustHint}回复中不要包含网址、文件路径或图片展示标记，只用文字描述图片。${sawBlock ? '' : '（本次结果图未附加为图片，请根据用户反馈调整。）'}${durLine}${paramsLine}`,
          })
          return blocks
        }
        return [{ type: 'text', text: `生图失败：${value ? value.error || value.message || JSON.stringify(value) : '未知错误'}` }]
      },
    },
    // 并行声明 + host 全局串行链（两条都要）：
    //   - 并行 → 模型连发多张时所有卡片立即渲染，用户能看到「一共要了几张」；
    //     （若改为 exclusive，内核会把后排调用压到前一张提交后才 dispatch，卡片
    //       "一个一个出来"，排队状态无从显示）
    //   - 真正串行由 enqueueGeneration 全局链保证：ComfyUI 单实例同一时刻只跑一张，
    //     排队的卡片经 /imagegen-proxy/status 显示「排队中…」
    isConcurrencySafe: () => true,
    timeoutMs: 480000,
    async execute(args = {}, exec = {}) {
      const config = loadConfig()
      const sessionId = sessionIdOf(exec)
      // 前置门槛：生图依赖模型"能看图"（结果图/源图作为图片附件给模型自评，局部重绘要定位区域）。
      // 当前模型不支持图片输入 → 直接拒绝，不进入任何生图工作流。
      try {
        await assertImageCapableRoute(ctx, exec)
      } catch (err) {
        return { ok: false, error: '当前模型不支持图片输入，无法生图：' + (err && err.message ? err.message : '请切换到支持图片的模型（如 deepseek-v4-flash-vision-exp）') }
      }
      // 局部重绘意图锁定：模型漏填 redraw_image 时自动补默认。
      // 智能默认：本会话已有生成记录且用户最近一条消息没带新图 → "最近一张"（用户说"保持这张"的场景）；
      // 否则 → "用户发的图"（用户带了图直接改的场景）。绝不让模型猜错，也杜绝它拿错图。
      if (
        !args || typeof args.redraw_image !== 'string' || args.redraw_image.trim() === ''
      ) {
        const previewIntent = args && (args.preview_region_only !== undefined || args.redraw_region !== undefined)
        if (previewIntent && exec) {
          const auto = autoRedrawImage(exec, sessionId)
          if (auto) args = { ...args, redraw_image: auto }
        }
      }
      // ── 阶段一：区域框定预览（只画框，绝不生图）──────────────────────
      // 用户要求的流程是硬性的：画框 → 看框位置 → 不对重画 → 对了才生图。
      // 因此【局部重绘 always 先画框】：只要带了 redraw_image 且没有显式
      // preview_region_only=false，就只画框并返回，让模型先审框；模型确认框
      // 之后必须带 preview_region_only=false 再调用一次才会真正生图。
      const isRedrawReq = !!(
        args && typeof args.redraw_image === 'string' && args.redraw_image.trim() !== ''
      )
      const wantPreview = isRedrawReq && args && args.preview_region_only === true
      if (wantPreview) {
        const rctx = { ctx, exec, sessionId, latestUrls: latestImageUrls(sessionId), lastRedraw: lastRedrawOf(sessionId), userRegions: userRegionsOf(sessionId) }
        const callId = String(exec.callId || '')
        try {
          const up = await resolveRedrawRegion(config, args, rctx, exec.signal)
          // 注意：预览阶段【不】更新「最近一张」缓存——缓存只应由真正生图成功后的
          // 干净磁盘结果刷新（否则会把回退来的带框源图污染进缓存，旧框再次残留）。
          // UI 卡片区域示意（512 红色半透明）＋模型视图（1024 红框）
          const srcSha = sourceShaOf(up.sourceBytes)
          const pv = await buildPreviewPng(up.sourceBytes, up.region, false)
          const previewFilename = savePreviewFile(pv)
          const regionBytes = await buildModelViewBytes(up.sourceBytes, up.region)
          rememberImages(callId, [], 0, previewFilename, sessionId, srcSha)
          // 用户确认框状态（与本次源图一样才有效）：给模型提示「用户已拖框确认，可直接用'用户已画框'」
          const userHit = rctx.userRegions.find((r) => r && r.srcSha === srcSha) || null
          let regionRef = null
          let canAttach = false
          try { await assertImageCapableRoute(ctx, exec); canAttach = true } catch { /* 非 vision 模型：不附加图片 */ }
          if (canAttach && regionBytes && regionBytes.bytes) {
            try {
              const attachments = ctx.get('attachments')
              if (attachments !== undefined) {
                regionRef = await attachments.saveImage({
                  data: regionBytes.bytes,
                  mediaType: regionBytes.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
                  name: '重绘区域标注',
                })
              }
            } catch (err) {
              console.error('[imagegen] region preview attachment save failed: ' + (err && err.message ? err.message : String(err)))
            }
          }
          return {
            ok: true,
            previewOnly: true,
            byteSize: Buffer.byteLength(Buffer.from(up.sourceBytes)),
            modelView: regionRef ? { views: [regionRef] } : null,
            params: buildParams({ ...args, preview_region_only: true }),
            userRegionActive: !!userHit,
            userRegion: userHit ? userHit.region : null,
          }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        }
      }
      // 全局串行链：与「再次生成」共用同一队列（ComfyUI 单实例），
      // 同时让 /imagegen-proxy/status 暴露执行状态给 client 区分 生成中/排队中。
      const rctx = { ctx, exec, sessionId, latestUrls: latestImageUrls(sessionId), lastRedraw: lastRedrawOf(sessionId), userRegions: userRegionsOf(sessionId) }
      // 文生图（非改图）生成前，向用户确认一次；改图（局部重绘）走两阶段画框，不再额外确认。
      if (!isRedrawReq) {
        try {
          const q = await ctx.userQuestions.ask({
            questions: [{
              id: 'confirm', header: '生图确认',
              question: '要生成这张图片吗？确认后将开始生成。',
              options: [{ label: '生成', description: '开始生图' }, { label: '取消', description: '不生成' }],
            }],
            ...(exec && exec.agent ? { agent: exec.agent } : {}),
            signal: exec && exec.signal,
          })
          const ans = q && q.answers && q.answers[0]
          const sel = ans && Array.isArray(ans.selected) ? ans.selected[0] : ''
          if (sel !== '生成') return { ok: false, error: '用户未确认，已取消生成' }
        } catch (err) {
          return { ok: false, error: '生图确认失败：' + (err && err.message ? err.message : String(err)) }
        }
      }
      const r = await enqueueGeneration(String(exec.callId || ''), () => generateWithParams(config, args, exec.signal, rctx))
      if (!r.ok) return { ok: false, error: r.error }

      const first = r.filePaths[0] || ''
      let bytes = 0
      try { bytes = statSync(first).size } catch { /* ignore */ }
      // 「最近一张」内存缓存：本会话最近生成的图（用户"保持这张"场景的直接来源）
      try {
        if (first) rememberLastRedraw(sessionId, readFileSync(first), extname(first) || '.png')
      } catch { /* 缓存失败不阻塞 */ }
      // 图片 URL 走内存通道（client 经 /imagegen-proxy/img 按 callId 取），
      // 工具结果文本保持零 URL/路径——模型无法把图片引用复读进回复。
      rememberImages(exec.callId, r.imageUrls, r.durationMs, r.previewFilename, sessionId)
      // 模型视图（模型自评闭环）：会话模型支持图片输入时，把本次结果（缩略+红框）
      // 注册为附件并随工具结果作为 image block 返回——模型能直接看到自己画了什么，
      // 由 persona 指引自查重绘区域内容是否符合用户要求、必要时调整参数重试。
      // 非 vision 模型 / 附件不可用 / 保存失败 → modelView 为 null（还原纯文本行为）。
      let modelView = null
      let visionCapable = false
      try {
        await assertImageCapableRoute(ctx, exec)
        visionCapable = true
      } catch { /* 非 vision 模型：不附加图片，走纯文本结果 */ }
      // 附件服务经 ctx.get 安全获取：直接属性访问 ctx.attachments 在 cordis
      // 代理下会因未注入而抛 "cannot get property ... without inject"，而不是
      // 返回 undefined（服务未挂载时 get 返回 undefined，走纯文本结果）——与官方
      // read_image 的 ctx.get('attachments') 一致。
      const attachments = ctx.get('attachments')
      let modelViews = []
      if (visionCapable && attachments !== undefined) {
        const upload = async (mv, name) => {
          try {
            return await attachments.saveImage({
              data: mv.bytes,
              mediaType: mv.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
              name,
            })
          } catch (err) {
            console.error('[imagegen] model view attachment save failed (' + name + '): ' + (err && err.message ? err.message : String(err)))
            return null
          }
        }
        // 顺序：区域标注（源图+红框）在前、结果图在后——模型先审「框在哪」再审「画得怎样」。
        if (r.modelRegionView && r.modelRegionView.bytes) {
          const ref = await upload(r.modelRegionView, '重绘区域标注')
          if (ref) modelViews.push(ref)
        }
        if (r.modelView && r.modelView.bytes) {
          const ref = await upload(r.modelView, '生成结果')
          if (ref) modelViews.push(ref)
        }
        if (modelViews.length > 0) modelView = { views: modelViews }
      }
      return {
        ok: true,
        path: first,
        filePaths: r.filePaths,
        imageUrls: r.imageUrls,
        bytes,
        durationMs: r.durationMs,
        params: buildParams(args),
        modelView,
      }
    },
  }), 'imagegen: generate_image tool')
}
