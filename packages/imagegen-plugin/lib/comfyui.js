// lib/comfyui.js —— ComfyUI 生图集成（移植自 YA code agent-app/src/main/comfyui.ts）
//
// 差异点（相对 YA code 原版）：
//   1. 去掉 ws 依赖：完成判定只看 /queue 轮询 + /history 取图（原版注释已声明"不再依赖 ws 完成"），
//      进度文本也一并去掉（DSH 工具执行无进度通道）。
//   2. waitForReady 封顶 30 次 × 2s = 60s（原版无限重试；DSH 里必须封顶，便于报错回退）。
//   3. injectParams 的取值优先用工具参数名（mapping.param，如 prompt_tags），
//      回退 DS 前缀键（如 'DS-01-'）——同时兼容工具调用与 YA code 参数块两种入参形态。
//   4. SaveImage 前缀用 dsh_（原版 ya_），与用户自己的 YA code 输出区分。
//   5. 输出目录直接用调用方传入的 outputDir（原版的 beforeTime/目录扫描逻辑废弃——history 提取已足够）。

import * as fs from 'node:fs'
import * as path from 'node:path'

function log(...args) {
  console.log('[comfyui]', ...args)
}

/**
 * 带超时与外部取消的 fetch（Node 17.3+ 无 AbortSignal.any，自行融合）。
 * 超时 reason 用自有文案（不带 "signal timed out" 字样，避免与 DSH 连接层超时混淆）。
 * 返回 Promise<Response>；超时/取消抛 DOMException。
 */
