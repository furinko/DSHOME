// dshome-theme 会话缩略导航 · 自测（v16-anchored）
//
// 这一版要守的三件事（主人逐轮校正后的结论）：
//  ① **不读全量布局**：块高按文本长度估算，只抽 ~40 个块读真实位置当「锚」——
//     读几十次不卡；读几百次才卡死首屏。
//  ② **缩略图上的位置 = 会话里的真实位置**：锚之间按真实比例插值、锚之外从最近锚累加。
//     主人报的「拨到蓝条，屏幕却不是那条消息」「加载更早之后点击就对不上」都是它。
//  ③ **框与缩略图严丝合缝**：框框住的就是「你正在看的那段」（VSCode MinimapLayout 的算法）。
//
// 验证四则：
//  真加载（vm 里跑真源码，不是读文本断言）/ 反例证伪（同一判据在坏数据上必须红）/
//  不污染被测对象（产品代码里没有任何 test-only 出口）/ 无输入即响亮失败（反例节）。
// 跑法：node packages/dshome-theme/selftest.mjs（全绿 = exit 0）
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra === "" ? "" : "  <- " + extra}`);
  if (!ok) failures += 1;
};
const closeTo = (a, b, eps = 1) => Math.abs(a - b) <= eps;
const num = (cssText) => Number(String(cssText).replace(/[^\d.-]/g, ""));

/* ---------------- 假 DOM ---------------- */
class El {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.attrs = Object.create(null);
    this.children = [];
    this.listeners = Object.create(null);
    this.className = "";
    this.rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    this.paint = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get clientWidth() { return this._cw !== undefined ? this._cw : (this.style.width ? parseFloat(this.style.width) : 0); }
  set clientWidth(v) { this._cw = v; }
  get clientHeight() { return this._ch !== undefined ? this._ch : (this.style.height ? parseFloat(this.style.height) : 0); }
  set clientHeight(v) { this._ch = v; }
  append(...nodes) { for (const n of nodes) { n._parent = this; this.children.push(n); } }
  appendChild(node) { node._parent = this; this.children.push(node); return node; }
  remove() {
    const parent = this._parent;
    if (parent === undefined || parent === null) return;
    const at = parent.children.indexOf(this);
    if (at >= 0) parent.children.splice(at, 1);
    this._parent = undefined;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  dispatch(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() {
    const self = this;
    return {
      _fill: null,
      set fillStyle(v) { this._fill = v; },
      get fillStyle() { return this._fill; },
      setTransform() {},
      clearRect() {},
      fillRect(x, y, w, h) { self.paint.push({ fill: this._fill, x, y, w, h }); },
    };
  }
  querySelector(sel) { return sel.includes("data-chat-turn") ? (this.blocks?.[0] ?? null) : null; }
  querySelectorAll(sel) {
    if (sel.includes("data-chat-turn")) return this.blocks ?? [];
    if (sel.includes("_scrollBody")) return this.doc?._scrollers ?? [];
    return [];
  }
  getBoundingClientRect() {
    if (this.style.top !== undefined) {
      return { top: parseFloat(this.style.top), height: parseFloat(this.style.height), width: parseFloat(this.style.width), left: 0, right: 0, bottom: 0 };
    }
    return this.rect;
  }
}

const COLORS = {
  "--dsw-alias-brand-primary": "#444444",
  "--dsw-alias-label-secondary": "#111111",
  "--dsw-alias-label-tertiary": "#222222",
  "--dsw-alias-border-l4": "#333333",
  "--dsw-alias-border-l1": "#555555",
};

const VIEW = 500;
const BAND = 732;                 // 900 − 152（composer）− 16（留白）
const HEIGHTS = [100, 800, 60];   // 三块的**真实**高度（首屏不读，只用于事后核对）
const TOTAL = 960;

/* 假时钟：让 hover 提示的 60ms 节流可测（不冻结的话连续两次 hover 第二次会被吞） */
let clock = 1_000_000;
class FakeDate extends Date { static now() { return clock; } }

const scroller = new El("div");
scroller.clientHeight = VIEW;
scroller.clientWidth = 800;
scroller.scrollHeight = TOTAL;
scroller.rect = { top: 0, height: VIEW, width: 800, left: 0, right: 800, bottom: VIEW };

let rectReads = 0; // 只统计**块**的 rect 读取（「读几十次而不是几百次」是这一版的核心承诺）
const block = (turn, kind, height, text, realTop = 0) => {
  const el = new El("div");
  el.attrs["data-chat-turn"] = String(turn);
  if (kind !== "") el.attrs["data-chat-flow-kind"] = kind;
  el.textContent = text;
  // topShift 可改：模拟「更早的一轮进来」时同一个 DOM 元素整体下移（元素不换、缓存不丢，跟真实一致）
  el.topShift = 0;
  el.getBoundingClientRect = () => {
    rectReads += 1;
    return { top: realTop + el.topShift - scroller.scrollTop, height, width: 800, left: 0, right: 800, bottom: 0 };
  };
  return el;
};

scroller.blocks = [
  block(1, "user", HEIGHTS[0], "x".repeat(100), 0),
  block(1, "assistant", HEIGHTS[1], "y".repeat(400), HEIGHTS[0]),
  block(2, "user", HEIGHTS[2], "", HEIGHTS[0] + HEIGHTS[1]),
];
scroller.querySelector = (sel) => (sel.includes("data-chat-turn") ? scroller.blocks[0] : null);
scroller.querySelectorAll = (sel) => (sel.includes("data-chat-turn") ? scroller.blocks : []);

const rail = new El("nav");
rail.rect = { top: 100, height: 400, width: 28, left: 1172, right: 1200, bottom: 500 };

// 假「官方右侧边栏」面板（覆盖层）：真源码核实 —— **同一个元素**同时带 data-sidebar-right-panel
// （常驻，"push" / "fullscreen"）与 data-sidebar-right-open（只有展开时才有，React `expanded || undefined`）。
// 这里照同一套属性建模：用例改属性 = 改官方状态；默认「没有展开态、也不是全屏」⇒ 与既有用例环境逐字一致。
const sidebarEl = new El("div");
sidebarEl.attrs["data-sidebar-right-panel"] = "push";
sidebarEl.rect = { top: 0, left: 1280, right: 1440, bottom: 900, width: 160, height: 900 };

const body = new El("body");
body.children = [];
const head = new El("head");
head.appendChild = (t) => { t._parent = head; head.children.push(t); return t; };

const docListeners = Object.create(null);
const document_ = {
  head, body,
  _scrollers: [scroller],
  _rail: rail,
  createElement: (tag) => new El(tag),
  // 语义属性选择器（与官方真 DOM 一致：属性在不在 = 状态在不在）
  querySelector: (sel) => {
    if (sel.includes("data-sidebar-right-open")) return "data-sidebar-right-open" in sidebarEl.attrs ? sidebarEl : null;
    if (sel.includes("data-sidebar-right-panel")) return sidebarEl.attrs["data-sidebar-right-panel"] === "fullscreen" ? sidebarEl : null;
    if (sel.includes("_frame")) return document_._rail;
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel.includes("_scrollBody")) return document_._scrollers;
    if (sel.includes("data-sidebar-right-open")) return "data-sidebar-right-open" in sidebarEl.attrs ? [sidebarEl] : [];
    return [];
  },
  addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
  removeEventListener() {},
};

const timers = [];
const intervals = [];
const rafs = [];
const resizeObservers = [];
const mutationObservers = [];

class FakeMutationObserver {
  constructor(cb) { this.cb = cb; this.records = []; mutationObservers.push(this); }
  observe(target, options) { this.records.push({ target, options }); }
  disconnect() {}
}
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; this.targets = []; resizeObservers.push(this); }
  observe(t) { this.targets.push(t); }
  disconnect() { this.targets = []; }
}

const win = {
  __ModuleLoader__: { load: (def) => { win.__def = def; } },
  // 一套比例尺，没有模式开关（缩略条/视窗/滑块共用同一刻度，见 client.js 的 MINIMAP_THUMB_RATIO）
  devicePixelRatio: 2,
  innerWidth: 1280,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearTimeout(id) { if (id > 0) timers[id - 1] = null; },
  setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  clearInterval() {},
  requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
  cancelAnimationFrame() {},
};

const sandbox = {
  window: win, document: document_,
  MutationObserver: FakeMutationObserver, ResizeObserver: FakeResizeObserver,
  console, Date: FakeDate,
  getComputedStyle: () => ({ getPropertyValue: (name) => COLORS[name] ?? "" }),
  WeakMap, Math, JSON, Object, Array, String, Number, Boolean, Promise, Error, TypeError, Symbol, Reflect, Proxy,
  parseFloat, isNaN,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "dshome-theme/lib/client.js" });

const flushTimers = () => { const list = timers.splice(0, timers.length); for (const t of list) if (t != null) t.fn(); };
const flushRaf = () => { const list = rafs.splice(0, rafs.length); for (const fn of list) fn(); };
const fireScroll = (top) => { if (top !== undefined) scroller.scrollTop = top; (docListeners.scroll ?? [])[0]?.({ target: scroller }); };
const syncNow = () => intervals.at(-1).fn();
/** 内容变了 ⇒ 让插件重画（真实环境里是 MutationObserver 触发的） */
const redraw = () => { mutationObservers[0].cb(); flushTimers(); flushRaf(); };   // [0] = 会话内容观察器（[1] 是「露头就上」那个）
const contentHeight = () => parseFloat(canvas.style.height);
const thumbTop = () => num(thumb.style.transform);
const screenY = (y) => y + num(canvas.style.transform); // translateY(-offset) ⇒ 屏幕位置 = 画布内 y − offset
const pointer = (y) => ({ button: 0, pointerId: 1, clientY: y, buttons: 1, preventDefault() {}, stopPropagation() {} });

/* ---------------- 真加载 ---------------- */
check("client.js 真加载并注册模块", typeof win.__def?.factory === "function");
const fakeRequire = (name) => (name === "react/jsx-runtime" ? { jsx: () => ({}), jsxs: () => ({}) } : new Proxy({}, { get: () => () => ({}) }));
const mod = win.__def.factory(fakeRequire);
let applyThrew = null;
try { mod.apply({ get: () => undefined }); } catch (error) { applyThrew = error; }
check("apply 不向外抛", applyThrew === null, applyThrew === null ? "" : String(applyThrew));

/* ---------------- CSS / 外壳 / 定位 ---------------- */
const css = head.children.at(-1)?.textContent ?? "";
check("原有覆盖仍在（回归）：宽度手柄藏起来", css.includes("[data-width-handle]{display:none}"));
check("⏸️ content-visibility 已暂时停用（等主人测准确度；恢复时这条判据一并改回）",
  !css.includes("content-visibility:auto"));
check("官方导轨被藏起来（opacity+pointer-events）", css.includes('nav[class*="_frame"]{opacity:0;pointer-events:none}'));
for (const [label, needle] of [
  ["外壳 fixed 定位", ".dshome-minimap{position:fixed"],
  ["内容视窗（裁剪+合成隔离）", ".dshome-minimap-view{position:absolute;inset:0;overflow:hidden"],
  ["视口框样式", ".dshome-minimap-thumb{"],
  ["hover 提示样式", ".dshome-minimap-tip{"],
]) check("CSS 含 " + label, css.includes(needle));
check("悬停提示不会被压成竖排（显式宽度策略 + 不用 line-clamp）",
  css.includes("width:max-content") && css.includes("max-width:360px") && !css.includes("-webkit-line-clamp"));
check("CSS 含视觉抓取环（长会话框细也不难抓，且不改几何）",
  css.includes(".dshome-minimap-thumb::after") && css.includes("height:18px"));

const box = body.children.at(-1);
const view = box.children[0];
const canvas = view.children[0];
const thumb = box.children[1];
const tip = box.children[2];
const BOX_W = 58;
check("视窗高度按缩略条长度**截断**、不超过标准条高",
  parseFloat(box.style.height) > 0 && parseFloat(box.style.height) <= BAND && box.style.width === `${BOX_W}px`,
  `${box.style.top}/${box.style.height}/${box.style.width}（标准条高 ${BAND}）`);
check("ResizeObserver 已挂到滚动容器（缩略图跟位 + 宽度重排上锁）",
  resizeObservers.length >= 1 && resizeObservers.some((ro) => ro.targets.includes(scroller)),
  `n=${resizeObservers.length}`);

/* ---------------- 宽度重排上锁：平时不加 content-visibility，只在列宽变时临时加 ---------------- */
{
  const cvTags = () => head.children.filter((c) => c.attrs?.["data-dshome-cv-temp"] === "1");
  check("平时不注入 content-visibility（消息全真实排版 ⇒ 数值全真）", cvTags().length === 0);
  const before = canvas.paint.length;
  resizeObservers[0].cb();                       // 模拟「列宽开始变」
  check("列宽一变 ⇒ 临时挂上 content-visibility 锁", cvTags().length === 1 && win.__dshomeCvLocked === true,
    `锁标签 ${cvTags().length} 个 / locked=${win.__dshomeCvLocked}`);
  redraw();                                      // 锁期间想重画
  check("锁期间缩略图冻结不重画（那时的尺寸是占位值，画了会错）", canvas.paint.length === before,
    `${before} → ${canvas.paint.length} 条`);
  clock += 200;
  flushTimers();                                 // 宽度静默 180ms ⇒ 自动摘锁
  check("宽度静默后自动摘锁 + 通知缩略图归位", cvTags().length === 0 && win.__dshomeCvLocked === false,
    `锁标签 ${cvTags().length} 个 / locked=${win.__dshomeCvLocked}`);
  redraw();                                      // 把状态跑干净，别影响后面的用例
}

/* ---------------- 位置来自浏览器真值：一次绘制把每块的 rect 读回来 ---------------- */
rectReads = 0;
canvas.paint.length = 0;
syncNow();
redraw();                                    // 显式重画一次（不再依赖前面用例遗留的定时器）
const lastPaint3 = () => canvas.paint.slice(-3);   // 三块场景：只认最后一次绘制
check("位置来自浏览器真值（走测量路，不再有估算版）",
  win.__dshomeMinimapPerf?.估算 !== true && lastPaint3().length === 3,
  `台账 ${JSON.stringify(win.__dshomeMinimapPerf)}`);
check("画出来了（不是空白）", lastPaint3().length === 3, `最后一次画了 ${lastPaint3().length} 条`);
check("画布高 > 0（比例尺固定的结果）", contentHeight() > 0, String(contentHeight()));

/* ---------------- 绘制形态：位置=真实位置 / 底锚定 / 用户靠右 / 无黑遮罩 ---------------- */
{
  const content = contentHeight();
  const total = TOTAL;
  const scale = content / total;
  const paint = lastPaint3();
  // 真值：块 i 的下沿（自末尾累加真实高度，与插件同一套坐标）
  let acc = 0;
  const truth = new Array(HEIGHTS.length);
  for (let i = HEIGHTS.length - 1; i >= 0; i -= 1) { truth[i] = content - acc * scale; acc += HEIGHTS[i]; }
  const err = paint.map((p, i) => Math.abs(p.y + p.h - truth[i]));
  check("缩略图位置 = 会话里的真实位置（每块误差 ≤ 3px）", Math.max(...err) <= 3,
    `误差 ${err.map((e) => e.toFixed(1)).join(",")}px`);
  const mine = paint.filter((p) => p.fill === COLORS["--dsw-alias-brand-primary"]);
  const reply = paint.filter((p) => p.fill === COLORS["--dsw-alias-label-tertiary"]);
  check("用户块靠右、助手块靠左", mine.length === 2 && reply.length === 1 && mine.every((p) => p.x === BOX_W - p.w) && reply[0].x === 0,
    `用户 x=${mine.map((p) => p.x).join(",")} / 助手 x=${reply[0].x}`);
  check("宽度随内容量变（长内容宽、短内容窄）", new Set(paint.map((p) => Math.round(p.w))).size === 3,
    `宽度=${paint.map((p) => Math.round(p.w)).join(",")}`);
  check("无黑遮罩：没有任何一条铺满整宽", paint.every((p) => p.w < BOX_W), `最宽 ${Math.max(...paint.map((p) => p.w))}`);
}

/* ---------------- 位置 = 浏览器真值（全量读一遍）+ 反例证伪 ---------------- */
/* 200 块的「长会话」，真实高度**故意**打破「高度 ∝ 字数」的线性关系：每 7 块塞一个
   「字很少但很高」的块（代码块 / 折叠块）——按字数估必然估不准。位置要准就只能取浏览器真值。 */
const N = 200;
const realTop = [];
const realH = [];
const lens = [];
{
  let acc = 0;
  for (let i = 0; i < N; i += 1) {
    const big = i % 7 === 3;
    const len = big ? 10 : 40 + (i % 5) * 30;
    const h = big ? 900 : 20 + 0.5 * len;
    realTop.push(acc); realH.push(h); lens.push(len); acc += h;
  }
}
const BIG_TOTAL = realTop.at(-1) + realH.at(-1);
/** 装一批**全新元素**；`garbage = true` 时让 rect 报垃圾值（top/height 都是 0）——
    代表「拿不到浏览器的真位置」，用来证伪「位置 = 真值」这条判据有牙齿。 */
const setBig = (garbage = false) => {
  const list = [];
  for (let i = 0; i < N; i += 1) {
    const el = block(1 + (i >> 1), i % 2 === 0 ? "user" : "assistant", realH[i], "z".repeat(lens[i]), realTop[i]);
    if (garbage) el.getBoundingClientRect = () => { rectReads += 1; return { top: 0, height: 0, width: 800, left: 0, right: 800, bottom: 0 }; };
    list.push(el);
  }
  scroller.blocks = list;
  scroller.querySelectorAll = (sel) => (sel.includes("data-chat-turn") ? list : []);
  scroller.scrollHeight = BIG_TOTAL;
  return list;
};
/** 块 i 的下沿在画布上的**真值**（与插件同一套坐标）。 */
const truthBottom = (i, content) => content - (BIG_TOTAL - realTop[i] - realH[i]) * (content / BIG_TOTAL);
/** 最近一次绘制画出来的方块（可能一次 flush 里跑了好几次 draw ⇒ 只认最后 N 条，
    否则拿到的 y 和插件内部的块表不是同一次绘制的，会得出假结论）。 */
const lastPaint = () => canvas.paint.slice(-N);

/** 画出来的块位置与真值的最大误差。范围 = 框上下各「两倍框高」——这是主人能拿屏幕对照的范围。 */
const errNearThumb = () => {
  const content = contentHeight();
  const paint = lastPaint();
  const thumbH = parseFloat(thumb.style.height);
  const margin = 2 * Math.max(12, thumbH);
  const t0 = thumbTop() - margin;
  const t1 = thumbTop() + thumbH + margin;
  let err = 0;
  let n = 0;
  let worst = -1;
  for (let i = 0; i < paint.length; i += 1) {
    const mid = screenY(paint[i].y + paint[i].h / 2);   // 画布坐标 → 条内坐标（框是条内坐标）
    if (mid < t0 || mid > t1) continue;
    const e = Math.abs(paint[i].y + paint[i].h - truthBottom(i, content));
    if (e > err) { err = e; worst = i; }
    n += 1;
  }
  return { err, n, worst, paints: canvas.paint.length };
};
const errAll = () => {
  const content = contentHeight();
  const paint = lastPaint();
  let err = 0;
  for (let i = 0; i < N && i < paint.length; i += 1) err = Math.max(err, Math.abs(paint[i].y + paint[i].h - truthBottom(i, content)));
  return { err, paints: paint.length };
};

// ① 刚打开会话（人在底部）：**整条**位置都该是真值，不需要「先翻一遍」
setBig();
scroller.scrollTop = BIG_TOTAL - VIEW;
canvas.paint.length = 0;
rectReads = 0;
syncNow();
redraw();
const opened = errNearThumb();
const openedAll = errAll();
check("打开会话（在底部）：眼前的块位置立刻就对得上（误差 ≤ 3px）", opened.err <= 3 && opened.n >= 5,
  `最大误差 ${opened.err.toFixed(1)}px（第 ${opened.worst} 块）/ 检查了 ${opened.n} 块 / paint ${opened.paints} 条`);
check("★ 位置 = 浏览器真值：整条缩略图都准（误差 ≤ 4px），不用先翻一遍", openedAll.err <= 4,
  `最大误差 ${openedAll.err.toFixed(1)}px / 画了 ${openedAll.paints} 条`);
check("一次绘制把全部块的位置读回来（200 块 = 200 次）", rectReads === N, `读了 ${rectReads} 次`);

// ② 只**滚动**（内容一个块、一个高度都没变）：这是主人翻历史走的路。
//    位置是浏览器排的、滚动不改它 ⇒ 这里**一次布局都不该读**，canvas 也不该重绘。
{
  canvas.paint.length = 0;
  rectReads = 0;
  clock += 1000;
  for (let s = 0; s <= 40; s += 1) {
    clock += 300;
    scroller.scrollTop = Math.round((BIG_TOTAL - VIEW) * (1 - s / 40));
    fireScroll();
  }
  check("只滚动：一次布局都不读（位置没变，只挪框 + 平移）", rectReads === 0, `读了 ${rectReads} 次`);
  check("只滚动：canvas 一个字都不重绘（位置没变，没必要重画）", canvas.paint.length === 0,
    `重画了 ${canvas.paint.length} 条`);
}

// ②c 总高变了（被跳过的块渲染出来 / 加载更早）⇒ 必须自己重画，不能让比例尺过期
{
  const before = canvas.paint.length;
  scroller.scrollHeight = BIG_TOTAL + 500;      // 模拟「块渲染出来，总高变了」
  clock += 1000;
  fireScroll();
  check("总高变了 ⇒ 滚动时就自动重画（比例尺不能过期）", canvas.paint.length > before,
    `${before} → ${canvas.paint.length} 条`);
  scroller.scrollHeight = BIG_TOTAL;
}

// 反例（原来验证「拿不到真 rect ⇒ 位置会错」）已不再成立：v33 起脏值不入缓存、只用临时高度兜这一帧，
// 所以那条反例由「病根回归」两条判据取代（渲染完成后会被复核改成真值 / 复核稳定即停）。

/* ---------------- 加载/流式的开销：位置只在「真变了」时才重读（主人报的「要等」正治这儿） ---------------- */
{
  setBig();
  scroller.scrollTop = BIG_TOTAL - VIEW;
  canvas.paint.length = 0;
  rectReads = 0;
  syncNow();
  redraw();
  check("换了一套块 ⇒ 全量读一遍（必要的一次）", rectReads === N, `读了 ${rectReads} 次`);

  // ① 同一批元素、总高也没变 ⇒ 纯重画：一个 rect 都不读
  clock += 50;
  rectReads = 0;
  redraw();
  check("同一批块再画一次：一个 rect 都不读（纯重画）", rectReads === 0,
    `读了 ${rectReads} 次（台账：${JSON.stringify(win.__dshomeMinimapPerf)}）`);

  // ② 流式输出：尾部块长高（总高变了）⇒ 只重读尾部几块 + 视口那几块
  scroller.scrollHeight = BIG_TOTAL + 400;
  clock += 50;
  rectReads = 0;
  redraw();
  check("流式输出（尾部变高）：只重读十几块，不是 200 块", rectReads > 0 && rectReads <= 20,
    `读了 ${rectReads} 次（全量要 200 次）`);

  // ③ 超过 2s 强制全量核对一次（上面的块也可能被改高/改矮）
  clock += 5000;
  rectReads = 0;
  redraw();
  check("超过 2s 强制全量核对一次（兜住上面的改动）", rectReads === N, `读了 ${rectReads} 次`);

  check("性能台账已暴露（window.__dshomeMinimapPerf，卡了就念给鱼听）",
    typeof win.__dshomeMinimapPerf === "object" && typeof win.__dshomeMinimapPerf.毫秒 === "number",
    JSON.stringify(win.__dshomeMinimapPerf));

  scroller.scrollHeight = BIG_TOTAL;
  mutationObservers[0].cb();
  clock += 5000;
  redraw();
}

/* ---------------- 框与缩略图同步（恒等式，只证明实现跟公式一致） ----------------
   注意：这条是**恒等式**——偏移量定义成「视口在内容里的位置 − 框在屏幕上的位置」，
   所以「视口底 == 框底」必然成立，它没有判别力（曾经被当成「框准不准」的判据，是错的）。
   真正有判别力的是下面「点哪到哪」和「位置 = 真实位置」两条。 */
{
  setBig();
  scroller.scrollTop = 0;
  canvas.paint.length = 0;
  syncNow();
  redraw();
  const content = contentHeight();
  const thumbH = parseFloat(thumb.style.height);   // 必须在 sync 之后读（sync 才会更新框高）
  for (const top of [0, BIG_TOTAL * 0.2, BIG_TOTAL * 0.5, BIG_TOTAL - VIEW]) {
    fireScroll(top);
    const offset = -num(canvas.style.transform);
    const viewportBottomOnScreen = ((scroller.scrollTop + VIEW) / BIG_TOTAL) * content - offset;
    check(`★ 滚动到 ${Math.round(top)}：视口底 == 框底（${viewportBottomOnScreen.toFixed(1)} vs ${(thumbTop() + thumbH).toFixed(1)}）`,
      closeTo(viewportBottomOnScreen, thumbTop() + thumbH, 1.5));
  }
  fireScroll(0);
}

/* ---------------- 点哪到哪：点某块 ⇒ 会话滚到「那块就在屏幕里」 ---------------- */
{
  setBig();
  scroller.scrollTop = 0;
  syncNow();
  fireScroll(BIG_TOTAL * 0.5);     // 停在会话中段（位置本来就是真值，不用先翻一遍）
  const paint = lastPaint();
  const thumbH0 = parseFloat(thumb.style.height);
  // 只挑**此刻真的显示在条里**的块当探针（点看不见的地方没有意义）
  const probes = [];
  for (let i = 0; i < N; i += 1) {
    if (paint[i] === undefined) continue;
    const y0 = screenY(paint[i].y);
    const y1 = screenY(paint[i].y + paint[i].h);
    if (y0 > 40 && y1 < BAND - 40 && (probes.length === 0 || i - probes.at(-1) > 10)) probes.push(i);
  }
  let missed = 0;
  let notCovered = 0;
  const detail = [];
  for (const i of probes) {
    const local = screenY(paint[i].y + paint[i].h / 2);
    const want = realTop[i] + realH[i] / 2;       // 点中的那块**在会话里的真实位置**（真值）
    box.dispatch("pointerdown", pointer(8 + local));
    box.dispatch("pointerup", pointer(8 + local));
    const t0 = thumbTop();
    const centered = Math.abs(scroller.scrollTop + VIEW / 2 - want) <= 250;   // 要求③：会话到该位置
    // 要求③后半：「滑块移动到对应位置」= 滑块在**缩略条上**正好覆盖你点的那一条
    // （滑块在缩略条上的区间 = 平移量 + 滑块在视窗内的位置，与那块画出来的区间相交）
    const offsetNow = -num(canvas.style.transform);
    const thumbOnStrip = [offsetNow + t0, offsetNow + t0 + thumbH0];
    const blockOnStrip = [paint[i].y, paint[i].y + paint[i].h];
    const covered = thumbOnStrip[1] > blockOnStrip[0] && thumbOnStrip[0] < blockOnStrip[1];
    if (!covered) notCovered += 1;
    if (!centered) {
      missed += 1;
      detail.push(`#${i} 想跳 ${want.toFixed(0)}，视口 ${scroller.scrollTop.toFixed(0)}..${(scroller.scrollTop + VIEW).toFixed(0)}`);
    }
  }
  check("要求③：点击视窗某处 ⇒ 会话移动到该位置（那条落视口中央）", missed === 0 && probes.length >= 2,
    `探针 ${probes.length} 个，没跳对 ${missed} 个 ${detail.join(" | ")}`);
  check("要求③：点击后滑块在缩略条上**正好覆盖你点的那条**", notCovered === 0,
    `${probes.length - notCovered}/${probes.length} 个覆盖住了`);
  scroller.scrollTop = 0;
  fireScroll(0);
}

