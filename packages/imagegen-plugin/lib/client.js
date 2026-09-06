// lib/client.js —— 生图插件 client 半区（静态 bundle，手写，免构建）
// 为 generate_image 工具注册专属渲染行（keyed slot tool.call.toolview）：
//   - 图片 URL 从 host 按 callId 存取（/imagegen-proxy/img 返回 {imageUrls, variants}）；
//     工具结果文本不含图片语法/URL，模型不会把图片引用复读进回复，消息里只有卡片这张图
//   - 生图卡片：卡片底部显示 耗时 + 尺寸(居中) + 「再次生成」按钮（走 host /regenerate，
//     不走 LLM，按同参数重新生成）→ 生成的新卡片依次堆叠在下方，标「第 N 次」
//   - 「再次生成」点击后弹小窗：可改生图次数（1-8），确认/取消；串行生成
//   - 图片经同源代理 /imagegen-proxy/view 显示（ComfyUI /view 无 CORS 头，浏览器直连被同源策略拦截）
//   - 每张图配「复制图片」按钮：fetch 图片 → ClipboardItem → 系统剪贴板（可粘贴到微信/QQ/Word 等）
//   - 点击图片放大预览
// 格式参考：窗口置顶插件 lib/client.js（静态 bundle + __ModuleLoader__）。
window.__ModuleLoader__.load({
	id: "dsh-imagegen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const ReactDOM = require("react-dom");
		const { IconCopyOutline16, IconCheckOutline16, Tooltip } = require("@deepseek-ai/dsh-client-ui-primitives");
		const inject = ["slots"];

		const h = React.createElement;

		// ── 简易动画（生成中转圈 + 占位脉冲）──────────────────────────────
		const CSS = [
			'@keyframes dsh-img-spin{to{transform:rotate(360deg)}}',
			'@keyframes dsh-img-pulse{0%,100%{opacity:.3}50%{opacity:1}}',
			'.dsh-img-spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(127,127,127,.25);border-top-color:rgba(127,127,127,.9);border-radius:50%;animation:dsh-img-spin .8s linear infinite;vertical-align:-2px}',
			'.dsh-img-pulse{animation:dsh-img-pulse 1.2s ease-in-out infinite}',
			// 官方 MessageIconActions .action 同款：28×28 圆形图标钮，hover 底色
			'.dsh-img-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
			'.dsh-img-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
		].join('\n')

		function CssStyle() {
			return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
		}

		// ── 工具输出文本块 → 图片 URL 列表（老格式兼容兜底）────────────────
		// 新格式：图片 URL 由 host 按 callId 存储，经 /imagegen-proxy/img?callId= 获取
		// （ImagegenToolView 挂载后 fetch）。此函数只兜底老消息：
		//  1) <params> JSON 里的 imageUrls 数组
		//  2) 老格式 markdown 图片行 ![生图 N](http://...)
		function extractImageUrls(block) {
			const out = []
			const params = extractParams(block)
			if (params && Array.isArray(params.imageUrls)) {
				for (const u of params.imageUrls) {
					if (typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'))) out.push(u)
				}
				if (out.length > 0) return out
			}
			if (!block || !Array.isArray(block.content)) return out
			for (const b of block.content) {
				if (b && b.type === 'text' && typeof b.text === 'string') {
					const re = /!\[[^\]]*\]\(([^)]*)\)/g
					let m
					while ((m = re.exec(b.text)) !== null) {
						const u = (m[1] || '').trim()
						if (u.startsWith('http://') || u.startsWith('https://')) out.push(u)
					}
				}
			}
			return out
		}

		// ComfyUI 直链 → 同源代理路径（仅提取路径与查询串，丢弃主机名）
		function proxyUrl(url) {
			try {
				const u = new URL(url)
				if (u.protocol === 'http:' || u.protocol === 'https:') {
					return '/imagegen-proxy' + u.pathname + u.search
				}
			} catch (e) { /* 保持原样 */ }
			return url
		}

		// 工具输出文本（错误行也走这里）
		function resultText(block) {
			const parts = []
			if (block && Array.isArray(block.content)) {
				for (const b of block.content) {
					if (b && b.type === 'text') parts.push(b.text)
				}
			}
			if (parts.length === 0 && block && block.error) {
				parts.push((block.error.name || 'error') + ': ' + (block.error.code || ''))
			}
			return parts.join('\n')
		}

		// 生图耗时（host 在工具结果文本末尾输出「耗时：X.X 秒」）
		function extractDuration(block) {
			if (!block || !Array.isArray(block.content)) return null
			for (const b of block.content) {
				if (b && b.type === 'text' && typeof b.text === 'string') {
					const m = /耗时[：:]\s*([\d.]+)\s*秒/.exec(b.text)
					if (m) {
						const v = parseFloat(m[1])
						if (Number.isFinite(v)) return v
					}
				}
			}
			return null
		}

		function formatDuration(seconds) {
			if (seconds === null || !Number.isFinite(seconds)) return ''
			if (seconds < 60) return '耗时 ' + seconds.toFixed(1) + ' 秒'
			const m = Math.floor(seconds / 60)
			const s = Math.round(seconds % 60)
			return '耗时 ' + m + ' 分 ' + s + ' 秒'
		}

		// 生成中计时：mm:ss（等宽数字不跳位）
		function fmtElapsed(totalSeconds) {
			const m = Math.floor(totalSeconds / 60)
			const s = totalSeconds % 60
			return (m < 10 ? '0' + m : String(m)) + ':' + (s < 10 ? '0' + s : String(s))
		}

		const IMG_ICON = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
			h('rect', { x: 2.2, y: 3.2, width: 11.6, height: 9.6, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
			h('circle', { cx: 5.8, cy: 6.4, r: 1.1, fill: 'currentColor' }),
			h('path', { d: 'M3.4 12 6.7 8.6 9.3 11.2 11.2 9.2 13.6 11.6', stroke: 'currentColor', strokeWidth: 1.3, fill: 'none' }),
		)

		const chevron = (open) => h('span', {
			'aria-hidden': true,
			style: {
				display: 'inline-block',
				marginLeft: 6,
				transform: open ? 'rotate(90deg)' : 'none',
				transition: 'transform 150ms ease',
				fontSize: 11,
				opacity: 0.7,
			},
		}, '›')

		// ── 原图放大（与官方 MessageImage/ImageLightbox 同款行为与样式）────────
		// body portal 全屏预览：Esc / 点击遮罩 / 关闭按钮退出，挂载时聚焦关闭钮，
		// 卸载时把焦点还给打开者。样式取官方 ImageLightbox.module.css 的变量配方。
		const CLOSE_ICON = h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
			h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
		)

		function Lightbox({ src, alt, onClose }) {
			const closeRef = React.useRef(null)
			const restoreRef = React.useRef(null)
			React.useEffect(() => {
				restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
				if (closeRef.current) closeRef.current.focus()
				const onKeyDown = (event) => { if (event.key === 'Escape') onClose() }
				window.addEventListener('keydown', onKeyDown)
				return () => {
					window.removeEventListener('keydown', onKeyDown)
					if (restoreRef.current) restoreRef.current.focus()
				}
			}, [onClose])
			return ReactDOM.createPortal(
				h('div', {
					role: 'dialog',
					'aria-modal': true,
					'aria-label': '原图预览',
					style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 40 },
				}, [
					h('div', {
						'aria-hidden': true,
						onMouseDown: onClose,
						style: {
							position: 'absolute', inset: 0,
							background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .65))',
							backdropFilter: 'var(--dsw-mask-blur, blur(6px))',
						},
					}),
					h('img', {
						src: src, alt: alt,
						style: {
							position: 'relative',
							maxWidth: 'min(100%, 1600px)',
							maxHeight: 'calc(100vh - 80px)',
							objectFit: 'contain',
							borderRadius: 12,
							background: 'var(--dsw-specific-input-major, #1b1c1e)',
							boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0, 0, 0, .5))',
						},
					}),
					h('button', {
						ref: closeRef,
						type: 'button',
						'aria-label': '关闭原图预览',
						onClick: onClose,
						style: {
							position: 'fixed', top: 20, right: 20, zIndex: 1,
							display: 'grid', placeItems: 'center',
							width: 36, height: 36,
							border: '1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(255, 255, 255, .14))',
							borderRadius: 999,
							background: 'var(--dsw-specific-input-major, #1b1c1e)',
							color: 'var(--dsw-alias-label-primary, #e8eaed)',
							cursor: 'pointer',
						},
					}, CLOSE_ICON),
				]),
				document.body,
			)
		}

		// ── 生图参数卡 ──────────────────────────────────────────────────────
		// 工具的原始参数（AI 填的那组，映射到 DS-01..DS-09）：取自工具调用 argsRaw
		const PARAM_ORDER = ['prompt_tags', 'prompt_nl', 'reference_name', 'width', 'height', 'characters', 'mode', 'negative_tags', 'redraw_image', 'redraw_region', 'redraw_strength']
		const PARAM_LABELS = {
			prompt_tags: '标签词',
			prompt_nl: '自然语言',
			reference_name: '角色参考',
			width: '宽度',
			height: '高度',
			characters: '人数',
			mode: '模式',
			negative_tags: '反向提示词',
			redraw_image: '重绘图像',
			redraw_region: '重绘区域',
			redraw_strength: '重绘强度',
		}
		// 已废弃参数（高质量模式）：模型不再填写、不再展示；老消息里的残留键也被过滤
		const HIDDEN_PARAMS = ['high_quality', 'preview_region_only']

		// 只拿到 AI 填的 argsRaw 时（生成中），补默认值（与 host buildParams 一致），
		// 让参数卡在生成中也显示完整参数（宽/高/人数/反向提示词）。
		const CLIENT_DEFAULTS = { width: 1920, height: 1080, characters: 1 }
		function fillDefaults(obj) {
			for (const key of PARAM_ORDER) {
				const has = obj[key] !== undefined && obj[key] !== null
				if (!has && key in CLIENT_DEFAULTS) obj[key] = CLIENT_DEFAULTS[key]
			}
			if (obj.negative_tags === undefined) obj.negative_tags = ''
			return obj
		}

		function extractParams(block) {
			// 优先 host 回传的完整参数（<params>...</params>，已含默认兜底）
			if (block && Array.isArray(block.content)) {
				for (const b of block.content) {
					if (b && b.type === 'text' && typeof b.text === 'string') {
						const m = /<params>([\s\S]*?)<\/params>/.exec(b.text)
						if (m) {
							try {
								const obj = JSON.parse(m[1])
								if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj
							} catch { /* 落到 argsRaw */ }
						}
					}
				}
			}
			// fallback：工具调用原始参数（AI 填的那组）→ 补默认值
			const raw = block && (typeof block.argsRaw === 'string'
				? block.argsRaw
				: (block.call && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : null))
			if (!raw) return null
			try {
				const obj = JSON.parse(raw)
				return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? fillDefaults(obj) : null
			} catch { return null }
		}

		function paramRows(params) {
			const keys = Object.keys(params).filter((k) => !HIDDEN_PARAMS.includes(k))
			const ordered = PARAM_ORDER.filter((k) => k in params).concat(keys.filter((k) => !PARAM_ORDER.includes(k)))
			return ordered.map((k) => {
				let val = params[k]
				if (typeof val === 'boolean') val = val ? '开启' : '关闭'
				if (val === null || val === undefined) val = ''
				const str = String(val)
				return { key: k, label: PARAM_LABELS[k] || k, value: str === '' ? '（无）' : (str.length > 46 ? str.slice(0, 44) + '…' : str) }
			})
		}

		const CARD_OUTER = { border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.18))', borderRadius: 10, background: 'var(--dsw-alias-bg-elevated, transparent)', overflow: 'hidden' }
		const CARD_HEADER = {
			display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
			cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #9aa0a6)', fontSize: 13, lineHeight: 1.4,
			userSelect: 'none', borderRadius: 8, boxSizing: 'border-box',
		}

		const GEAR_ICON = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
			h('circle', { cx: 8, cy: 8, r: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
			h('path', { d: 'M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5l1.6 1.6M10.9 10.9l1.6 1.6M12.5 3.5l-1.6 1.6M5.1 10.9l-1.6 1.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
		)

		function ParamsCard({ params, open, onToggle }) {
			const rows = paramRows(params)
			const header = h('div', {
				onClick: () => onToggle && onToggle(!open), role: 'button', 'aria-expanded': open,
				style: { ...CARD_HEADER, borderBottom: open ? '1px solid var(--dsw-alias-border, rgba(127,127,127,.12))' : 'none' },
				onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))' },
				onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
			}, [
				GEAR_ICON,
				h('span', { style: { flex: 'none', fontWeight: 600 } }, '生图参数'),
				chevron(open),
			])
			if (!open) return h('div', { style: CARD_OUTER }, header)
			return h('div', { style: CARD_OUTER }, [
				header,
				h('div', { style: { padding: '0 10px 10px', display: 'flex', flexDirection: 'column' } },
					rows.map((r) => h('div', {
						key: r.key,
						style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '3px 0', minWidth: 0 },
					}, [
						h('div', { style: { flex: 'none', width: 76, fontSize: 12, color: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.6))' } }, r.label),
						h('div', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-primary, #e8eaed)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 } }, r.value),
					]))),
			])
		}

		// ── 再次生成小窗（改生图次数 + 取消/开始）─────────────────────────
		const DIAG_BTN = {
			padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
			border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.22))',
			background: 'transparent', color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
		}
		const DIAG_BTN_PRIMARY = {
			...DIAG_BTN,
			border: 'none',
			background: 'var(--dsw-alias-interactive-bg, rgba(127,127,127,.2))',
			color: 'var(--dsw-alias-label-primary, #e8eaed)',
			fontWeight: 600,
		}

		function RegenDialog({ count, onCountChange, onCancel, onConfirm }) {
			const inputRef = React.useRef(null)
			React.useEffect(() => {
				const onKeyDown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
				window.addEventListener('keydown', onKeyDown)
				const t = window.setTimeout(() => {
					if (inputRef.current) {
						inputRef.current.focus()
						if (inputRef.current.select) inputRef.current.select()
					}
				}, 30)
				return () => { window.clearTimeout(t); window.removeEventListener('keydown', onKeyDown) }
			}, [onCancel])
			const nRaw = parseInt(count, 10)
			const n = Number.isFinite(nRaw) ? Math.min(8, Math.max(1, nRaw)) : 1
			return ReactDOM.createPortal(
				h('div', {
					role: 'dialog', 'aria-modal': true, 'aria-label': '再次生成',
					style: { position: 'fixed', inset: 0, zIndex: 1001, display: 'grid', placeItems: 'center', padding: 24 },
				}, [
					h('div', {
						'aria-hidden': true,
						onMouseDown: onCancel,
						style: {
							position: 'absolute', inset: 0,
							background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .65))',
							backdropFilter: 'var(--dsw-mask-blur, blur(6px))',
						},
					}),
					h('div', {
						style: {
							position: 'relative',
							width: 'min(100%, 340px)',
							borderRadius: 12,
							border: '1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(255, 255, 255, .14))',
							background: 'var(--dsw-specific-input-major, #1b1c1e)',
							boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0, 0, 0, .5))',
							padding: 14,
							boxSizing: 'border-box',
						},
					}, [
						h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, color: 'var(--dsw-alias-label-primary, #e8eaed)' } }, '再次生成'),
						h('label', { htmlFor: 'dsh-regen-count', style: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #9aa0a6)', marginBottom: 6 } }, '生图次数'),
						h('input', {
							id: 'dsh-regen-count',
							ref: inputRef,
							type: 'number', min: 1, max: 8, step: 1,
							value: count,
							onChange: (e) => onCountChange(e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirm() } },
							style: {
								width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 8,
								border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.25))',
								background: 'var(--dsw-alias-bg-muted, rgba(127,127,127,.08))',
								color: 'var(--dsw-alias-label-primary, #e8eaed)',
								fontSize: 14, outline: 'none',
							},
						}),
						h('div', { style: { marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.6))' } },
							'将按当前参数依次生成 ' + n + ' 张新图，作为新卡片加入下方（1-8）'),
						h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 } }, [
							h('button', { type: 'button', onClick: onCancel, style: DIAG_BTN }, '取消'),
							h('button', { type: 'button', onClick: onConfirm, style: DIAG_BTN_PRIMARY }, '开始生成'),
						]),
					]),
				]),
				document.body,
			)
		}

		// ── 单张生图卡片（原始卡 + 每次「再次生成」各一张）──────────────────
		const REGEN_BTN = {
			display: 'inline-flex', alignItems: 'center', gap: 4,
			background: 'transparent',
			border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.22))',
			borderRadius: 6,
			padding: '3px 10px',
			fontSize: 12,
			color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
			cursor: 'pointer',
		}

		function ImageCard(props) {
			const { variant, index, durationFromTool, regenBusy, canRegen, onRegenClick } = props
			const urls = variant && Array.isArray(variant.urls) ? variant.urls : []
			const state = variant && variant.state ? variant.state : 'done'
			const errorMsg = variant && variant.errorMsg ? variant.errorMsg : ''
			const [expanded, setExpanded] = React.useState(true) // 默认展开
			const [copies, setCopies] = React.useState({}) // url -> 'busy' | 'ok' | 'err'
			const [dims, setDims] = React.useState({}) // url -> 'WxH'（图片实际尺寸，onLoad 后填充）
			const [previewUrl, setPreviewUrl] = React.useState(null) // 原图放大：当前预览的 url
			const copyPending = React.useRef({}) // url -> true（复制进行中，防重复点击）
			const urlsKey = urls.join('\u0000')
			// 新一次生成结果到来后重置复制/尺寸状态
			React.useEffect(() => {
				setCopies({})
				setDims({})
			}, [urlsKey])

			const copyImage = (url) => {
				if (copyPending.current[url]) return
				copyPending.current[url] = true
				setCopies((s) => ({ ...s, [url]: 'busy' }))
				fetch(proxyUrl(url), { signal: AbortSignal.timeout(30000) })
					.then((r) => {
						if (!r.ok) throw new Error('HTTP ' + r.status)
						return r.blob()
					})
					.then((blob) => {
						const type = blob.type || 'image/png'
						const item = {}
						item[type] = blob
						return navigator.clipboard.write([new ClipboardItem(item)])
					})
					.then(() => setCopies((s) => ({ ...s, [url]: 'ok' })))
					.catch((e) => {
						console.warn('[imagegen] copy failed:', e && e.message ? e.message : e)
						setCopies((s) => ({ ...s, [url]: 'err' }))
					})
					.finally(() => { copyPending.current[url] = false })
			}

			const count = urls.length
			let title
			if (index === 0) title = '生图 · ' + (count > 0 ? count + ' 张' : '完成')
			else title = '生图 · 第 ' + (index + 1) + ' 次' + (count > 1 ? ' · ' + count + ' 张' : '')

			let right = null
			if (state !== 'done') {
				right = h('span', { style: { marginLeft: 'auto', flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 } }, [
					h('span', { className: 'dsh-img-spinner' }),
					h('span', { style: { fontSize: 12, opacity: 0.85 } }, state === 'generating' ? '生成中…' : '排队中…'),
				])
			} else {
				right = h('span', { style: { marginLeft: 'auto', flex: 'none', fontSize: 11, opacity: 0.6 } }, expanded ? '收起' : '点开复制图片')
			}

			const header = h('div', {
				onClick: () => setExpanded((v) => !v),
				role: 'button',
				'aria-expanded': expanded,
				style: {
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					width: '100%',
					padding: '6px 10px',
					cursor: 'pointer',
					color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
					fontSize: 13,
					lineHeight: 1.4,
					userSelect: 'none',
					borderRadius: 8,
					boxSizing: 'border-box',
					borderBottom: expanded && state === 'done' && count > 0 ? '1px solid var(--dsw-alias-border, rgba(127,127,127,.12))' : 'none',
				},
				onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))' },
				onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
			}, [
				IMG_ICON,
				h('span', { style: { flex: 'none', fontWeight: 600 } }, title),
				right,
				chevron(expanded),
			])

			const regenBtn = canRegen ? h('button', {
				type: 'button',
				disabled: regenBusy,
				onClick: onRegenClick,
				style: { ...REGEN_BTN, opacity: regenBusy ? 0.45 : 1 },
				onMouseEnter: (e) => { if (!regenBusy) e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))' },
				onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
			}, '再次生成') : null

			let body = null
			if (state === 'pending' || state === 'generating') {
				body = h('div', { style: { padding: '6px 10px 12px', fontSize: 12, color: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.6))' } },
					h('span', { className: 'dsh-img-pulse' }, state === 'generating' ? '正在生成图片，请稍候…' : '排队等待生成…'))
			} else if (state === 'error') {
				body = h('div', { style: { padding: '0 10px 8px' } }, [
					h('div', { style: { fontSize: 12, color: 'var(--dsw-static-red-500, #f28b82)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, errorMsg),
					regenBtn ? h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } }, regenBtn) : null,
				])
			} else if (count > 0 && expanded) {
				const durationSec = typeof variant.durationMs === 'number' ? variant.durationMs / 1000 : durationFromTool
				const rows = urls.map((url, i) => {
					const st = copies[url]
					const copyLabel = st === 'ok' ? '已复制' : st === 'err' ? '复制失败' : '复制图片'
					// 耗时：该次生图总用时，只在第一张图下行显示一次
					const durSpan = i === 0
						? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.6))' } }, formatDuration(durationSec))
						: null
					// 尺寸：图片实际像素（onLoad 读取 naturalWidth/naturalHeight），居中显示
					const dimText = dims[url]
					const dimSpan = dimText
						? h('span', {
							style: {
								fontSize: 12,
								fontWeight: 700,
								color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
								fontVariantNumeric: 'tabular-nums',
							},
						}, dimText)
						: null
					return h('div', {
						key: url + i,
						style: { display: 'block', minWidth: 0 },
					}, [
						h('img', {
							src: proxyUrl(url),
							loading: 'lazy',
							alt: '生图 ' + (i + 1),
							onClick: () => setPreviewUrl(url),
							onLoad: (e) => {
								const el = e.currentTarget
								if (el && el.naturalWidth > 0 && el.naturalHeight > 0) {
									const sz = el.naturalWidth + 'x' + el.naturalHeight
									setDims((s) => (s[url] === sz ? s : { ...s, [url]: sz }))
								}
							},
							style: {
								display: 'block',
								width: '100%',
								borderRadius: 8,
								cursor: 'zoom-in',
								background: 'var(--dsw-alias-bg-muted, rgba(127,127,127,.08))',
							},
						}),
						h('div', {
							style: {
								display: 'grid',
								gridTemplateColumns: '1fr auto 1fr',
								alignItems: 'center',
								gap: 8,
								marginTop: 10,
								marginBottom: 10,
							},
						}, [
							h('div', {
								style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
							}, [
								h(Tooltip, { label: copyLabel, side: 'bottom' },
									h('button', {
										type: 'button',
										className: 'dsh-img-action',
										'aria-label': copyLabel,
										onClick: () => copyImage(url),
									}, st === 'ok' ? h(IconCheckOutline16) : h(IconCopyOutline16))),
								durSpan,
							]),
							dimSpan,
							h('div', { style: { justifySelf: 'end' } }, i === 0 ? regenBtn : null),
						]),
					])
				})
				body = h('div', { style: { padding: '8px 10px 0' } }, rows)
			}

			return h('div', { style: CARD_OUTER }, [
				header,
				body,
				previewUrl !== null
					? h(Lightbox, { src: proxyUrl(previewUrl), alt: '生图预览', onClose: () => setPreviewUrl(null) })
					: null,
			])
		}

		// ── 区域框定交互卡：用户在预览图上直接拖动红框微调（根治"模型估坐标不准"）──
		// 归一化 bbox 解析：矩形 [x1,y1,x2,y2] 或 多边形 [[..],..]（取外接矩形）；失败 → null
		function parseRegionBbox(spec) {
			if (typeof spec !== 'string') return null
			const s = spec.trim()
			const m = s.match(/^\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]$/)
			if (m) {
				let [x1, y1, x2, y2] = m.slice(1).map(Number)
				if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) return null
				if (x1 > x2) { const t = x1; x1 = x2; x2 = t }
				if (y1 > y2) { const t = y1; y1 = y2; y2 = t }
				return { x1, y1, x2, y2 }
			}
			const pairs = s.match(/\[\[([0-9.]+)\s*,\s*([0-9.]+)\](?:\s*,\s*\[[0-9.]+\s*,\s*[0-9.]+\])*\]/)
			if (pairs) {
				const pts = s.match(/\[([0-9.]+)\s*,\s*([0-9.]+)\]/g)
				if (pts && pts.length >= 3) {
					let x1 = 1, y1 = 1, x2 = 0, y2 = 0
					for (const p of pts) {
						const mm = p.match(/\[([0-9.]+)\s*,\s*([0-9.]+)\]/)
						const x = Number(mm[1]), y = Number(mm[2])
						if (!Number.isFinite(x) || !Number.isFinite(y)) return null
						if (x < x1) x1 = x; if (x > x2) x2 = x
						if (y < y1) y1 = y; if (y > y2) y2 = y
					}
					return { x1, y1, x2, y2 }
				}
			}
			return null
		}

		const clamp01 = (v) => Math.min(1, Math.max(0, v))

		// props: { previewUrl, initialBox:{x1,y1,x2,y2}, callId }
		// 交互：拖动 8 个手柄改边 / 框内拖动整体移动；「确认框」POST 到 host（按 callId+源图指纹记录）。
		function RegionBoxCard(props) {
			const { previewUrl, initialBox, callId } = props
			const [box, setBox] = React.useState(initialBox)
			const [status, setStatus] = React.useState('idle') // idle|saving|saved|error
			const [errMsg, setErrMsg] = React.useState('')
			const wrapRef = React.useRef(null)
			const dragRef = React.useRef(null)

			const nf = (v) => (Math.round(v * 10000) / 10000) // 归一化坐标保留 4 位

			const toNorm = (e) => {
				const el = wrapRef.current
				if (!el) return { x: 0, y: 0 }
				const r = el.getBoundingClientRect()
				return {
					x: clamp01((e.clientX - r.left) / Math.max(1, r.width)),
					y: clamp01((e.clientY - r.top) / Math.max(1, r.height)),
				}
			}

			const onMove = (e) => {
				const d = dragRef.current
				if (!d) return
				const pos = toNorm(e)
				const dx = pos.x - d.px
				const dy = pos.y - d.py
				const MIN = 0.02
				const b0 = d.box0
				let b
				switch (d.mode) {
					case 'move': {
						const w = b0.x2 - b0.x1
						const hgt = b0.y2 - b0.y1
						const nx1 = Math.min(1 - w, Math.max(0, b0.x1 + dx))
						const ny1 = Math.min(1 - hgt, Math.max(0, b0.y1 + dy))
						b = { x1: nx1, y1: ny1, x2: nx1 + w, y2: ny1 + hgt }
						break
					}
					case 'nw': b = { x1: clamp01(b0.x1 + dx), y1: clamp01(b0.y1 + dy), x2: Math.min(1, Math.max(b0.x2 - MIN, b0.x2)), y2: Math.min(1, Math.max(b0.y2 - MIN, b0.y2)) }; b.x2 = Math.max(b.x2, b.x1 + MIN); b.y2 = Math.max(b.y2, b.y1 + MIN); break
					case 'n': b = { x1: b0.x1, y1: clamp01(b0.y1 + dy), x2: b0.x2, y2: b0.y2 }; b.y1 = Math.min(b.y1, b.y2 - MIN); break
					case 'ne': b = { x1: b0.x1, y1: clamp01(b0.y1 + dy), x2: clamp01(b0.x2 + dx), y2: b0.y2 }; b.y1 = Math.min(b.y1, b.y2 - MIN); b.x2 = Math.max(b.x2, b.x1 + MIN); break
					case 'e': b = { x1: b0.x1, y1: b0.y1, x2: clamp01(b0.x2 + dx), y2: b0.y2 }; b.x2 = Math.max(b.x2, b.x1 + MIN); break
					case 'se': b = { x1: b0.x1, y1: b0.y1, x2: clamp01(b0.x2 + dx), y2: clamp01(b0.y2 + dy) }; b.x2 = Math.max(b.x2, b.x1 + MIN); b.y2 = Math.max(b.y2, b.y1 + MIN); break
					case 's': b = { x1: b0.x1, y1: b0.y1, x2: b0.x2, y2: clamp01(b0.y2 + dy) }; b.y2 = Math.max(b.y2, b.y1 + MIN); break
					case 'sw': b = { x1: clamp01(b0.x1 + dx), y1: b0.y1, x2: b0.x2, y2: clamp01(b0.y2 + dy) }; b.x1 = Math.min(b.x1, b.x2 - MIN); b.y2 = Math.max(b.y2, b.y1 + MIN); break
					case 'w': b = { x1: clamp01(b0.x1 + dx), y1: b0.y1, x2: b0.x2, y2: b0.y2 }; b.x1 = Math.min(b.x1, b.x2 - MIN); break
					default: return
				}
				setBox({ x1: nf(b.x1), y1: nf(b.y1), x2: nf(b.x2), y2: nf(b.y2) })
			}
			const onUp = () => {
				dragRef.current = null
				window.removeEventListener('pointermove', onMove)
				window.removeEventListener('pointerup', onUp)
			}
			const startDrag = (e, mode) => {
				e.preventDefault()
				e.stopPropagation()
				const pos = toNorm(e)
				dragRef.current = { mode, px: pos.x, py: pos.y, box0: { ...box } }
				window.addEventListener('pointermove', onMove)
				window.addEventListener('pointerup', onUp)
			}

			const confirm = async () => {
				setStatus('saving')
				setErrMsg('')
				try {
					const r = await fetch('/imagegen-proxy/region', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ callId, region: [box.x1, box.y1, box.x2, box.y2] }),
						signal: AbortSignal.timeout(8000),
					})
					const j = await r.json().catch(() => null)
					if (j && j.ok === true) {
						setStatus('saved')
					} else {
						setStatus('error')
						setErrMsg((j && typeof j.error === 'string' && j.error) ? j.error : ('确认失败（HTTP ' + r.status + '）'))
					}
				} catch (e) {
					setStatus('error')
					setErrMsg(e && e.message ? e.message : '网络错误')
				}
			}

			const pct = (v) => (v * 100).toFixed(2) + '%'
			const HANDLES = [
				['nw', '0%', '0%', 'nwse-resize'], ['n', '50%', '0%', 'ns-resize'],
				['ne', '100%', '0%', 'nesw-resize'], ['e', '100%', '50%', 'ew-resize'],
				['se', '100%', '100%', 'nwse-resize'], ['s', '50%', '100%', 'ns-resize'],
				['sw', '0%', '100%', 'nesw-resize'], ['w', '0%', '50%', 'ew-resize'],
			]
			const statusText = status === 'saving'
				? '记录中…'
				: status === 'saved'
					? '✓ 已记录用户框：模型正式生图时按此框执行（模型会被告知）'
					: status === 'error'
						? (errMsg || '确认失败')
						: '拖动红框四角/边框可微调，调好后点「确认框」'
			const coordLine = '坐标 x ' + box.x1.toFixed(2) + '~' + box.x2.toFixed(2) + '，y ' + box.y1.toFixed(2) + '~' + box.y2.toFixed(2)

			return h('div', { style: { flex: 'none', width: 280, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } }, [
				previewUrl
					? h('div', {
						ref: wrapRef,
						style: {
							position: 'relative', width: '100%', borderRadius: 6, overflow: 'hidden',
							border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.18))',
							background: '#111', userSelect: 'none', touchAction: 'none', cursor: 'default',
						},
					}, [
						h('img', {
							src: previewUrl,
							alt: '重绘区域框定',
							draggable: false,
							style: { display: 'block', width: '100%', pointerEvents: 'none' },
						}),
						// 框移动层（框内按下=整体拖动；8 个手柄相对【框】定位，不贴图边）
						h('div', {
							style: {
								position: 'absolute', left: pct(box.x1), top: pct(box.y1),
								width: pct(box.x2 - box.x1), height: pct(box.y2 - box.y1),
								cursor: 'move',
							},
							onPointerDown: (e) => startDrag(e, 'move'),
						}, [
							h('svg', {
								style: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' },
								viewBox: '0 0 100 100', preserveAspectRatio: 'none',
							}, [
								h('rect', {
									x: 0, y: 0, width: 100, height: 100,
									fill: 'rgba(255,59,48,0.16)', stroke: '#ff3b30', strokeWidth: 2.5,
									vectorEffect: 'non-scaling-stroke',
								}),
							]),
							// 8 个手柄（拖动改边；相对框角/边中点定位）
							...HANDLES.map(([mode, l, t, cur]) => h('div', {
								key: mode,
								style: {
									position: 'absolute', left: l, top: t, width: 10, height: 10,
									marginLeft: -5, marginTop: -5, borderRadius: 3,
									background: '#fff', border: '2px solid #ff3b30', boxSizing: 'border-box',
									cursor: cur, touchAction: 'none', zIndex: 2,
								},
								onPointerDown: (e) => startDrag(e, mode),
							})),
						]),
					])
					: h('div', { style: { width: '100%', height: 92, borderRadius: 6, border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.18))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.6))', fontSize: 12 } }, '区域框定…'),
				h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
					h('button', {
						type: 'button',
						onClick: confirm,
						disabled: status === 'saving' || !previewUrl,
						style: {
							padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
							border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.18))',
							background: status === 'saved' ? 'rgba(52,168,83,.16)' : 'var(--dsw-alias-interactive-bg, rgba(127,127,127,.1))',
							color: 'var(--dsw-alias-label, #e8eaed)',
						},
					}, status === 'saved' ? '✓ 已确认' : '确认框'),
					h('button', {
						type: 'button',
						onClick: () => { setBox(initialBox); setStatus('idle'); setErrMsg('') },
						disabled: status === 'saving',
						style: {
							padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
							border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.18))',
							background: 'transparent', color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
						},
					}, '重置'),
				]),
				h('div', {
					style: {
						fontSize: 11, lineHeight: 1.5, color: status === 'error'
							? 'var(--dsw-static-red-500, #f28b82)'
							: status === 'saved'
								? 'var(--dsw-static-green-500, #81c995)'
								: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.6))',
						whiteSpace: 'normal', wordBreak: 'break-word',
					},
				}, statusText),
				h('div', {
					style: { fontSize: 11, color: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.5))', fontVariantNumeric: 'tabular-nums' },
				}, coordLine),
			])
		}

		function ImagegenToolView(props) {
			const block = props && props.block
			// 图片 URL：主源 = host 按 callId 存的本次生成结果（工具结果文本零 URL/路径，
			// 模型无法把图片引用复读进回复 → 消息里只有生图卡片一张图）；
			// 初始值 = 老格式兼容（<params> imageUrls / markdown 图片行）。
			const settled = !!(block && block.kind === 'tool-result')
			const isError = settled && block.isError === true
			// owner props 与结果节点都有 callId（running 卡片也能拿到，用于区分 生成中/排队中）
			const callId = (props && typeof props.callId === 'string' && props.callId)
				|| (block && typeof block.callId === 'string' ? block.callId : null)
			const durationFromTool = extractDuration(block)
			const params = extractParams(block)
			// 两阶段流程第①步：preview_region_only=true 的调用 = 「区域框定」卡（只画框，未生图）
			const isPreview = settled && !isError && !!(params && params.preview_region_only === true)

			// 首次生成中计时（未归档时挂表，从工具调用事件时间起算）
			const [elapsed, setElapsed] = React.useState(0)
			const startAtRef = React.useRef(0)
			React.useEffect(() => {
				startAtRef.current = block && typeof block.time === 'number' ? block.time : Date.now()
				setElapsed(0)
				if (settled) return
				const tick = () => setElapsed(Math.round((Date.now() - startAtRef.current) / 1000))
				tick()
				const timer = window.setInterval(tick, 500)
				return () => window.clearInterval(timer)
			}, [settled, block])

			// 队列状态：轮询 host 当前正在执行的生图调用（/imagegen-proxy/status）。
			// 内核把工具调用串行化后，LLM 连发多张时后排卡片是「排队中」而非「生成中」，
			// 这样能一眼看出模型请求了几张、当前跑到第几张。
			const [waiting, setWaiting] = React.useState(false)
			React.useEffect(() => {
				if (settled || !callId) return
				let alive = true
				const poll = () => {
					fetch('/imagegen-proxy/status', { signal: AbortSignal.timeout(4000) })
						.then((r) => (r.ok ? r.json() : null))
						.then((j) => {
							if (!alive || !j) return
							setWaiting(!!(typeof j.runningCallId === 'string' && j.runningCallId !== '' && j.runningCallId !== callId))
						})
						.catch(() => { /* 保底按生成中显示 */ })
				}
				poll()
				const t = window.setInterval(poll, 800)
				return () => { alive = false; window.clearInterval(t) }
			}, [settled, callId])

			// 生图参数卡：默认折叠（点开可看本次参数）。生成中与生成后都收着——
			// LLM 连发多张时不会满屏展开的参数卡，只看得到图
			const [paramsOpen, setParamsOpen] = React.useState(false)

			// 变体列表：variants[0] = 原始生图；其余为「再次生成」的新卡片
			const [variants, setVariants] = React.useState(() => {
				const urls = extractImageUrls(block)
				return urls.length > 0
					? [{ urls, durationMs: null, state: 'done', errorMsg: '' }]
					: []
			})
			const variantsRef = React.useRef(variants)
			const mutate = (fn) => { const nv = fn(variantsRef.current); variantsRef.current = nv; setVariants(nv) }

			// 生图图片通道：host 按 callId 存本次生成的图片 URL（/imagegen-proxy/img），
			// 返回原图 + 所有「再次生成」变体 + 区域示意预览（局部重绘）；失败保留初始兼容值（老格式兜底）。
			const [regionPreview, setRegionPreview] = React.useState(null)
			React.useEffect(() => {
				if (!callId || !settled) return
				let alive = true
				let tries = 0
				const attempt = () => {
					if (!alive) return
					fetch('/imagegen-proxy/img?callId=' + encodeURIComponent(callId), { signal: AbortSignal.timeout(10000) })
						.then((r) => (r.ok ? r.json() : null))
						.then((j) => {
							if (!alive) return
							if (!j) throw new Error('bad response')
							const raw = (Array.isArray(j.variants) && j.variants.length > 0)
								? j.variants
								: (Array.isArray(j.imageUrls) && j.imageUrls.length > 0 ? [{ urls: j.imageUrls, durationMs: null }] : [])
							const vs = raw
								.map((v) => ({
									urls: Array.isArray(v.urls) ? v.urls : [],
									durationMs: typeof v.durationMs === 'number' ? v.durationMs : null,
									state: 'done',
									errorMsg: '',
								}))
								.filter((v) => v.urls.length > 0)
							if (vs.length > 0) mutate(() => vs)
							setRegionPreview(typeof j.previewUrl === 'string' && j.previewUrl !== '' ? j.previewUrl : null)
						})
						.catch(() => {
							// host 忙/瞬断：退避重试最多 4 次，失败保持占位
							if (alive && tries < 4) {
								tries += 1
								setTimeout(attempt, 1200 * tries)
							}
						})
				}
				attempt()
				return () => { alive = false }
			}, [callId, settled])

			// 再次生成：弹窗 → 追加 N 个占位卡片 → 串行队列逐个生成（不走 LLM）
			const [regenOpen, setRegenOpen] = React.useState(false)
			const [regenCount, setRegenCount] = React.useState('1')
			const [regenBusy, setRegenBusy] = React.useState(false)

			const runRegeneration = async () => {
				const nRaw = parseInt(regenCount, 10)
				const n = Number.isFinite(nRaw) ? Math.min(8, Math.max(1, nRaw)) : 1
				setRegenOpen(false)
				if (!params || !callId || regenBusy) return
				const slots = []
				for (let i = 0; i < n; i++) slots.push({ urls: [], durationMs: null, state: 'pending', errorMsg: '' })
				mutate((vs) => vs.concat(slots))
				setRegenBusy(true)
				try {
					const payload = JSON.stringify({ params, callId })
					while (true) {
						const idx = variantsRef.current.findIndex((v) => v.state === 'pending')
						if (idx < 0) break
						mutate((vs) => vs.map((v, i) => (i === idx ? { ...v, state: 'generating', errorMsg: '' } : v)))
						let ok = null
						let errMsg = ''
						try {
							const r = await fetch('/imagegen-proxy/regenerate', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: payload,
								signal: AbortSignal.timeout(480000),
							})
							const j = await r.json().catch(() => null)
							if (j && j.ok === true && Array.isArray(j.imageUrls) && j.imageUrls.length > 0) {
								ok = { urls: j.imageUrls, durationMs: j.durationMs ?? null }
							} else {
								errMsg = (j && typeof j.error === 'string' && j.error) ? j.error : ('生成失败（HTTP ' + r.status + '）')
							}
						} catch (e) {
							errMsg = e && e.message ? e.message : '网络错误'
						}
						mutate((vs) => vs.map((v, i) => (i === idx
							? (ok ? { ...v, state: 'done', urls: ok.urls, durationMs: ok.durationMs } : { ...v, state: 'error', errorMsg: errMsg })
							: v)))
					}
				} finally {
					setRegenBusy(false)
				}
			}

			// ── 渲染 ──
			const canRegen = !!(params && callId)

			let content
			if (!settled) {
				// 首次生成（工具执行中）：排队等待内核调度时显示「排队中…」，否则「生成中…」+ 计时
				const header = h('div', {
					style: {
						display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
						cursor: 'default', color: 'var(--dsw-alias-label-secondary, #9aa0a6)', fontSize: 13, lineHeight: 1.4,
						userSelect: 'none', borderRadius: 8, boxSizing: 'border-box',
					},
				}, [
					IMG_ICON,
					h('span', { style: { flex: 'none', fontWeight: 600 } }, waiting ? '生图 · 排队中…' : '生图 · 生成中…'),
					h('span', { style: { marginLeft: 'auto', flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 } }, [
						h('span', { className: 'dsh-img-spinner' }),
						// 排队中不显示计时（计时含等待时间，会让人误以为越排越慢）；开跑后才是真实生图计时
						waiting ? null : h('span', { style: { fontSize: 12, opacity: 0.85, fontVariantNumeric: 'tabular-nums' } }, fmtElapsed(elapsed)),
					]),
				])
				content = h('div', { style: CARD_OUTER }, [
					header,
					h('div', { style: { padding: '6px 10px 12px', fontSize: 12, color: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.6))' } },
						h('span', { className: 'dsh-img-pulse' }, waiting ? '等待前一张生成完成…' : '正在生成图片，请稍候…')),
				])
			} else if (isError) {
				const header = h('div', {
					style: {
						display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
						cursor: 'default', color: 'var(--dsw-alias-label-secondary, #9aa0a6)', fontSize: 13, lineHeight: 1.4,
						userSelect: 'none', borderRadius: 8, boxSizing: 'border-box',
					},
				}, [
					IMG_ICON,
					h('span', { style: { flex: 'none', fontWeight: 600 } }, '生图 · 失败'),
				])
				content = h('div', { style: CARD_OUTER }, [
					header,
					h('div', {
						style: { padding: '0 10px 8px', fontSize: 12, color: 'var(--dsw-static-red-500, #f28b82)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
					}, resultText(block)),
				])
			} else if (isPreview) {
				// 两阶段第①步「区域框定」：用户可在图上亲手拖动红框微调（±host 记录）+ 说明
				const initialBox = parseRegionBbox(params && params.redraw_region) || { x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 }
				content = h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } }, [
					h(RegionBoxCard, { previewUrl: regionPreview, initialBox, callId }),
					h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #9aa0a6)', lineHeight: 1.6, minWidth: 0, paddingTop: 2 } }, [
						h('div', { style: { fontWeight: 600 } }, '红色框 = 本次要重绘的区域（画在源图上，尚未生图）'),
						h('div', { style: { color: 'var(--dsw-alias-label-dimmed, rgba(154,160,166,.6))' } }, '①您可以亲手拖动红框微调位置，调好后点「确认框」——模型会按您确认的框生图，比自己估坐标准得多；②也可以直接回复模型「框歪了/移位」，让它调整区域重新画框；③只换区域重画、不重新生成整张图。'),
					]),
				])
			} else {
				// 生图结果（局部重绘不再有后置区域条——区域在生图前已由「区域框定」卡确认过）
				content = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
					...(variants.length > 0
						? variants.map((v, i) => h(ImageCard, {
							key: i,
							variant: v,
							index: i,
							durationFromTool,
							regenBusy,
							canRegen,
							onRegenClick: () => setRegenOpen(true),
						}))
						: [h('div', { style: CARD_OUTER }, [
							h('div', { style: CARD_HEADER }, [IMG_ICON, h('span', { style: { flex: 'none', fontWeight: 600 } }, '生图 · 无图片')]),
						])]),
				])
			}

			const ui = params
				? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [h(ParamsCard, { params, open: paramsOpen, onToggle: setParamsOpen }), content])
				: content

			return [
				ui,
				regenOpen ? h(RegenDialog, {
					count: regenCount,
					onCountChange: setRegenCount,
					onCancel: () => setRegenOpen(false),
					onConfirm: runRegeneration,
				}) : null,
			]
		}

		exports.inject = inject
		exports.apply = function apply(ctx) {
			// 注入一次动画样式（幂等）
			try {
				if (typeof document !== 'undefined' && document.head && !document.getElementById('dsh-imggen-css')) {
					const el = document.createElement('style')
					el.id = 'dsh-imggen-css'
					el.textContent = CSS
					document.head.appendChild(el)
				}
			} catch (e) { /* 样式注入失败不影响功能 */ }
			const slots = ctx.slots
			if (slots === undefined) return
			ctx.effect(() => slots.inject('tool.call.toolview', () => slots.register({ name: 'tool.call.toolview', key: 'generate_image', locale: 'conversation' }, ImagegenToolView)), 'imagegen: tool view')
		}
		return module.exports;
	}
});