function fetchWithTimeout(url, init = {}, timeoutMs, signal) {
  const ac = new AbortController()
  let timer = null
  const onAbort = () => { ac.abort(signal && signal.reason !== undefined ? signal.reason : new DOMException('已取消', 'AbortError')) }
  if (signal) {
    if (signal.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
  }
  timer = setTimeout(() => { ac.abort(new DOMException(`ComfyUI 响应超时（${timeoutMs}ms）`, 'TimeoutError')) }, timeoutMs)
  return fetch(url, { ...init, signal: ac.signal }).finally(() => {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  })
}

/** ComfyUI 节点（转换后 API 格式） */
function loadWorkflow(workflowPath) {
  const raw = fs.readFileSync(workflowPath, 'utf-8')
  return JSON.parse(raw)
}

function isEditorFormat(wf) {
  return Array.isArray(wf.nodes)
}

function getNodeTitle(node) {
  const meta = node._meta
  if (meta?.title && typeof meta.title === 'string') return meta.title
  if (node.title && typeof node.title === 'string') return node.title
  return ''
}

// 编辑器格式 → API 格式：widgets_values 序号映射表（原版移植）
const WIDGET_MAP = {
  'CLIPTextEncode': { text: 0 },
  'CheckpointLoaderSimple': { ckpt_name: 0 },
  'VAEDecode': {},
  'VAEEncode': {},
  'EmptyLatentImage': { width: 0, height: 1, batch_size: 2 },
  'LoadImage': { image: 0, upload: 1 },
  'SaveImage': { filename_prefix: 0 },
  'KSampler': { seed: 0, steps: 2, cfg: 3, sampler_name: 4, scheduler: 5, denoise: 6 },
  'PrimitiveStringMultiline': { value: 0 },
  'easy int': { value: 0 },
  'easy float': { value: 0 },
  'Primitive': { value: 0 },
  'PrimitiveBoolean': { value: 0 },
  'PrimitiveFloat': { value: 0 },
  'CLIPLoader': { clip_name: 0, type: 1, device: 2 },
}

const NON_WIDGET_TYPES = new Set([
  'MODEL', 'CONDITIONING', 'LATENT', 'IMAGE', 'CLIP', 'VAE', 'MASK', 'CONTROL_NET',
])

function convertEditorToApi(editorWf) {
  const nodes = editorWf.nodes
  const links = editorWf.links
  const linkMap = new Map()
  if (links) {
    for (const l of links) {
      linkMap.set(l[0], [l[1], l[2]])
    }
  }

  const api = {}
  for (const n of nodes) {
    const nid = String(n.id)
    const classType = n.type
    const entry = { class_type: classType, inputs: {} }
    const inputs = n.inputs
    const wv = n.widgets_values
    const typeWidgetMap = WIDGET_MAP[classType] || {}

    if (inputs) {
      let widgetIdx = 0
      for (const inp of inputs) {
        if (inp.link != null) {
          const src = linkMap.get(inp.link)
          if (src) {
            entry.inputs[inp.name] = [String(src[0]), src[1]]
          }
          if (inp.widget) widgetIdx++
          continue
        }

        const mappedIdx = typeWidgetMap[inp.name]
        if (mappedIdx !== undefined && wv && mappedIdx < wv.length) {
          entry.inputs[inp.name] = wv[mappedIdx]
          if (inp.widget) widgetIdx++
          continue
        }

        if (inp.type && NON_WIDGET_TYPES.has(inp.type)) {
          continue
        }

        if (inp.widget && wv && widgetIdx < wv.length) {
          entry.inputs[inp.name] = wv[widgetIdx]
          widgetIdx++
        }
      }
    }

    const title = n.title
    if (title && typeof title === 'string' && title.trim()) {
      entry._meta = { title }
    }

    api[nid] = entry
  }
  return api
}

function getNodeWidgetField(classType) {
  const widget = WIDGET_MAP[classType]
  if (widget) {
    const keys = Object.keys(widget)
    if (keys.length > 0) return keys[0]
  }
  return 'value'
}

/**
 * 按节点标题前缀（DS-01- 等）注入参数。
 * 取值：优先 args[mapping.param]（工具参数名，如 prompt_tags），回退 args[mapping.prefix]（'DS-01-' 键）。
 * 同一前缀匹配多个节点时全部注入同一值（与 YA code 一致；DS-Anima2 有两个 DS-01- 节点）。
 */
function injectParams(workflow, dsMappings, args) {
  const cloned = JSON.parse(JSON.stringify(workflow))
  let injectCount = 0
  for (const [nodeId, node] of Object.entries(cloned)) {
    const matchKey = getNodeTitle(node)
    const mapping = dsMappings.find((m) => matchKey.startsWith(m.prefix))
    if (!mapping) continue
    let value = args[mapping.param]
    if (value === undefined || value === null) value = args[mapping.prefix]
    if (value === undefined || value === null) continue
    if (node.inputs && typeof node.inputs === 'object') {
      const fieldName = getNodeWidgetField(node.class_type || '')
      node.inputs[fieldName] = value
      log(`injectParams: node ${nodeId} (${matchKey}, class_type=${node.class_type}) -> inputs.${fieldName} =`, value)
      injectCount++
    }
  }
  log('injectParams: total injections:', injectCount)
  return cloned
}

/** 无 DS 节点的工作流：前两个 CLIPTextEncode 依次注入 prompt / negative_prompt */
function applyFallbackMapping(workflow, args) {
  const cloned = JSON.parse(JSON.stringify(workflow))
  const promptVal = args.prompt
  const negVal = args.negative_prompt
  let posCount = 0
  for (const node of Object.values(cloned)) {
    if (node.class_type === 'CLIPTextEncode') {
      if (posCount === 0 && promptVal) {
        node.inputs.text = promptVal
        posCount++
      } else if (posCount === 1 && negVal) {
        node.inputs.text = negVal
        posCount++
      }
    }
  }
  return cloned
}

async function queuePrompt(baseUrl, workflow) {
  const url = baseUrl.replace(/\/+$/, '') + '/prompt'
  const body = JSON.stringify({
    prompt: workflow,
    extra_data: { id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}` },
    cache_disabled: true,
  })
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, 15000)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ComfyUI queue error ${res.status}: ${err}`)
  }
  const result = await res.json()
  return result
}

async function waitForImages(baseUrl, promptId, outputDir, signal) {
  const apiBase = baseUrl.replace(/\/+$/, '')
  const MAX_QUEUE_POLLS = 240
  const POLL_INTERVAL_MS = 1000
  const TOTAL_TIMEOUT_MS = 240000      // 240s 总封顶（原 300s）
  const REQUEST_TIMEOUT_MS = 8000      // 每次 /queue、/history 请求 8s 封顶
  const MAX_FAIL_STREAK = 5            // 连续 5 次请求失败即判 ComfyUI 无响应（不无限轮询）
  const DOWNLOAD_TIMEOUT_MS = 30000    // /view 下载 30s 封顶
  return new Promise((resolve, reject) => {
    let done = false
    let queuePolls = 0
    let failStreak = 0
    let cleanup = () => {}
    const timeout = setTimeout(() => {
      finish(new Error('ComfyUI 生成超时（240 秒）'))
    }, TOTAL_TIMEOUT_MS)

    function finish(err, payload) {
      if (done) return
      done = true
      clearTimeout(timeout)
      cleanup()
      if (err) reject(err)
      else resolve(payload || { paths: [], images: [] })
    }

    async function pollQueue() {
      if (done) return
      try {
        const r = await fetchWithTimeout(apiBase + '/queue', {}, REQUEST_TIMEOUT_MS, signal)
        if (r.ok) {
          const q = await r.json()
          const running = (q.queue_running || []).map((x) => x[1])
          const pending = (q.queue_pending || []).map((x) => x[1])
          const stillThere = running.includes(promptId) || pending.includes(promptId)
          if (!stillThere) {
            const hr = await fetchWithTimeout(apiBase + `/history/${promptId}`, {}, REQUEST_TIMEOUT_MS, signal)
            if (hr.ok) {
              const h = await hr.json()
              const entry = h[promptId]
              if (entry?.status?.status_str === 'error') {
                let msg = 'ComfyUI 执行失败'
                for (const m of entry.status.messages || []) {
                  if (m[0] === 'execution_error' && m[1]?.exception_message) {
                    msg = 'ComfyUI 执行失败: ' + m[1].exception_message
                  }
                }
                finish(new Error(msg))
                return
              }
              const images = []
              if (entry.outputs) {
                for (const nodeOutput of Object.values(entry.outputs)) {
                  const imgs = nodeOutput.images
                  if (imgs) {
                    for (const img of imgs) {
                      images.push({
                        filename: img.filename,
                        subfolder: img.subfolder || '',
                        type: img.type || 'output',
                      })
                    }
                  }
                }
              }
              if (images.length > 0) {
                try {
                  const dl = await downloadImages(apiBase, images, outputDir, signal, DOWNLOAD_TIMEOUT_MS)
                  finish(undefined, dl)
                } catch (e) {
                  finish(e instanceof Error ? e : new Error(String(e)))
                }
                return
              }
            }
            finish(new Error('生成完成但未找到图片文件'))
            return
          }
          failStreak = 0
        }
      } catch (e) {
        if (signal?.aborted) {
          finish(new DOMException('已取消', 'AbortError'))
          return
        }
        // 单次瞬时失败：连续 MAX_FAIL_STREAK 次才判无响应（ComfyUI 忙/重启时快速失败，不拖死会话）
        failStreak++
        if (failStreak >= MAX_FAIL_STREAK) {
          finish(new Error(`ComfyUI 无响应（连续 ${MAX_FAIL_STREAK} 次轮询${e && e.message ? '：' + e.message : ''}）——请检查 ComfyUI 是否卡死或重启`))
          return
        }
        // 未达阈值：忽略，下一轮再试
      }
      queuePolls++
      if (queuePolls >= MAX_QUEUE_POLLS) {
        finish(new Error('生成超时（队列轮询未结束）'))
        return
      }
      if (!done) setTimeout(pollQueue, POLL_INTERVAL_MS)
    }

    if (signal) {
      signal.addEventListener('abort', () => {
        finish(new DOMException('已取消', 'AbortError'))
      }, { once: true })
    }

    pollQueue()
  })
}

async function downloadImages(baseUrl, images, outputDir, signal, requestTimeoutMs = 30000) {
  fs.mkdirSync(outputDir, { recursive: true })
  const paths = []
  for (const img of images) {
    const url = baseUrl.replace(/\/+$/, '') + `/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`
    const res = await fetchWithTimeout(url, {}, requestTimeoutMs, signal)
    if (!res.ok) {
      log('downloadImages: FAILED status:', res.status, 'for', img.filename)
      continue
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    const localPath = path.join(outputDir, img.filename)
    fs.writeFileSync(localPath, buffer)
    paths.push(localPath)
    log('downloadImages: saved', localPath, buffer.length)
  }
  // 保留 ComfyUI 侧元数据（filename/subfolder/type）：构建 /view URL 必需
  const files = images
    .map((img, i) => ({ ...img, localPath: paths[i] }))
    .filter((img) => img.localPath !== undefined)
  return { paths, images: files }
}

/** 等待 ComfyUI 就绪：封顶 15 次 × 2s + 每次 8s 请求超时（最坏 ~2.5 分钟） */
async function waitForReady(baseUrl, signal) {
  const MAX_ATTEMPTS = 15
  let attempts = 0
  let lastError = null
  while (attempts < MAX_ATTEMPTS) {
    attempts++
    try {
      const url = baseUrl.replace(/\/+$/, '') + '/'
      const res = await fetchWithTimeout(url, {}, 5000, signal)
      if (res.ok) {
        log('waitForReady: ready after', attempts, 'attempts')
        return
      }
      lastError = new Error(`status ${res.status}`)
    } catch (e) {
      lastError = e
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  const detail = lastError && lastError.message ? `（${lastError.message}）` : ''
  throw new Error(`ComfyUI 未就绪（${30} 秒超时）${detail}：请先通过「绘世启动器」启动 ComfyUI（默认 http://127.0.0.1:8188）`)
}

/**
 * 生成主入口。
 * @param {string} baseUrl - ComfyUI 地址（如 http://127.0.0.1:8188）
 * @param {string} workflowPath - 工作流 JSON 路径（编辑器或 API 格式均可）
 * @param {Array<{prefix:string,param:string,description:string}>} dsMappings - DS 前缀映射
 * @param {Record<string, unknown>} args - 注入参数（键可为 mapping.param 或 DS 前缀）
 * @param {string} outputDir - 图片下载保存目录
 * @param {AbortSignal} [signal]
 * @returns {Promise<{success:boolean, message:string, filePaths?:string[], images?:Array<{filename:string, subfolder:string, type:string, localPath:string}>}>}
 */
export async function generate(baseUrl, workflowPath, dsMappings, args, outputDir, signal) {
  try {
    await waitForReady(baseUrl, signal)

    let workflow = loadWorkflow(workflowPath)

    if (isEditorFormat(workflow)) {
      workflow = convertEditorToApi(workflow)
      log('converted editor -> api, nodes:', Object.keys(workflow).length)
    }

    const hasDsNodes = Object.values(workflow).some((n) => getNodeTitle(n).startsWith('DS-'))
    if (hasDsNodes) {
      workflow = injectParams(workflow, dsMappings, args)
    } else {
      workflow = applyFallbackMapping(workflow, args)
    }

    // 随机化 KSampler seed 绕过缓存
    let seedRandomized = false
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (node.class_type === 'KSampler' && typeof node.inputs?.seed === 'number') {
        const oldSeed = node.inputs.seed
        node.inputs.seed = Math.floor(Math.random() * 2 ** 53)
        log(`randomized seed for node ${nodeId}: ${oldSeed} -> ${node.inputs.seed}`)
        seedRandomized = true
      }
    }
    if (!seedRandomized) log('WARNING: no KSampler nodes found for seed randomization')

    // SaveImage 唯一前缀（文件层缓存绕过 + 与 YA code 的 ya_ 前缀区分）
    const uniquePrefix = `dsh_${Date.now()}_`
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (node.class_type === 'SaveImage' && node.inputs && typeof node.inputs.filename_prefix === 'string') {
        node.inputs.filename_prefix = uniquePrefix + node.inputs.filename_prefix
        log(`injected unique prefix for SaveImage node ${nodeId}: ${node.inputs.filename_prefix}`)
      }
    }

    const { prompt_id } = await queuePrompt(baseUrl, workflow)
    log('queued prompt_id:', prompt_id)
    const { paths, images } = await waitForImages(baseUrl, prompt_id, outputDir, signal)

    if (paths.length === 0) {
      return { success: false, message: '未生成任何图片' }
    }
    return { success: true, message: `生成了 ${paths.length} 张图片`, filePaths: paths, images }
  } catch (err) {
    return { success: false, message: `生成失败: ${err && err.message ? err.message : String(err)}` }
  }
}