/* ---------------- hover 提示：指哪说哪（说出来的必须是**画在指针下**的那一块） ---------------- */
{
  setBig();
  scroller.scrollTop = 0;
  canvas.paint.length = 0;
  syncNow();
  redraw();
  fireScroll(BIG_TOTAL * 0.5);
  const paint = lastPaint();
  const label = (i) => `第 ${1 + (i >> 1)} 轮 · ${i % 2 === 0 ? "你说" : "助手回复"}`;
  const probes = [3, 50, 120, 199].filter((i) => paint[i] !== undefined);
  let wrong = 0;
  const detail = [];
  for (const i of probes) {
    clock += 100; // 越过 60ms 提示节流
    const local = screenY(paint[i].y + paint[i].h / 2);
    box.dispatch("pointermove", { button: 0, pointerId: 1, clientY: 8 + local, buttons: 0, preventDefault() {}, stopPropagation() {} });
    // 指针底下**画着**哪些块（画出来的矩形覆盖这个点）
    const hits = [];
    for (let j = 0; j < paint.length; j += 1) {
      const y0 = screenY(paint[j].y);
      const y1 = screenY(paint[j].y + paint[j].h);
      if (local >= y0 && local <= y1) hits.push(j);
    }
    // 细块在画布上只有 1~2px、彼此重叠，屏幕上根本分不出隔壁那条 ⇒ 允许 ±1 条；
    // 画得够粗（≥6px）的块没有歧义，必须**正好**是它。
    const slack = paint[i].h >= 6 ? 0 : 1;
    const okSet = new Set();
    for (const j of hits) {
      for (let k = j - slack; k <= j + slack; k += 1) if (k >= 0 && k < N) okSet.add(label(k));
    }
    if (!okSet.has(tip.textContent.split("\n")[0])) {
      wrong += 1;
      detail.push(`#${i}(粗 ${paint[i].h.toFixed(1)}px) 提示「${tip.textContent}」，指针下画着 ${hits.slice(0, 3).map(label).join("/") || "（无）"}`);
    }
  }
  check("悬停：提示说的就是画在指针下的那一块", wrong === 0,
    `探针 ${probes.length} 个，说错 ${wrong} 个 ${detail.join(" | ")}`);
  // 第二行必须是**这条消息的开头文字**（主人说「只写第几轮看不出来是什么」）
  {
    const marker = "UNIQUE_MARKER_42_这是这条消息的开头";
    const paint2 = lastPaint();
    let target = -1;
    for (let i = 0; i < N; i += 1) {
      const y = screenY(paint2[i].y + paint2[i].h / 2);
      if (y > 20 && y < BAND - 20) { target = i; break; }
    }
    scroller.blocks[target].textContent = marker;
    clock += 100;
    const local = screenY(paint2[target].y + paint2[target].h / 2);
    box.dispatch("pointermove", { button: 0, pointerId: 1, clientY: 8 + local, buttons: 0, preventDefault() {}, stopPropagation() {} });
    const lines = tip.textContent.split("\n");
    check("悬停提示第二行 = 该条消息的开头文字（看得出是什么）",
      lines.length === 2 && lines[1].includes(marker.slice(0, 20)),
      `提示「${tip.textContent.replace("\n", " ⏎ ")}」`);
  }
  fireScroll(0);
}

/* ---------------- 点击视窗（另一组探针）：点到哪条就滚到哪条 ---------------- */
{
  setBig();
  scroller.scrollTop = Math.round((BIG_TOTAL - VIEW) * 0.5);
  canvas.paint.length = 0;
  syncNow();
  redraw();
  fireScroll(BIG_TOTAL * 0.5);
  const paint = lastPaint();
  // 只挑**此刻真的显示在条里**的块（detail 模式条里只有一部分）
  const probes = [];
  for (let i = 0; i < N; i += 1) {
    if (paint[i] === undefined) continue;
    const y0 = screenY(paint[i].y);
    const y1 = screenY(paint[i].y + paint[i].h);
    if (y0 > 40 && y1 < BAND - 40 && (probes.length === 0 || i - probes.at(-1) > 4)) probes.push(i);
  }
  let bad = 0;
  const detail = [];
  let skipped = 0;
  for (const i of probes) {
    const local = screenY(paint[i].y + paint[i].h / 2);
    // 落在框的抓取区里的按下 = 「抓着框拖」，本来就不该跳（那是有意为之）⇒ 跳过
    const t0 = thumbTop();
    const th = parseFloat(thumb.style.height);
    const pad = Math.max(8, th * 0.5);
    if (local >= t0 - pad && local <= t0 + th + pad) { skipped += 1; continue; }
    const want = realTop[i] + realH[i] / 2;
    box.dispatch("pointerdown", pointer(8 + local));
    box.dispatch("pointerup", pointer(8 + local));
    const landed = scroller.scrollTop + VIEW / 2;
    if (Math.abs(landed - want) > 250) {
      bad += 1;
      detail.push(`#${i} local=${local.toFixed(1)} 真高=${realH[i]} 落点=${landed.toFixed(0)} 想=${want.toFixed(0)} 差=${(landed - want).toFixed(0)}`);
    }
  }
  check("点击视窗：点到哪条就滚到哪条（点到的那条落视口中央）", bad === 0 && probes.length - skipped >= 2,
    `探针 ${probes.length} 个（${skipped} 个落在滑块上=拖滑块），错 ${bad} 个 ${detail.join(" | ")}`);
  win.__dshomeMinimapMode = "exact";
  scroller.scrollTop = 0;
  fireScroll(0);
}

/* ---------------- 主人四条要求：一套比例尺（缩略条 / 视窗 / 滑块 / 屏幕内容） ---------------- */
{
  setBig();
  scroller.scrollTop = 0;
  canvas.paint.length = 0;
  syncNow();
  redraw();
  const stripH = contentHeight();                    // 缩略条总长 = 会话总高 × 比例尺
  const scale = stripH / BIG_TOTAL;
  const thumbH = parseFloat(thumb.style.height);

  // 要求①：缩略条、视窗、滑块共用同一把尺（滑块高/视口高 == 缩略条长/会话总高）
  check("要求①：三者比例尺一致（滑块高/视口高 == 缩略条长/会话总高）",
    Math.abs(thumbH / VIEW - scale) <= 1e-6,
    `滑块 ${(thumbH / VIEW).toFixed(6)} vs 缩略条 ${scale.toFixed(6)}`);
  check("要求①：滑块高 = 8% 视窗高（不会被压扁）", Math.abs(thumbH - BAND * 0.08) <= 1.5, `${thumbH.toFixed(1)}px`);
  {
    const paint = lastPaint();
    const visible = paint.filter((p) => screenY(p.y + p.h) > 0 && screenY(p.y) < BAND).length;
    check("要求①：视窗里装下的内容量固定 ⇒ 只看得到一部分消息", visible > 0 && visible < N / 3,
      `条里可见 ${visible}/${N}（整篇 ${N} 条）`);
  }

  // 要求②：缩略条随滑块反方向平移；会话顶/底时缩略条顶/底正好贴视窗边
  const offsetAt = (top) => { scroller.scrollTop = top; fireScroll(); return -num(canvas.style.transform); };
  const topOff = offsetAt(0);
  check("要求②：会话在顶部 ⇒ 缩略条顶部贴视窗顶（平移 0）", closeTo(topOff, 0, 1), `平移 ${topOff.toFixed(1)}px`);
  const botOff = offsetAt(BIG_TOTAL - VIEW);
  check("要求②：会话在底部 ⇒ 缩略条底部贴视窗底", closeTo(botOff, stripH - BAND, 1),
    `平移 ${botOff.toFixed(1)}px / 应为 ${(stripH - BAND).toFixed(1)}px`);
  const tBot = thumbTop() + thumbH;
  check("要求②：到最底时滑块底边 == 视窗底边", closeTo(tBot, BAND, 1.5), `${tBot.toFixed(1)} vs ${BAND}`);
  const mid = Math.round((BIG_TOTAL - VIEW) * 0.5);
  const midOff = offsetAt(mid);
  const wantMid = mid * scale * (stripH - BAND) / (stripH - thumbH);   // 速度按缩略条长度适配
  check("要求②：中间位置按缩略条长度适配平移（不是 1:1 跟着滑）", closeTo(midOff, wantMid, 1.5),
    `平移 ${midOff.toFixed(1)} vs ${wantMid.toFixed(1)}`);

  // 要求① 的另一半：会话再长，滑块高也不变
  const thumbAtTotal = (totalH) => {
    scroller.scrollHeight = totalH;
    mutationObservers[0].cb();
    scroller.scrollTop = Math.round((totalH - VIEW) * 0.5);
    canvas.paint.length = 0;
    syncNow();
    redraw();
    return parseFloat(thumb.style.height);
  };
  const t1 = thumbAtTotal(BIG_TOTAL);
  const t2 = thumbAtTotal(BIG_TOTAL * 2);
  const t3 = thumbAtTotal(BIG_TOTAL * 4);
  check("要求①：会话高 ×1/×2/×4，滑块高一点不变",
    Math.abs(t1 - t2) <= 1 && Math.abs(t2 - t3) <= 1,
    `${t1.toFixed(1)} → ${t2.toFixed(1)} → ${t3.toFixed(1)}px`);
  scroller.scrollHeight = BIG_TOTAL;
  mutationObservers[0].cb();
  scroller.scrollTop = 0;
  syncNow();
  redraw();
  fireScroll(0);
}

/* ---------------- 滚回去：长会话里已有内容不位移（底锚定 + 比例尺恒定） ---------------- */
{
  const els = setBig();
  scroller.scrollTop = BIG_TOTAL - VIEW;   // 停在底部
  canvas.paint.length = 0;
  syncNow();
  redraw();
  fireScroll(BIG_TOTAL - VIEW);
  const beforePaint = lastPaint();
  const lastBefore = screenY(beforePaint.at(-1).y);
  // 「不位移」只对**正在看的那几块**有意义（上面几千像素外的块本来就不在屏幕上，
  // 它们的画布坐标会随会话总高变化——那是看不见的，不是「抖」）。
  const keepBefore = beforePaint.slice(-4).map((p) => screenY(p.y));
  // 更早的一轮进来：**同一个元素整体下移**（DOM 不换、实测缓存不丢，和真实一致），会话总高变大
  for (const el of els) el.topShift = 640;
  const extra = block(0, "assistant", 640, "k".repeat(80), 0);
  scroller.blocks = [extra, ...els];
  scroller.querySelectorAll = (sel) => (sel.includes("data-chat-turn") ? scroller.blocks : []);
  scroller.scrollHeight = BIG_TOTAL + 640;
  scroller.scrollTop = BIG_TOTAL + 640 - VIEW;
  scroller.rect = { top: 0, height: VIEW, width: 800, left: 0, right: 800, bottom: VIEW };
  canvas.paint.length = 0;
  syncNow();
  redraw();
  fireScroll(BIG_TOTAL + 640 - VIEW);
  const after = lastPaint();
  check("★ 更早的一轮进来后，最下面那块在屏幕上纹丝不动",
    closeTo(screenY(after.at(-1).y), lastBefore, 2), `${lastBefore.toFixed(1)} → ${screenY(after.at(-1).y).toFixed(1)}`);
  check("★ 更早的一轮进来后，正在看的那几块在屏幕上纹丝不动",
    after.slice(-4).every((p, k) => closeTo(screenY(p.y), keepBefore[k], 3)),
    `下沿 ${lastBefore.toFixed(1)} → ${screenY(after.at(-1).y).toFixed(1)}；末 4 块 ${keepBefore.map((v) => v.toFixed(0)).join(",")} → ${after.slice(-4).map((p) => screenY(p.y).toFixed(0)).join(",")}`);
}

/* ---------------- 回到三块场景，做交互 / 生命周期 ---------------- */
scroller.blocks = [
  block(1, "user", HEIGHTS[0], "x".repeat(100), 0),
  block(1, "assistant", HEIGHTS[1], "y".repeat(400), HEIGHTS[0]),
  block(2, "user", HEIGHTS[2], "", HEIGHTS[0] + HEIGHTS[1]),
];
scroller.querySelectorAll = (sel) => (sel.includes("data-chat-turn") ? scroller.blocks : []);
scroller.scrollHeight = TOTAL;
scroller.scrollTop = 0;
const TOTAL3 = TOTAL;
redraw();
syncNow();                                   // 先让总高/框高跟上新场景，再读框高（否则读到上一个是真场景的残留）
const thumbH3 = parseFloat(thumb.style.height);
const scrollRange3 = TOTAL3 - VIEW;

/* ---------------- 交互：相对拖动（按框上抓着拖／按框外框心对齐） ---------------- */
{
  const grabLocal = 40;
  box.dispatch("pointerdown", pointer(8 + grabLocal));
  check("按在框内 ⇒ 位置不跳（抓着它，不是弹到鼠标）", scroller.scrollTop === 0, String(scroller.scrollTop));
  box.dispatch("pointermove", pointer(8 + 80));
  check("拖动时「鼠标 − 框顶」恒定 ⇒ 框跟得住鼠标", closeTo(80 - thumbTop(), grabLocal, 0.5), `${(80 - thumbTop()).toFixed(1)} vs ${grabLocal}`);
  box.dispatch("pointerup", pointer(8 + 80));
  check("松手后清掉拖动标记", box.getAttribute("data-active") === null);
  scroller.scrollTop = 0;
  // 点缩略条**内容区**里的一点（比例尺固定后，短会话的条只占视窗的一部分，下面是空白，
  // 点空白区是"没有内容"的意思，不在本判据范围内）
  const clickLocal = Math.round(Math.min(contentHeight() - 4, parseFloat(thumb.style.height) + 40));
  box.dispatch("pointerdown", pointer(8 + clickLocal));
  const want = clickLocal / (contentHeight() / TOTAL3);
  const thumbCenter = thumbTop() + parseFloat(thumb.style.height) / 2;
  check("点框外 ⇒ 框心落在鼠标处（够不到时是夹在边界上）",
    closeTo(thumbCenter, clickLocal, 1.5) || closeTo(scroller.scrollTop, 0, 1) || closeTo(scroller.scrollTop, TOTAL3 - VIEW, 1),
    `框心 ${thumbCenter.toFixed(1)} vs 鼠标 ${clickLocal} / scrollTop ${scroller.scrollTop}`);
  // （短会话的视窗现在会被截断，这条几何前提变了；等价判据在长会话那一节「要求③」里。）
  box.dispatch("pointerup", pointer(8 + clickLocal));
  // ★ 短会话：内容装得下视窗 ⇒ 缩略条**一点都不平移**（滚动时动起来就是 bug，主人报过）
  {
    const offsets = [];
    for (const top of [0, 100, 300, 460]) {
      scroller.scrollTop = top;
      fireScroll();
      offsets.push(Math.round(-num(canvas.style.transform) * 100) / 100);
    }
    check("短会话：内容装得下视窗 ⇒ 缩略条一点都不平移", offsets.every((v) => Math.abs(v) <= 0.05),
      `各滚动位置的平移量 ${offsets.join(", ")}`);
    scroller.scrollTop = 0;
    fireScroll(0);
  }
}

/* ---------------- 鼠标不会被「夺走」 ---------------- */
{
  scroller.scrollTop = 0;
  box.dispatch("pointerdown", pointer(8 + 40));
  const afterDown = scroller.scrollTop;
  box.dispatch("pointermove", { ...pointer(8 + 400), buttons: 0 });
  const afterRelease = scroller.scrollTop;
  box.dispatch("pointermove", pointer(8 + 600));
  check("左键松开后不再跟着鼠标滚（拖动状态不卡死）",
    afterRelease === afterDown && scroller.scrollTop === afterRelease, `${afterDown} → ${afterRelease} → ${scroller.scrollTop}`);
  scroller.scrollTop = 0;
  box.dispatch("pointerdown", pointer(8 + 40));
  (docListeners.pointerup ?? [])[0]?.({ button: 0, pointerId: 1 });
  const afterUp = scroller.scrollTop;
  box.dispatch("pointermove", pointer(8 + 600));
  check("全局 pointerup 兜底：up 落在条外也能复位", scroller.scrollTop === afterUp, String(scroller.scrollTop));
  scroller.scrollTop = 1000;
  box.dispatch("wheel", { deltaY: 240, deltaMode: 0, preventDefault() {} });
  check("滚轮转发：停在条上滚轮也能滚会话", scroller.scrollTop === 1240, String(scroller.scrollTop));
  scroller.scrollTop = 0;
}

/* ---------------- 急停开关 / 调参钩子 ---------------- */
{
  win.__dshomeMinimapOff = true;
  syncNow();
  check("急停开关：敲一行就整条撤掉", box.style.display === "none", String(box.style.display));
  win.__dshomeMinimapOff = false;
  syncNow();
  win.__dshomeMinimapWidth = 80;
  syncNow();
  check("调参钩子：条宽可实时改", box.style.width === "80px", String(box.style.width));
  win.__dshomeMinimapWidth = undefined;
  syncNow();
  check("清掉钩子后回到默认宽", box.style.width === `${BOX_W}px`, String(box.style.width));
}

/* ---------------- 反例：无输入即响亮失败（不许崩、不许假装在画） ---------------- */
{
  const saved = document_._rail;
  document_._rail = null;
  let threw = null;
  try { syncNow(); } catch (error) { threw = error; }
  check("无官方导轨 ⇒ **仍然显示**（兜底贴右边缘），不崩",
    threw === null && box.style.display === "block", `${box.style.display} / ${win.__dshomeMinimapWhy}`);
  document_._rail = saved;
}
{
  const savedH = scroller.scrollHeight;
  scroller.scrollHeight = VIEW;
  let threw = null;
  try { syncNow(); } catch (error) { threw = error; }
  check("反例：内容不足一屏 → 隐藏且不崩", threw === null && box.style.display === "none", String(box.style.display));
  scroller.scrollHeight = savedH;
}
{
  const saved = document_._scrollers;
  document_._scrollers = [];
  let threw = null;
  try { syncNow(); } catch (error) { threw = error; }
  check("反例：无滚动容器 → 隐藏且不崩", threw === null && box.style.display === "none", String(box.style.display));
  document_._scrollers = saved;
}
syncNow();
check("恢复后重新显示", box.style.display === "block", String(box.style.display));

/* ---------------- 复现：切换会话（换滚动容器与块）后，缩略条还在不在 ---------------- */
{
  setBig();
  scroller.scrollTop = 0;
  canvas.paint.length = 0;
  syncNow();
  redraw();
  const dispA = box.style.display;
  const paintA = canvas.paint.length;

  // 会话 B：全新的滚动容器 + 全新的块（旧容器从列表里消失，就像侧栏点开另一个会话）
  const sc2 = new El("div");
  sc2.clientHeight = VIEW;
  sc2.clientWidth = 800;
  sc2.scrollHeight = 20000;
  sc2.rect = { top: 0, height: VIEW, width: 800, left: 0, right: 800, bottom: VIEW };
  const blocksB = [];
  for (let i = 0; i < 60; i += 1) blocksB.push(block(1, "assistant", 300, "b".repeat(100), i * 300));
  sc2.blocks = blocksB;
  sc2.querySelectorAll = (sel) => (sel.includes("data-chat-turn") ? blocksB : []);
  sc2.querySelector = (sel) => (sel.includes("data-chat-turn") ? blocksB[0] : null);
  document_._scrollers = [sc2];
  canvas.paint.length = 0;
  syncNow();
  redraw();
  check("切会话：换了容器就当场完整重绘（台账块数 = 新会话的块数）",
    box.style.display === "block" && win.__dshomeMinimapPerf?.块数 === blocksB.length,
    `B: 显示=${box.style.display} 台账=${JSON.stringify(win.__dshomeMinimapPerf)} / 新会话块数 ${blocksB.length}`);

  // 还原成会话 A
  document_._scrollers = [scroller];
  syncNow();
  redraw();
}

/* ---------------- HMR 可重入 ---------------- */
{
  const before = body.children.length;
  const oldBox = box;
  mod.apply({ get: () => undefined });
  const newBox = body.children.at(-1);
  check("HMR 重跑：旧条从 DOM 撤掉、新条装上（不叠着）",
    body.children.length === before && !body.children.includes(oldBox) && newBox !== oldBox, `n=${body.children.length}`);
  // 这里断的是**版本字符串常量本身**（真机验收的判据锚点：敲 window.__dshomeMinimapVersion 认版本），
  // 不是行为判据 —— 行为判据（避让/全屏/监听）见文件末尾那一节，一条都没放松。
  check("版本戳已设置", win.__dshomeMinimapVersion === "v42-sidebar-avoid", String(win.__dshomeMinimapVersion));
  check("拆解器已挂上", typeof win.__dshomeMinimapTeardown === "function");
  const cssAfter = head.children.at(-1)?.textContent ?? "";
  check("HMR 重跑不重复注入 CSS（样式表只涨一份）", cssAfter === css, `${css.length} → ${cssAfter.length}`);
}

/* ---------------- 病根回归：渲染中读到脏值 / 高度后到（不改 DOM）时必须被复核改回来 ---------------- */
{
  const show = (p) => p.slice(0, 3).map((x) => Math.round(x.h)).join(",");

  // A) 刚打开：块高度先 0、后真值，中间**不制造任何事件**（不改 DOM、不改总高、不滚动）
  setBig();
  let phase = 0;
  scroller.blocks.forEach((el, i) => {
    el.getBoundingClientRect = () => {
      rectReads += 1;
      return { top: phase ? realTop[i] - scroller.scrollTop : 0, height: phase ? realH[i] : 0, width: 800, left: 0, right: 800, bottom: 0 };
    };
  });
  scroller.scrollTop = 0;
  canvas.paint.length = 0;
  rectReads = 0;
  mutationObservers[0].cb();                     // 会话挂上来 = 内容变化（真实里就是这一步）
  flushTimers();
  const duringA = show(lastPaint());
  phase = 1;                                     // 渲染完成（无事件、无 mutation）
  clock += 5000;
  flushTimers();                                 // 复核链按 500ms 节拍跟上来
  const afterA = show(lastPaint());
  check("病根回归：渲染完成后（无任何事件）旧值被复核改成真值", duringA !== afterA,
    `渲染中 ${duringA} → 复核后 ${afterA}`);
  // 复核会停：稳定之后不再有任何读取（不做周期轮询）
  clock += 60000;
  rectReads = 0;
  flushTimers();
  syncNow();
  check("复核稳定即停（静止后不再读、不再轮询）", rectReads === 0, `读了 ${rectReads} 次`);

  // B) 加载更早：顶部插入 30 块（插入=一次 mutation），它们的高度后到。
  //    本用例断言的是「**全量重读一遍**」（`rectReads >= 块数`，实测读数 230/230 ⇒ 每个块都读了）。
  //    **不检查**的是「读到的是不是*后到的真值*」——那一点只由主人真机实测确认；夹具的定时器是我
  //    手动 flush 的、节拍与真实不完全一致 ⇒ 拿它去证明"真值一定会到"就是假绿。
  setBig();
  const tail = scroller.blocks;
  const extra = [];
  for (let k = 0; k < 30; k += 1) {
    const el = block(1, "assistant", 0, "x".repeat(120), 0);
    el.getBoundingClientRect = () => { rectReads += 1; return { top: 0, height: 0, width: 800, left: 0, right: 800, bottom: 0 }; };
    extra.push(el);
  }
  scroller.blocks = [...extra, ...tail];
  scroller.querySelectorAll = (sel) => (sel.includes("data-chat-turn") ? scroller.blocks : []);
  scroller.scrollHeight = BIG_TOTAL + 9000;
  canvas.paint.length = 0;
  rectReads = 0;
  mutationObservers[0].cb();
  flushTimers();
  check("病根回归：加载更早（元素集变了）⇒ 全量重读一遍", rectReads >= scroller.blocks.length,
    `读了 ${rectReads} 次 / 块数 ${scroller.blocks.length}`);
}

/* ---------------- 通用设置 · 「通知」开关行（真加载 + 组件函数真调用）---------------- */
{
  // 为什么要再 apply 一次：上面那个极简 ctx（只有 get）会让通知行的注册路径整条走不到
  // （只留一条 warn）⇒ 那一段等于没测。这里给足 ctx.slots / ctx.inject / settingsScope。
  const fakeScope = {
    snapshot: {
      status: "ready",
      value: { enabled: true, notifyOnTurnCompletion: true, notifyOnApproval: true, notifyOnUserQuestion: true },
      base: undefined, user: undefined, revision: 1, writable: true, mode: "host",
    },
    listeners: [],
    writes: [],
    bindSpec: null,
    getSnapshot() { return this.snapshot; },
    subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; },
    set(field, value) { this.writes.push([field, value]); return Promise.resolve(); },
    unset(field) { this.writes.push([field, null]); return Promise.resolve(); },
  };

  const registrations = [];
  const runInject = (fn) => {
    const result = fn();
    if (result && typeof result.next === "function") { let step = result.next(); while (!step.done) step = result.next(step.value); }
    return result;
  };
  const fakeSlots = {
    inject: (name, fn) => { runInject(fn); return () => {}; },
    register: (options, component) => { registrations.push({ options, component }); return () => {}; },
  };
  const scopeCtx = { settingsScope: { bind: (spec) => { fakeScope.bindSpec = spec; return fakeScope; } } };
  const ctx2 = {
    get: () => undefined,
    inject: (names, cb) => { if (names.includes("settingsScope")) cb(scopeCtx); },
    slots: fakeSlots,
  };
  // mock react 要**形似真 hooks**（useState 返回 [值, 设置器]；useRef 返回 {current}）：组件函数才能被直接调用取元素树。
  const fakeReact = {
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (init) => ({ current: typeof init === "function" ? init() : init }),
  };
  const fakeRequire2 = (name) => name === "react" ? fakeReact
    : name === "react/jsx-runtime" ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" }
      : new Proxy({}, { get: () => () => ({}) });

  const mod2 = win.__def.factory(fakeRequire2);
  let notifyThrew = null;
  try { mod2.apply(ctx2); } catch (error) { notifyThrew = error; }
  check("通知行：apply 不抛", notifyThrew === null, notifyThrew === null ? "" : String(notifyThrew));
  check("通知行：绑定命名空间 = dshome（写错命名空间 ⇒ 设置静默不生效）",
    fakeScope.bindSpec?.namespace === "dshome", JSON.stringify(fakeScope.bindSpec));
  const card = registrations.find((r) => r.options?.id === "dshome-notify-settings");
  check("通知行：注册进 settings.general.item（通用设置区）",
    card?.options?.name === "settings.general.item", JSON.stringify(card?.options ?? null));

  const collect = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== "object") return out;
    if (Array.isArray(node)) { for (const child of node) collect(child, out); return out; }
    if (node.props?.role === "switch") out.push(node);
    collect(node.props?.children, out);
    return out;
  };
  const tree = card.component();
  const text = JSON.stringify(tree);
  const switches = collect(tree);
  check("通知行：五项开关都在（总开关 + 四个分项，v2 新增后台/成员任务）", switches.length === 5, `找到 ${switches.length}`);
  for (const label of ["系统通知", "回合完成时提醒", "后台/成员任务完成时提醒", "需要我确认时提醒", "有问题等我回答时提醒"]) {
    check(`通知行文案含「${label}」`, text.includes(label));
  }

  fakeScope.writes.length = 0;
  switches[3].props.onClick();          // 0=总开关 1=回合 2=后台/成员 3=确认 4=提问
  check("通知行：点「需要我确认时提醒」写回 notifyOnApproval=false（字段名写错=静默失效）",
    JSON.stringify(fakeScope.writes) === JSON.stringify([["notifyOnApproval", false]]), JSON.stringify(fakeScope.writes));

  // v2 新增行：与「回合完成时提醒」是并列两类，各写各的字段
  fakeScope.writes.length = 0;
  switches[2].props.onClick();
  check("通知行：点「后台/成员任务完成时提醒」写回 notifyOnBackground=false（字段名写错=静默失效）",
    JSON.stringify(fakeScope.writes) === JSON.stringify([["notifyOnBackground", false]]), JSON.stringify(fakeScope.writes));

  fakeScope.snapshot = { ...fakeScope.snapshot, value: { ...fakeScope.snapshot.value, enabled: false, notifyOnBackground: true } };
  const offSwitches = collect(card.component());
  check("反例·总开关关 ⇒ 四个分项禁用、总开关仍可点",
    offSwitches.length === 5 && offSwitches[0].props.disabled !== true && offSwitches.slice(1).every((s) => s.props.disabled === true),
    `${offSwitches.length} 个 / ` + offSwitches.map((s) => (s.props.disabled === true ? "禁" : "可")).join(","));

  fakeScope.snapshot = { ...fakeScope.snapshot, status: "unavailable", value: undefined };
  const unavailableTree = card.component();
  check("反例·命名空间不可用 ⇒ 出「当前不可用」文案、不出开关",
    JSON.stringify(unavailableTree).includes("当前不可用") && collect(unavailableTree).length === 0);
}

/* ---------------- 通用设置 · 通知行「音色下拉 + 试听」（契约 v1）----------------
 * 为什么另起一套 hook 假件：音色候选是**挂载时 fetch** 的，上面那套 no-op 的 useEffect 等于没测
 * （组件永远停在 loading 分支）。这一套 useState 跨渲染保值、useEffect 只收集（由用例决定何时"挂载"），
 * fetch 从 vm 的 sandbox 注入 —— 产品代码里没有任何 test-only 出口。 */
{
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** 一套「真能跑」的通知行夹具：返回渲染入口 + 写回记录。 */
  const makeHarness = (fetchImpl) => {
    const states = [];
    const refs = [];
    let cursor = 0;
    let effects = [];
    const fakeReact3 = {
      useState(init) {
        const at = cursor;
        cursor += 1;
        if (!(at in states)) states[at] = typeof init === "function" ? init() : init;
        return [states[at], (next) => { states[at] = typeof next === "function" ? next(states[at]) : next; }];
      },
      // useRef 要**跨渲染稳定**（真 react 就是这样）：试听读的正是这个同步镜像
      useRef(init) {
        const at = cursor;
        cursor += 1;
        if (!(at in refs)) refs[at] = { current: typeof init === "function" ? init() : init };
        return refs[at];
      },
      useEffect(fn) { effects.push(fn); },
    };
    const fakeRequire3 = (name) => name === "react" ? fakeReact3
      : name === "react/jsx-runtime" ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" }
        : new Proxy({}, { get: () => () => ({}) });
    const writes = [];
    const scope = {
      snapshot: {
        status: "ready",
        value: {
          enabled: true, notifyOnTurnCompletion: true, soundTurnCompletion: "",
          notifyOnApproval: true, soundApproval: "Windows Notify Calendar.wav",
          notifyOnUserQuestion: true, soundUserQuestion: "",
        },
        base: undefined, user: undefined, revision: 1, writable: true, mode: "host",
      },
      getSnapshot() { return this.snapshot; },
      subscribe() { return () => {}; },
      set(field, value) { writes.push([field, value]); return Promise.resolve(); },
      unset() { return Promise.resolve(); },
    };
    const regs = [];
    const runInject = (fn) => { const r = fn(); if (r && typeof r.next === "function") { let s = r.next(); while (!s.done) s = r.next(s.value); } return r; };
    const ctx3 = {
      get: () => undefined,
      inject: (names, cb) => { if (names.includes("settingsScope")) cb({ settingsScope: { bind: () => scope } }); },
      slots: { inject: (n, fn) => { runInject(fn); return () => {}; }, register: (o, c) => { regs.push({ options: o, component: c }); return () => {}; } },
    };
    sandbox.fetch = fetchImpl;
    win.__def.factory(fakeRequire3).apply(ctx3);
    const card = regs.find((r) => r.options?.id === "dshome-notify-settings");
    return {
      writes, scope, card,
      /** 模拟 scope 变更：把组件里那份快照换掉（真实里由 subscribe 回调 → setSnap 做）。 */
      setValue(value) {
        scope.snapshot = { ...scope.snapshot, value };
        if (states.length > 0) states[0] = scope.snapshot;
      },
      /** 一次渲染：跑 component() 并把本次收集到的 effect 交回（由调用方决定何时真"挂载"）。 */
      render() { cursor = 0; effects = []; const tree = card.component(); return { tree, effects }; },
    };
  };

  const collectNodes = (node, hit, out = []) => {
    if (node === null || node === undefined || typeof node !== "object") return out;
    if (Array.isArray(node)) { for (const child of node) collectNodes(child, hit, out); return out; }
    if (hit(node)) out.push(node);
    collectNodes(node.props?.children, hit, out);
    return out;
  };
  const byType = (tree, type) => collectNodes(tree, (n) => n.type === type);
  const byAria = (tree, type, aria) => collectNodes(tree, (n) => n.type === type && n.props?.["aria-label"] === aria);
  const previewButtons = (tree) => collectNodes(tree, (n) => n.type === "button" && typeof n.props?.["aria-label"] === "string" && n.props["aria-label"].startsWith("试听："));
  const okFetch = (payload) => {
    const calls = [];
    return { calls, fn: (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }); } };
  };
  const failFetch = () => {
    const calls = [];
    return { calls, fn: (url, init) => { calls.push({ url, init }); return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:32123")); } };
  };
  /** 挂载（跑 effect）+ 让 fetch 的 promise 链落地 + 重渲染 = 真实的 effect → setState → 重渲染。 */
  const mount = async (h) => {
    const first = h.render();
    for (const fn of first.effects) fn();
    await tick();
    await tick();
    return h.render().tree;
  };

  /* 常用清单夹具（照本机真实规模）：8 个常用 + 62 个其它 = 70 项；
     而且**故意把 8 个常用按倒序夹在中间**——候选必须按清单顺序重排，照抄 /sounds 顺序就必红。 */
  const COMMON8 = [
    "Windows Notify System Generic.wav", "Windows Notify Calendar.wav", "Windows Notify Email.wav",
    "Windows Notify Messaging.wav", "Windows Notify.wav", "notify.wav", "chimes.wav", "ding.wav",
  ];
  const FILLER62 = Array.from({ length: 62 }, (_, i) => `Alarm${String(i + 1).padStart(2, "0")}.wav`);
  const SOUNDS_70 = [...FILLER62.slice(0, 31), ...[...COMMON8].reverse(), ...FILLER62.slice(31)];
  const optionValuesOf = (tree, aria) => {
    const row = aria === undefined ? byType(tree, "select")[0] : byAria(tree, "select", aria)[0];
    return row === undefined ? null : row.props.children.map((o) => o.props.value);
  };

  /* A) 正常路径：候选真进下拉；四个下拉/按钮齐；分组映射逐条钉死 */
  const okMock = okFetch({ dir: "C:\\Windows\\Media", sounds: SOUNDS_70 });
  const hA = makeHarness(okMock.fn);
  const treeA = await mount(hA);
  check("音色：候选列表走 GET http://127.0.0.1:32123/sounds（挂载时取一次）",
    okMock.calls.length === 1 && okMock.calls[0].url === "http://127.0.0.1:32123/sounds", JSON.stringify(okMock.calls.map((c) => c.url)));
  const selectsA = byType(treeA, "select");
  check("音色：四个下拉 + 四个「试听」按钮都在（v2 加了后台/成员任务那一行）",
    selectsA.length === 4 && previewButtons(treeA).length === 4, `select=${selectsA.length} preview=${previewButtons(treeA).length}`);
  // 70 项 ⇒ 下拉恰好 8 个常用，且**顺序 = 清单顺序**（/sounds 是倒序混在中间的）；首项「默认」、末项「自定义路径…」
  check("常用清单：/sounds 给 70 项 ⇒ 下拉候选恰好是那 8 个、顺序与清单一致（顺序错 ⇒ 必红）",
    JSON.stringify(optionValuesOf(treeA)) === JSON.stringify(["", ...COMMON8, "__dshome_custom__"]),
    JSON.stringify(optionValuesOf(treeA)));
  const optionsA = byType(treeA, "option");
  check("音色：/sounds 的候选真渲染成 option", optionsA.map((o) => o.props.value).includes("chimes.wav"),
    optionsA.map((o) => o.props.value).join("|"));
  check("音色：首项 =（默认，跟随系统）且 value 是空串（空串 = 不额外播音）",
    optionsA[0].props.value === "" && optionsA[0].props.children === "（默认，跟随系统）", String(optionsA[0].props.children));

  // 分组映射（冻结 v1+v2）：下拉的 aria-label = 行名 ⇒ 写回的字段名。手法照 1003 行——
  // **字段名写错 / 挂错行 = 静默失效**：下拉看着能选，host 侧没这个字段或写到别的开关上，什么都没发生。
  // 四行**必须**一一对应：回合(主任务) / 后台·成员(其余任务) / 确认 / 提问——换行或写错字段都必红。
  const PAIRS = [
    ["回合完成时提醒 音色", "soundTurnCompletion"],
    ["后台/成员任务完成时提醒 音色", "soundBackground"],
    ["需要我确认时提醒 音色", "soundApproval"],
    ["有问题等我回答时提醒 音色", "soundUserQuestion"],
  ];
  const seenFields = [];
  for (const [aria, field] of PAIRS) {
    const sel = byAria(treeA, "select", aria)[0];
    check(`音色：「${aria.replace(" 音色", "")}」行挂着一个下拉`, sel !== undefined);
    if (sel === undefined) continue;
    hA.writes.length = 0;
    sel.props.onChange({ target: { value: "chimes.wav" } });
    seenFields.push(hA.writes[0]?.[0]);
    check(`音色：该行下拉写回 ${field}（字段名/分组错位 ⇒ 静默失效）`,
      JSON.stringify(hA.writes) === JSON.stringify([[field, "chimes.wav"]]), JSON.stringify(hA.writes));
  }
  check("音色：四个字段名 = 冻结契约（soundTurnCompletion / soundBackground / soundApproval / soundUserQuestion）",
    JSON.stringify(seenFields) === JSON.stringify(PAIRS.map((p) => p[1])), JSON.stringify(seenFields));
  // v2 的关键区分：主任务与后台/成员任务**不能共用**一个音色字段（共用 = 两类分不开、需求没达成）
  const bgSelA = byAria(treeA, "select", "后台/成员任务完成时提醒 音色")[0];
  hA.writes.length = 0;
  bgSelA.props.onChange({ target: { value: "Windows Notify Calendar.wav" } });
  check("反例·后台/成员任务行的下拉只写 soundBackground（写成主任务字段 ⇒ 必红）",
    JSON.stringify(hA.writes) === JSON.stringify([["soundBackground", "Windows Notify Calendar.wav"]]), JSON.stringify(hA.writes));

  /* B) 默认值：空串 / 缺省 ⇒ 渲染成「默认」项（不是空着，也不是第一个候选） */
  hA.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "", soundUserQuestion: "chimes.wav" });
  const treeB = hA.render().tree;
  const selApprovalB = byAria(treeB, "select", "需要我确认时提醒 音色")[0];
  check("音色：空串 ⇒ 下拉 value 是空串（显示「默认，跟随系统」）", selApprovalB.props.value === "", JSON.stringify(selApprovalB.props.value));
  check("音色：缺省（字段缺席）也渲染成「默认」项",
    byAria(treeB, "select", "回合完成时提醒 音色")[0].props.value === "",
    JSON.stringify(byAria(treeB, "select", "回合完成时提醒 音色")[0].props.value));
  check("音色：v2 新行（缺省）同样渲染成「默认」项，不空、不崩",
    byAria(treeB, "select", "后台/成员任务完成时提醒 音色")[0].props.value === "",
    JSON.stringify(byAria(treeB, "select", "后台/成员任务完成时提醒 音色")[0].props.value));
  check("音色：非空值（候选内）⇒ 下拉停在那个候选上",
    byAria(treeB, "select", "有问题等我回答时提醒 音色")[0].props.value === "chimes.wav");
  check("音色：空串 ⇒ 该行不出自定义输入框（常态没展开）",
    byAria(treeB, "input", "需要我确认时提醒 自定义音色路径").length === 0);

  /* B2) 常用清单的三条边界：交集 / 本机缺名 / 交集为空 ⇒ 退全量 / 当前值非常用 ⇒ 不假显示 */
  // ② 白名单里有、本机没有的名字：不出现（交集生效）——本机只有 chimes/ding 两个常用音
  const mockP = okFetch({ dir: "C:\\Windows\\Media", sounds: ["Alarm09.wav", "chimes.wav", "ding.wav"] });
  const hP = makeHarness(mockP.fn);
  const treeP = await mount(hP);
  check("常用清单：本机缺的名字不出现（交集生效），且顺序仍按清单（chimes 在 ding 之前）",
    JSON.stringify(optionValuesOf(treeP)) === JSON.stringify(["", "chimes.wav", "ding.wav", "__dshome_custom__"]),
    JSON.stringify(optionValuesOf(treeP)));
  // ③ 交集为空（异常环境：一个常用音都没有）⇒ 退回全量，**不许空**
  const mockQ = okFetch({ dir: "C:\\Windows\\Media", sounds: ["Alarm01.wav", "Alarm02.wav"] });
  const hQ = makeHarness(mockQ.fn);
  const treeQ = await mount(hQ);
  check("常用清单：交集为空 ⇒ 退回 /sounds 全量（宁可多也不能让下拉空掉）",
    JSON.stringify(optionValuesOf(treeQ)) === JSON.stringify(["", "Alarm01.wav", "Alarm02.wav", "__dshome_custom__"]),
    JSON.stringify(optionValuesOf(treeQ)));
  // ④ 当前值不在常用清单里（之前选过 Alarm01.wav）⇒ 哨兵形态 + 输入框预填，绝不显示成第一项「默认」
  hA.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "Alarm01.wav" });
  const treeR = hA.render().tree;
  check("反例·当前值不在常用清单里（Alarm01.wav）⇒ 哨兵形态，不显示成第一项「默认」",
    byAria(treeR, "select", "需要我确认时提醒 音色")[0].props.value === "__dshome_custom__",
    JSON.stringify(byAria(treeR, "select", "需要我确认时提醒 音色")[0].props.value));
  check("反例·同一行：输入框预填那个非常用值（不丢主人已选）",
    byAria(treeR, "input", "需要我确认时提醒 自定义音色路径")[0]?.props.value === "Alarm01.wav",
    JSON.stringify(byAria(treeR, "input", "需要我确认时提醒 自定义音色路径")[0]?.props.value));
  // 四项能力都在：默认 + 8 个常用 + 自定义路径（哨兵）——一个都不许丢
  check("常用清单：（默认，跟随系统）与（自定义路径…）两项都保留",
    JSON.stringify(optionValuesOf(treeR)) === JSON.stringify(["", ...COMMON8, "__dshome_custom__"]),
    JSON.stringify(optionValuesOf(treeR)));

  /* C) 壳没跑 / 端口不通：不许抛，下拉退默认 + 给手输框 + 一行小字 */
  const badMock = failFetch();
  const hD = makeHarness(badMock.fn);
  let mountThrew = null;
  let treeD = null;
  try { treeD = await mount(hD); } catch (error) { mountThrew = error; }
  check("反例·/sounds 连不上：挂载整条链不抛（失败只降级）", mountThrew === null, mountThrew === null ? "" : String(mountThrew));
  check("音色：失败时确实去试过 /sounds", badMock.calls.length === 1, JSON.stringify(badMock.calls.map((c) => c.url)));
  check("音色：失败 ⇒ 出「壳未运行」小字", JSON.stringify(treeD).includes("壳未运行"));
  check("音色：失败 ⇒ 下拉里没有候选（只剩「默认」项 + 当前值的占位项）",
    byType(treeD, "select").every((s) => s.props.children.every((o) => o.props.value === "" || o.props.value === s.props.value)),
    JSON.stringify(byType(treeD, "select").map((s) => s.props.children.map((o) => o.props.value))));
  check("音色：失败且当前值为空 ⇒ 该行下拉只剩「默认」一项",
    byAria(treeD, "select", "回合完成时提醒 音色")[0].props.children.length === 1,
    JSON.stringify(byAria(treeD, "select", "回合完成时提醒 音色")[0].props.children.map((o) => o.props.value)));
  check("音色：失败 ⇒ 允许手输自定义 .wav 路径", byType(treeD, "input").length === 4, `input=${byType(treeD, "input").length}`);
  check("自定义路径：壳不可达时下拉里**不出现**哨兵项（同一行不留两个自定义入口）",
    byType(treeD, "select").every((s) => s.props.children.every((o) => o.props.value !== "__dshome_custom__")),
    JSON.stringify(byType(treeD, "select").map((s) => s.props.children.map((o) => o.props.value))));
  hD.writes.length = 0;
  byAria(treeD, "input", "回合完成时提醒 自定义音色路径")[0].props.onBlur({ target: { value: "  C:\\Windows\\Media\\Alarm01.wav  " } });
  check("音色：手输路径（回车/失焦）写回 soundTurnCompletion 并去空格",
    JSON.stringify(hD.writes) === JSON.stringify([["soundTurnCompletion", "C:\\Windows\\Media\\Alarm01.wav"]]), JSON.stringify(hD.writes));
  hD.writes.length = 0;
  byAria(treeD, "input", "回合完成时提醒 自定义音色路径")[0].props.onBlur({ target: { value: "   " } });
  check("音色：手输值没变（空白）⇒ 不写回", hD.writes.length === 0, JSON.stringify(hD.writes));

  /* D) 试听：POST /notify {preview:true,sound:<该行当前值>}；壳不可达时不抛 */
  const pvMock = okFetch({ dir: "C:\\Windows\\Media", sounds: ["Alarm01.wav"] });
  const hE = makeHarness(pvMock.fn);
  const treeE = await mount(hE);
  const btnE = byAria(treeE, "button", "试听：需要我确认时提醒 的音色")[0];
  check("音色：「试听」按钮的 aria 与所在行一致（分组映射）", btnE !== undefined);
  pvMock.calls.length = 0;
  let pvThrew = null;
  try { btnE.props.onClick(); } catch (error) { pvThrew = error; }
  const pvCall = pvMock.calls[0];
  check("音色：试听 = POST http://127.0.0.1:32123/notify {preview:true,sound:该行当前值}",
    pvThrew === null && pvCall?.url === "http://127.0.0.1:32123/notify" && pvCall.init?.method === "POST"
      && pvCall.init.body === JSON.stringify({ preview: true, sound: "Windows Notify Calendar.wav" }),
    JSON.stringify(pvCall));
  const hF = makeHarness(failFetch().fn);
  const treeF = await mount(hF);
  let pvFailThrew = null;
  try { byAria(treeF, "button", "试听：回合完成时提醒 的音色")[0].props.onClick(); } catch (error) { pvFailThrew = error; }
  await tick();
  check("反例·壳不可达时点「试听」不抛（失败只 warn；漏出去的 rejection 会让本脚本非 0 退出）",
    pvFailThrew === null, pvFailThrew === null ? "" : String(pvFailThrew));

  // 壳对「preview 但没可用音色」回 400（值 = 空串）⇒ 不能静默：必须出一条 warn，否则"点了没反应也不知道为什么"
  const hostConsole = sandbox.console;
  const warns = [];
  sandbox.console = { warn: (...args) => warns.push(args.join(" ")), error: () => {}, log: () => {} };
  const hG = makeHarness((url, init) => { void url; void init; return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) }); });
  const treeH = await mount(hG);
  let pv400Threw = null;
  try { byAria(treeH, "button", "试听：回合完成时提醒 的音色")[0].props.onClick(); } catch (error) { pv400Threw = error; }
  await tick();
  check("反例·壳回 400（默认项没音色可试听）⇒ 不抛且出 warn（不静默）",
    pv400Threw === null && warns.some((line) => line.includes("试听未生效")), `threw=${pv400Threw} warns=${JSON.stringify(warns)}`);
  sandbox.console = hostConsole;

  /* E) 联动：开关全关也不灰化音色控件（可以先选音再开开关；试听只是播音，不属于"通知"） */
  hE.setValue({ enabled: false, notifyOnTurnCompletion: false, notifyOnBackground: false, notifyOnApproval: false, notifyOnUserQuestion: false, soundApproval: "Windows Notify Calendar.wav" });
  const treeG = hE.render().tree;
  const selG = byAria(treeG, "select", "需要我确认时提醒 音色")[0];
  const btnG = byAria(treeG, "button", "试听：需要我确认时提醒 的音色")[0];
  check("反例·总开关 + 分项开关都关 ⇒ 音色下拉不灰化", selG.props.disabled !== true, `disabled=${selG.props.disabled}`);
  check("反例·总开关 + 分项都关 ⇒ v2 新行的下拉也不灰化",
    byAria(treeG, "select", "后台/成员任务完成时提醒 音色")[0].props.disabled !== true,
    `disabled=${byAria(treeG, "select", "后台/成员任务完成时提醒 音色")[0].props.disabled}`);
  check("反例·总开关关 ⇒ 「试听」按钮照常可点", btnG.props.disabled !== true && typeof btnG.props.onClick === "function");
  check("回归·总开关关 ⇒ 四个分项开关仍禁用（含 v2 新增的后台/成员任务行）",
    collectNodes(treeG, (n) => n.props?.role === "switch").length === 5
      && collectNodes(treeG, (n) => n.props?.role === "switch").slice(1).every((s) => s.props.disabled === true),
    collectNodes(treeG, (n) => n.props?.role === "switch").map((s) => (s.props.disabled === true ? "禁" : "可")).join(","));

  /* F) 常态「自定义路径」入口（哨兵项）：壳在跑、候选 70 个，也要能指定自己目录里的 .wav */
  const SENTINEL = "__dshome_custom__";
  const hI = makeHarness(okFetch({ dir: "C:\\Windows\\Media", sounds: ["Alarm01.wav", "Windows Notify Calendar.wav"] }).fn);
  await mount(hI);
  hI.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "Windows Notify Calendar.wav" });
  const treeI0 = hI.render().tree;
  const selI0 = byAria(treeI0, "select", "需要我确认时提醒 音色")[0];
  check("自定义路径：常态下拉里常驻哨兵项「（自定义路径…）」（候选齐全时也有入口）",
    selI0.props.children.some((o) => o.props.value === SENTINEL && o.props.children === "（自定义路径…）"),
    JSON.stringify(selI0.props.children.map((o) => o.props.value)));
  check("自定义路径：常态下当前值命中候选 ⇒ 出输入框之前先不出（只在选中哨兵/存着自定义时出）",
    selI0.props.value === "Windows Notify Calendar.wav" && byAria(treeI0, "input", "需要我确认时提醒 自定义音色路径").length === 0,
    JSON.stringify(selI0.props.value));

  hI.writes.length = 0;
  selI0.props.onChange({ target: { value: SENTINEL } });
  check("自定义路径：只选哨兵不写回（还没输入内容，别把哨兵值当音色存进设置）", hI.writes.length === 0, JSON.stringify(hI.writes));
  const treeI1 = hI.render().tree;
  const inputI1 = byAria(treeI1, "input", "需要我确认时提醒 自定义音色路径")[0];
  check("自定义路径：选中哨兵 ⇒ 该行出现输入框（当前值是候选 ⇒ 预填留空）",
    inputI1 !== undefined && inputI1.props.value === "", JSON.stringify(inputI1?.props.value));

  hI.writes.length = 0;
  inputI1.props.onKeyDown({ key: "Enter", target: { value: "  D:\\sfx\\ding.wav  " } });
  check("自定义路径：输入 + 回车 ⇒ 写回 soundApproval 并去空格（字段名错位 ⇒ 静默失效）",
    JSON.stringify(hI.writes) === JSON.stringify([["soundApproval", "D:\\sfx\\ding.wav"]]), JSON.stringify(hI.writes));
  const inputI2 = byAria(hI.render().tree, "input", "需要我确认时提醒 自定义音色路径")[0];
  hI.writes.length = 0;
  inputI2.props.onBlur({ target: { value: "E:\\sfx\\bell.wav" } });
  check("自定义路径：失焦提交走同一条写回路径",
    JSON.stringify(hI.writes) === JSON.stringify([["soundApproval", "E:\\sfx\\bell.wav"]]), JSON.stringify(hI.writes));

  // 清空 + 失焦 ⇒ 写回空串 = 回到「默认，跟随系统」
  hI.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "D:\\sfx\\ding.wav" });
  const inputI3 = byAria(hI.render().tree, "input", "需要我确认时提醒 自定义音色路径")[0];
  hI.writes.length = 0;
  inputI3.props.onBlur({ target: { value: "   " } });
  check("自定义路径：清空 + 失焦 ⇒ 写回空串（= 回到「默认，跟随系统」）",
    JSON.stringify(hI.writes) === JSON.stringify([["soundApproval", ""]]), JSON.stringify(hI.writes));
  hI.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "" });   // 宿主确认写入 ⇒ 快照回流
  check("自定义路径：写回空串后收掉输入框（别停在「自定义」形态、值却是默认）",
    byAria(hI.render().tree, "input", "需要我确认时提醒 自定义音色路径").length === 0);

  /* G) 假显示回归：当前值 = 候选外的自定义路径 ⇒ 下拉必须显示成哨兵形态，不许显示成第一项「默认」 */
  const hJ = makeHarness(okFetch({ dir: "C:\\Windows\\Media", sounds: ["Alarm01.wav"] }).fn);
  await mount(hJ);
  hJ.setValue({ enabled: true, notifyOnUserQuestion: true, soundUserQuestion: "Z:\\my\\chime.wav" });
  const treeJ = hJ.render().tree;
  const selJ = byAria(treeJ, "select", "有问题等我回答时提醒 音色")[0];
  check("反例·当前值不在候选里 ⇒ 下拉选中哨兵项（显示成第一项「默认」= 假显示，必红）",
    selJ.props.value === SENTINEL, JSON.stringify(selJ.props.value));
  check("反例·同一行：哨兵选中 ⇒ 输入框预填那条自定义路径",
    byAria(treeJ, "input", "有问题等我回答时提醒 自定义音色路径")[0]?.props.value === "Z:\\my\\chime.wav",
    JSON.stringify(byAria(treeJ, "input", "有问题等我回答时提醒 自定义音色路径")[0]?.props.value));

  /* H) 状态机：哨兵 ↔ 候选 来回切，输入框要能收起（别成了关不掉的浮层） */
  const hK = makeHarness(okFetch({ dir: "C:\\Windows\\Media", sounds: ["Alarm01.wav"] }).fn);
  await mount(hK);
  hK.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "" });
  byAria(hK.render().tree, "select", "需要我确认时提醒 音色")[0].props.onChange({ target: { value: SENTINEL } });
  check("自定义路径：选哨兵 ⇒ 输入框展开",
    byAria(hK.render().tree, "input", "需要我确认时提醒 自定义音色路径").length === 1);
  const selK = byAria(hK.render().tree, "select", "需要我确认时提醒 音色")[0];
  hK.writes.length = 0;
  selK.props.onChange({ target: { value: "Alarm01.wav" } });
  check("自定义路径：从哨兵改回候选 ⇒ 输入框收起 + 写回该候选（哨兵值绝不落进设置）",
    JSON.stringify(hK.writes) === JSON.stringify([["soundApproval", "Alarm01.wav"]])
      && byAria(hK.render().tree, "input", "需要我确认时提醒 自定义音色路径").length === 0,
    `${JSON.stringify(hK.writes)} / input=${byAria(hK.render().tree, "input", "需要我确认时提醒 自定义音色路径").length}`);

  /* I) 边界：手输的值恰好等于某个候选名 ⇒ 写回后形态交回「当前值」（不留哨兵形态） */
  const hL = makeHarness(okFetch({ dir: "C:\\Windows\\Media", sounds: ["Alarm01.wav"] }).fn);
  await mount(hL);
  hL.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "" });
  byAria(hL.render().tree, "select", "需要我确认时提醒 音色")[0].props.onChange({ target: { value: SENTINEL } });
  const inputL = byAria(hL.render().tree, "input", "需要我确认时提醒 自定义音色路径")[0];
  hL.writes.length = 0;
  inputL.props.onBlur({ target: { value: "Alarm01.wav" } });
  hL.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "Alarm01.wav" });   // 宿主确认写入 ⇒ 快照回流
  const treeL = hL.render().tree;
  check("自定义路径：手输值恰是候选名 ⇒ 写回后按候选显示（不留哨兵形态、也不留输入框）",
    JSON.stringify(hL.writes) === JSON.stringify([["soundApproval", "Alarm01.wav"]])
      && byAria(treeL, "select", "需要我确认时提醒 音色")[0].props.value === "Alarm01.wav"
      && byAria(treeL, "input", "需要我确认时提醒 自定义音色路径").length === 0,
    `${JSON.stringify(hL.writes)} / select=${JSON.stringify(byAria(treeL, "select", "需要我确认时提醒 音色")[0].props.value)} / input=${byAria(treeL, "input", "需要我确认时提醒 自定义音色路径").length}`);

  /* J) 试听取「当前草稿值」（ref 同步镜像）：输入后**不回车**直接点试听 —— 不能听旧音色、也不能吞掉错路径 */
  const previewBody = (call) => { try { return JSON.parse(call.init.body); } catch { return null; } };
  const callsJ = [];
  const hN = makeHarness((url, init) => {
    callsJ.push({ url, init });
    return url.endsWith("/sounds")
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ dir: "C:\\Windows\\Media", sounds: ["Alarm01.wav", "Windows Notify Calendar.wav"] }) })
      : Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) });
  });
  await mount(hN);
  hN.setValue({ enabled: true, notifyOnApproval: true, soundApproval: "Windows Notify Calendar.wav" });
  byAria(hN.render().tree, "select", "需要我确认时提醒 音色")[0].props.onChange({ target: { value: SENTINEL } });
  byAria(hN.render().tree, "input", "需要我确认时提醒 自定义音色路径")[0].props.onChange({ target: { value: "D:\\sfx\\ding.wav" } });
  // 真实事件顺序：鼠标点按钮 ⇒ input 先 blur（提交），onClick 的闭包仍是旧值 ⇒ 只有 ref 拿得到新草稿
  byAria(hN.render().tree, "input", "需要我确认时提醒 自定义音色路径")[0].props.onBlur({ target: { value: "D:\\sfx\\ding.wav" } });
  callsJ.length = 0;
  byAria(hN.render().tree, "button", "试听：需要我确认时提醒 的音色")[0].props.onClick();
  const postedJ = callsJ.filter((c) => c.url.endsWith("/notify"));
  check("反例·输入后不回车直接点试听 ⇒ preview body 是新草稿值（拿旧持久值 = 假反馈，必红）",
    postedJ.length === 1 && previewBody(postedJ[0])?.sound === "D:\\sfx\\ding.wav",
    JSON.stringify(postedJ.map((c) => previewBody(c))));

  /* K) 降级态（壳不可达）同一条路：非受控 input 的 DOM 当前值也要进试听 */
  const callsK = [];
  const hO = makeHarness((url, init) => {
    callsK.push({ url, init });
    return url.endsWith("/sounds")
      ? Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:32123"))
      : Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) });
  });
  await mount(hO);
  byAria(hO.render().tree, "input", "回合完成时提醒 自定义音色路径")[0].props.onChange({ target: { value: "E:\\sfx\\bell.wav" } });   // 只输入，不回车
  callsK.length = 0;
  byAria(hO.render().tree, "button", "试听：回合完成时提醒 的音色")[0].props.onClick();
  const postedK = callsK.filter((c) => c.url.endsWith("/notify"));
  check("反例·降级态手输后直接点试听 ⇒ preview body 是刚输的路径",
    postedK.length === 1 && previewBody(postedK[0])?.sound === "E:\\sfx\\bell.wav",
    JSON.stringify(postedK.map((c) => previewBody(c))));

  delete sandbox.fetch;   // 收尾：别把 mock 留在 vm 里
}

/* ---------------- 官方右侧边栏（覆盖层）⇒ 缩略条自己避让 ----------------
 * 病根：官方右侧边栏 `.P3OORG_panel{position:absolute;right:0;z-index:10;transform:translate(100%)}`，
 * 打开时 `[data-sidebar-right-open]{transform:none}` 从右边滑出来 —— 它是**覆盖层**，z-index 10 > 缩略条 6，
 * 又不改布局（**没有 resize / ResizeObserver 回调**）⇒ 正好压在缩略条上。
 * 修法（冻结规格）：右边缘 = min(导轨右缘, 边栏左缘 − 8)；属性变化 + 过渡结束后主动重算；全屏态藏起来。
 * ⚠️ 按纪律**不动 z-index**（抬上去就压住边栏里的文件内容了），也**不认打包哈希类名**。 */
{
  const liveBox = body.children.at(-1);          // 最后一次 apply 装上的那条 = 当前实例（HMR/多次 apply 后仍成立）
  const liveWhy = () => win.__dshomeMinimapWhy;
  const liveRight = () => num(liveBox.style.right);
  const liveRightEdge = () => win.innerWidth - liveRight();

  check("只用语义属性（不认官方打包哈希类名 .P3OORG_*）", !/P3OORG_[A-Za-z]/.test(src));
  check("夹具：测的是**当前实例**的缩略条（拿错对象 ⇒ 下面全是假绿）",
    liveBox?.className === "dshome-minimap", `${liveBox?.className} / body 子元素 ${body.children.length} 个`);

  setBig();                                       // 干净的 200 块长会话（够一屏 ⇒ 该显示）
  scroller.scrollTop = 0;
  document_._scrollers = [scroller];

  const savedInner = win.innerWidth;
  const savedRailRect = rail.rect;
  // 真实场景：窗口 1440，导轨右缘 1440（导轨在覆盖层**底下**，边栏打开时它的 rect 一点不动）
  win.innerWidth = 1440;
  rail.rect = { top: 100, height: 400, width: 28, left: 1412, right: 1440, bottom: 500 };
  sidebarEl.rect = { top: 0, left: 1280, right: 1440, bottom: 900, width: 160, height: 900 };
  sidebarEl.attrs["data-sidebar-right-panel"] = "push";
  delete sidebarEl.attrs["data-sidebar-right-open"];

  // (b) 没有边栏 ⇒ 与旧公式**逐字一致**：贴导轨右缘
  syncNow();
  check("(b) 边栏没开 ⇒ 贴导轨右缘（1440 − 导轨右缘 1440 = 0px），与旧实现逐字一致",
    liveRight() === 0 && liveRightEdge() === 1440, `right=${liveBox.style.right} 右边缘=${liveRightEdge()} / ${liveWhy()}`);

  // (b2) 老配置（窗口 1280 / 导轨右缘 1200 ⇒ 80px）：读数与既有实现一致
  win.innerWidth = 1280;
  rail.rect = { top: 100, height: 400, width: 28, left: 1172, right: 1200, bottom: 500 };
  syncNow();
  check("(b2) 老配置读数不变（1280 − 1200 = 80px）", liveRight() === 80, `right=${liveBox.style.right}`);
  win.innerWidth = 1440;
  rail.rect = { top: 100, height: 400, width: 28, left: 1412, right: 1440, bottom: 500 };
  syncNow();

  // (b3) 没有官方导轨 ⇒ 兜底贴窗口右缘 8px（既有那条「仍然显示」的语义不许被边栏逻辑改掉）
  const savedRail = document_._rail;
  document_._rail = null;
  syncNow();
  const noRailRight = liveRight();
  const noRailDisplay = liveBox.style.display;
  document_._rail = savedRail;
  syncNow();
  check("(b3) 没有官方导轨 ⇒ 兜底贴窗口右缘 8px（边栏逻辑没改变它）",
    noRailRight === 8 && noRailDisplay === "block", `right=${noRailRight}px / display=${noRailDisplay}`);

  // (a) 边栏打开（左缘 1280、窗口 1440）⇒ 右边缘 = 1272 = 1280 − 8，不被压住
  sidebarEl.attrs["data-sidebar-right-open"] = "";
  sidebarEl.rect = { top: 0, left: 1280, right: 1440, bottom: 900, width: 160, height: 900 };
  syncNow();
  check("(a) 边栏打开(左缘 1280 / 窗口 1440) ⇒ 缩略条右边缘 = 1272（= 边栏左缘 − 8，不被压住）",
    liveBox.style.right === "168px" && liveRightEdge() === 1272 && liveRightEdge() <= 1280 - 8,
    `right=${liveBox.style.right} 右边缘=${liveRightEdge()} / ${liveWhy()}`);

  // (d) 反例（**同一条判据**，只把"避让输入"拿掉）：面板宽 0（= 不可见）⇒ 不避让 ⇒ 回到被压住的旧读数
  const savedSidebarRect = sidebarEl.rect;
  sidebarEl.rect = { ...sidebarEl.rect, width: 0 };
  syncNow();
  const blindRight = liveBox.style.right;
  const blindEdge = liveRightEdge();
  sidebarEl.rect = savedSidebarRect;
  syncNow();
  check("(d) 反例·边栏不可见（宽 0）⇒ 不避让（读数 ≠ 168px、右边缘 1440 > 1272 = 正是被压住的样子）",
    blindRight !== "168px" && blindEdge > 1280 - 8,
    `宽 0 时 right=${blindRight} 右边缘=${blindEdge}（避让时 168px / 1272）`);

  // (c) 全屏态：position:fixed;inset:0 ⇒ 缩略条无处可放，藏起来；退出全屏 ⇒ 恢复
  sidebarEl.attrs["data-sidebar-right-panel"] = "fullscreen";
  syncNow();
  const fsDisplay = liveBox.style.display;
  const fsWhy = liveWhy();
  sidebarEl.attrs["data-sidebar-right-panel"] = "push";
  syncNow();
  check("(c) 边栏全屏 ⇒ display:none；退出全屏 ⇒ 恢复显示（且回到避让位）",
    fsDisplay === "none" && liveBox.style.display === "block" && liveRightEdge() === 1272,
    `全屏=${fsDisplay}(${fsWhy}) / 退出后=${liveBox.style.display} 右边缘=${liveRightEdge()}`);

  // (2) 属性观察真的挂上了（覆盖层没有 resize/RO 回调，只能自己听属性）
  const sidebarObs = mutationObservers
    .filter((o) => o.records.some((r) => Array.isArray(r.options?.attributeFilter) && r.options.attributeFilter.includes("data-sidebar-right-open")))
    .at(-1);
  const obsRec = sidebarObs?.records.at(-1);
  check("(2) 对 document.body 挂了属性观察（attributeFilter 两个属性 + subtree:true）",
    obsRec?.target === body && obsRec.options.subtree === true && obsRec.options.attributes === true
      && obsRec.options.attributeFilter.includes("data-sidebar-right-open")
      && obsRec.options.attributeFilter.includes("data-sidebar-right-panel"),
    JSON.stringify(obsRec?.options ?? null));

  // (2b) 动画中途 rect 还在屏外 ⇒ 属性变那一刻算不出最终位置，**过渡结束后必须再算一次**
  //      （这就是「不能只靠 resizeObserver」的那半条：属性变 = 动画起步，不是终点）
  delete sidebarEl.attrs["data-sidebar-right-open"];
  syncNow();
  sidebarEl.attrs["data-sidebar-right-open"] = "";
  sidebarEl.rect = { top: 0, left: 1440, right: 1600, bottom: 900, width: 160, height: 900 };   // 还停在屏幕外 translate(100%)
  sidebarObs?.cb();
  const duringAnim = liveRightEdge();
  sidebarEl.rect = { top: 0, left: 1280, right: 1440, bottom: 900, width: 160, height: 900 };   // 动画结束：最终位置
  flushTimers();                                                                                // 延迟兜底那一跳
  check("(2b) 过渡结束后的重算拿到最终位置（不靠 transitionend：reduced-motion 下它永远不来）",
    duringAnim !== 1272 && liveRightEdge() === 1272, `动画中 右边缘=${duringAnim} → 过渡结束后=${liveRightEdge()}`);

  // (5) 安全退化：环境没有 MutationObserver ⇒ 不抛；靠 250ms 轮询仍然算对（行为同现在）
  const savedMO = sandbox.MutationObserver;
  delete sandbox.MutationObserver;
  let degThrew = null;
  let degBox = null;
  try {
    mod.apply({ get: () => undefined });   // 老环境里再装一次
    degBox = body.children.at(-1);
    intervals.at(-1).fn();                 // 新实例的 sync 一跳
  } catch (error) { degThrew = error; }
  check("(5) 反例·环境不支持 MutationObserver ⇒ 不抛，缩略条照常显示且仍会避让（只是没有主动重算）",
    degThrew === null && degBox?.style.display === "block" && num(degBox.style.right) === 168,
    `threw=${degThrew === null ? "null" : String(degThrew)} / display=${degBox?.style.display} / right=${degBox?.style.right}`);
  sandbox.MutationObserver = savedMO;

  // 收尾：夹具还原（后面的用例/重跑不受影响）
  delete sidebarEl.attrs["data-sidebar-right-open"];
  sidebarEl.attrs["data-sidebar-right-panel"] = "push";
  sidebarEl.rect = savedSidebarRect;
  win.innerWidth = savedInner;
  rail.rect = savedRailRect;
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
