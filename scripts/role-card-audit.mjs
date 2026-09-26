#!/usr/bin/env node
/**
 * role-card-audit.mjs — 角色卡池体检器（**只读**：只打印报告，不写仓库里任何文件）
 *
 * 为什么：`mind/L1/Ritual.md` §四/§二 已写「角色卡池体检」（重影 / 一次性已交付 / id 不可读 / 正文幽灵引用），
 *   但判据原本只有人工眼看 `role_card_list` ⇒ 按 verify-integrity 判据③（**设备侧可自检**）补机器件。
 *
 * 真源：`packages/dshome/lib/host/agent-roles.js` 的 `discoverCards` / `parseCard` / `cardTextHash`
 *   （**照用现成解析，不自己重写**；卡正文一律来自 `parseCard().card.body`）。
 *
 * 体检面：`<DSH_HOME>\mind-private\L2\agents\`（DSH_HOME 取环境变量，缺省＝本文件上一级＝仓库根）
 *        ＋ `process.cwd()\.agent-roles\`（调用者的工作区）
 *        两处各自的 `.retired\` **只统计数量**，不做其它判断。
 *
 * 五类信号（每条都带卡 id / 中文名 / 证据）：
 *   [1] id 不可读       ：id 匹配 `^inline-`（内联建卡时中文名折出来的 hex）
 *   [2] 疑似同岗位重影   ：去掉 `id:` / `name:` 行后正文**前 60 字逐字相同**（判据写死：无相似度/模糊匹配算法）
 *   [3] 疑似一次性已交付 ：正文出现「只写/只改/只动/只输出/只落/只交付/只生成 <某个具体文件>」这类硬绑定
 *                          ⇒ **只提示、不判死**，请人工复核
 *   [4] 正文幽灵引用     ：正文里出现的仓库内路径（形如 `xx\yy.md` / `xx/yy.md`，含反引号包裹的先剥反引号）
 *                          在**多个解析根**（`process.cwd()` / 仓库根 REPO / `DSH_HOME`，去重后）下逐一
 *                          `existsSync`，**全都找不到**才判幽灵（并在证据里注明按哪些根解析）
 *   [5] 同 id 影子卡     ：私有目录与工作区目录**各自独立解析**（仍复用 `parseCard`），两边都存在的同一个 id
 *                          ⇒ 工作区卡覆盖私有卡，被遮蔽的私有那张会长期无人看管而腐烂
 *   报告**第一行**恒定打出「坏卡 N 张（下列各类信号覆盖不到）」（坏卡解析不了 ⇒ 上面几类覆盖不到它，不许静默漏）。
 *   末尾打印 `RESULT: N signal(s)`（各类合计）；**全 0 也打印并 exit 0**（不许静默）。
 *
 * 【读数随 cwd 变 —— 必须知道的口径】（2026-09-26 Lead 裁定后实测）：判据 [4] 的解析根含 `process.cwd()`，
 *   故**同一台机器、同一个卡池，换个 cwd 跑会得到不同的信号数**（实测：在链潮项目工作区跑 ⇒ 那 5 条跨项目
 *   引用全部命中、`RESULT: 7`；`cd E:\DSHOME` 再跑 ⇒ 解析根只剩仓库根一根、同样 5 条又判幽灵、`RESULT: 12`）。
 *   ⇒ **体检要在相关项目的工作区里跑**（结论的适用范围＝报告里那行「解析根」）；跨项目引用的卡本来就只能在
 *   对应项目的 cwd 下判准。这是多根解析的必然结果，不是 bug。
 *
 * 【已删判据 · 诚实留痕】原判据①「`cardTextHash` 相同 ⇒ 重影」**已删除**（Lead 裁定，2026-09-26），理由：
 *   它在真源 `discoverCards` 语义下**不可达**（＝零咬合力的死判据）——`discoverCards` 按 id 去重
 *   （同 id 工作区覆盖私有），而 `id:` 行本身就在卡文本里 ⇒ 两张卡的整卡文本**不可能相同**；
 *   同 id 的那张根本不进 `cards` 列表（只有**同源重复**才进 `broken`）。
 *   换成有咬合力的 `[5] 同 id 影子卡`（同 id 跨目录遮蔽，正是原判据想抓而抓不到的那类）。
 *   注：`cardTextHash` 仍被本脚本用来给 `[5]` 标注「两侧文本一致 / 已分叉」，不再是判据本身。
 *
 * 无输入即响亮失败：两个卡目录都不存在 ⇒ 明确报错 + exit 1，绝不许静默报「0 个问题」。
 *
 * 用法：
 *   node scripts/role-card-audit.mjs              # 体检本机卡池
 *   node scripts/role-card-audit.mjs --selftest   # 反例自检（临时 DSH_HOME + 临时 cwd，跑完清干净）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), '..'); // scripts/ → 仓库根
const MOD_PATH = join(REPO, 'packages', 'dshome', 'lib', 'host', 'agent-roles.js');
const DEFAULT_HOME = REPO; // DSH_HOME 缺省＝仓库根

/** 重影判据硬阈值：去掉 id:/name: 行后正文前 60 字逐字相同（写死，不许调）。 */
const SHADOW_PREFIX = 60;

/**
 * 判据③硬绑定句式（**只提示**）。`只X` 后 0~10 字内跟一个"具体文件"才算命中。
 *
 * 为什么拆成两条正则 + 掩码：最初写成单条 `(?:`…`|裸词)` 交替，**反引号分支会被裸词分支抢先吞掉**
 *   —— 正文「**只改一个文件**：`mind-private\L1\Learn.md`」里裸词分支在"零间隔"就匹配到"一个文件**："
 *   （被"非具体文件"过滤掉），而匹配已消费掉整段文本 ⇒ 真正的反引号路径**漏报**。
 *   先扫反引号分支并把命中段掩成空格，再扫裸词分支，两种写法都不漏。
 */
const DELIVER_BACKTICK_RE = /只(?:写|改|动|输出|落|交付|生成)[^\n`]{0,10}?`([^`\n]+)`/g;
const DELIVER_BARE_RE = /只(?:写|改|动|输出|落|交付|生成)[^\n]{0,10}?([^\s`，。；、）)】」]+)/g;

// ─────────────────────────────────────────────────────────────────────────────
// 判据实现
// ─────────────────────────────────────────────────────────────────────────────

/** 去掉 `id:` / `name:` 行（判据②的前置）。逐字比较，不做任何归一化。 */
function stripIdName(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(id|name)\s*:/.test(line))
    .join('\n')
    .trim();
}

/** 首个不同字符的下标（完全相同 ⇒ 返回较短串长度）。 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

/** 判据③：找「只写 <某个具体文件>」这类硬绑定（返回 token 与命中原句）。 */
function findDeliverBindings(body) {
  const text = String(body ?? '');
  const out = [];
  const seen = new Set();
  const push = (token, line) => {
    const tok = String(token ?? '').trim();
    if (tok === '') return;
    // 必须"像某个具体文件"：带路径分隔符 或 有扩展名；否则（"只写结论"/"只写普通"）不算。
    if (!/[\\/]/.test(tok) && !/\.[A-Za-z0-9]{1,6}$/.test(tok)) return;
    if (seen.has(tok)) return;
    seen.add(tok);
    out.push({ token: tok, line });
  };
  const masked = text.replace(DELIVER_BACKTICK_RE, (m, tok) => {
    push(tok, m.trim());
    return ' '.repeat(m.length); // 掩掉，避免裸词分支重复命中同一处
  });
  for (const m of masked.matchAll(DELIVER_BARE_RE)) push(m[1], m[0].trim());
  return out;
}

/** 判据④：从正文里抽仓库内路径候选（先剥反引号）。 */
function findRepoPathTokens(body) {
  const plain = String(body ?? '').replace(/`/g, ''); // 反引号包裹的先剥掉
  const tokens = plain.split(/[\s，。；：、！？（）()\[\]{}"'*「」【】<>《》,;:!?]+/);
  const out = [];
  const seen = new Set();
  for (const rawTok of tokens) {
    // 剥掉挂在路径上的标点/破折号前缀（如正文里的「**——`tools\x.ps1`」剥成 `tools\x.ps1`）
    const tok = rawTok.replace(/^[.,;:!?#*—–\-•·]+/, '').replace(/[.,;:!?#*—–•·]+$/, '');
    if (tok === '') continue;
    if (/:\\?\/\//.test(tok)) continue; // URL 不算
    if (/^[A-Za-z]:[\\/]/.test(tok)) continue; // 盘符绝对路径不算（判据口径＝相对仓库根）
    if (tok.startsWith('\\') || tok.startsWith('/')) continue; // 根相对/UNC 不算
    if (!/[\\/]/.test(tok)) continue; // 必须有分隔符（形如 xx\yy.md）
    if (!/[\\/][^\\/]*\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(tok)) continue; // 末段要有文件扩展名
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/** `.retired\` 只统计文件数量；目录不存在 ⇒ null（报告里显示 `—`）。 */
function retiredCount(dir) {
  const retired = join(dir, '.retired');
  if (!existsSync(retired)) return null;
  try {
    return readdirSync(retired, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 体检主体（纯函数：只读盘 + 返回报告文本，不写任何文件）
// ─────────────────────────────────────────────────────────────────────────────

function audit({ dshHome, cwd, mod }) {
  const privateDir = join(dshHome, 'mind-private', 'L2', 'agents');
  const workspaceDir = join(cwd, '.agent-roles');
  const exPrivate = existsSync(privateDir);
  const exWorkspace = existsSync(workspaceDir);

  // ── 无输入即响亮失败 ──
  if (!exPrivate && !exWorkspace) {
    return {
      fatal: `没有卡目录，无从体检：私有卡目录「${privateDir}」与工作区卡目录「${workspaceDir}」都不存在`
        + `（DSH_HOME=${dshHome}，cwd=${cwd}）。请先确认 DSH_HOME 或 cwd 是否给对。`,
      signals: [],
      text: '',
    };
  }

  // ── 判据[4] 的多解析根：cwd → REPO → DSH_HOME（去重；卡正文里的相对路径可能相对调用者项目或仓库根）──
  const roots = [];
  for (const cand of [cwd, REPO, dshHome]) {
    const abs = resolve(String(cand || '.'));
    if (abs === '') continue;
    if (!roots.some((r) => r.toLowerCase() === abs.toLowerCase())) roots.push(abs);
  }

  const disc = mod.discoverCards({ privateDir, workspaceDir });
  const broken = [...disc.broken];
  const cards = [];
  for (const found of disc.cards) {
    let raw;
    try {
      raw = readFileSync(found.sourcePath, 'utf8');
    } catch (error) {
      broken.push({ file: found.fileName, sourcePath: found.sourcePath, source: found.source, reason: `回读失败：${error && error.message ? error.message : error}` });
      continue;
    }
    const parsed = mod.parseCard(raw, found.sourcePath); // 真源解析：正文一律取它给的 body
    if (!parsed.ok) {
      broken.push({ file: found.fileName, sourcePath: found.sourcePath, source: found.source, reason: parsed.reason });
      continue;
    }
    cards.push({
      ...parsed.card,
      source: found.source,
      overridesPrivate: !!found.overridesPrivate,
      hash: mod.cardTextHash(raw),
      body: parsed.card.body,
    });
  }

  const signals = [];
  const add = (type, line) => signals.push({ type, line });

  // ── [1] id 不可读 ──
  let n1 = 0;
  for (const card of cards) {
    if (!/^inline-/.test(card.id)) continue;
    n1 += 1;
    add(1, `[1] id不可读   id=${card.id}  名=${card.name}  证据=id 匹配 ^inline-（内联建卡时中文名折成的 hex，人读不出来）`);
  }

  // ── [2] 疑似同岗位重影（判据只剩"去 id:/name: 行后正文前 60 字逐字相同"一条，写死）──
  let n2 = 0;
  const stripped = new Map(cards.map((c) => [c.id, stripIdName(c.body)]));
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i];
      const b = cards[j];
      const ba = stripped.get(a.id);
      const bb = stripped.get(b.id);
      if (ba.slice(0, SHADOW_PREFIX) === '' || ba.slice(0, SHADOW_PREFIX) !== bb.slice(0, SHADOW_PREFIX)) continue;
      const d = firstDiff(ba, bb);
      const wa = ba.slice(d, d + 16);
      const wb = bb.slice(d, d + 16);
      const detail = `去 id:/name: 行后正文前 ${SHADOW_PREFIX} 字逐字相同（「${ba.slice(0, 24)}…」）；`
        + `首个差异在第 ${d + 1} 字：A=「${wa}」 B=「${wb}」（正文 ${ba.length} vs ${bb.length} 字）`;
      n2 += 1;
      add(2, `[2] 疑似重影   id=${a.id}（${a.name}） ↔ id=${b.id}（${b.name}）  证据=${detail}`
        + `  【源 ${a.source}=${a.fileName} / ${b.source}=${b.fileName}】`);
    }
  }

  // ── [3] 疑似一次性已交付（只提示）──
  let n3 = 0;
  for (const card of cards) {
    for (const hit of findDeliverBindings(card.body)) {
      n3 += 1;
      add(3, `[3] 一次性交付 id=${card.id}  名=${card.name}  证据=正文命中「${hit.line}」→ 硬绑定到具体文件「${hit.token}」，`
        + `疑似一次性任务卡（**只提示不判死**，请人工复核是否该退休）`);
    }
  }

  // ── [4] 正文幽灵引用（多根解析：**全都找不到**才判幽灵）──
  let n4 = 0;
  let refChecked = 0;
  let refExisting = 0;
  const ghostSeen = new Set();
  for (const card of cards) {
    for (const tok of findRepoPathTokens(card.body)) {
      refChecked += 1;
      const rel = tok.replace(/[\\/]+/g, sep);
      const tried = roots.map((root) => resolve(root, rel));
      if (tried.some((abs) => existsSync(abs))) {
        refExisting += 1;
        continue;
      }
      const key = `${card.id}::${tok}`;
      if (ghostSeen.has(key)) continue;
      ghostSeen.add(key);
      n4 += 1;
      add(4, `[4] 幽灵引用   id=${card.id}  名=${card.name}  证据=正文引用「${tok}」→ 按根逐一 existsSync（${roots.join('、')}）`
        + `**全都找不到**（试过：${tried.join('、')}）`);
    }
  }

  // ── [5] 同 id 影子卡（私有 vs 工作区**各自独立解析**后取交集）──
  // 为什么要独立各扫一遍：联合 `discoverCards` 会把同 id 的私有卡**去重掉**（见脚本头「已删判据」注释），
  //   于是"被遮蔽的私有卡"在联合视图里根本不存在 ⇒ 只有按目录各扫一次才看得见它。
  let n5 = 0;
  if (exPrivate && exWorkspace) {
    const priv = mod.discoverCards({ privateDir, workspaceDir: '' });
    const ws = mod.discoverCards({ privateDir: '', workspaceDir });
    const wsById = new Map(ws.cards.map((c) => [c.id, c]));
    const hashOf = (c) => { try { return mod.cardTextHash(readFileSync(c.sourcePath, 'utf8')); } catch { return '读不到'; } };
    for (const p of priv.cards) {
      const w = wsById.get(p.id);
      if (!w) continue;
      const hp = hashOf(p);
      const hw = hashOf(w);
      const sideText = hp !== '读不到' && hp === hw
        ? `两侧整卡文本完全一致（hash ${hp}，同一份拷贝）`
        : `两侧整卡文本不一致（私有 hash ${hp} / 工作区 hash ${hw}）⇒ **已分叉**`;
      n5 += 1;
      add(5, `[5] 同id影子卡 id=${p.id}（私有名=${p.name} / 工作区名=${w.name}）`
        + `  证据=私有 ${p.fileName} 与工作区 ${w.fileName} **同 id**；工作区卡覆盖私有卡（同 id 后者胜）`
        + `⇒ 私有那张被长期遮蔽、无人看管会腐烂；${sideText}`);
    }
  }

  // ── 报告 ──
  // **第一行**恒定打坏卡徽标（Lead 裁定）：坏卡解析不了 ⇒ 下面各类信号覆盖不到它，不许静默漏。
  const lines = [`坏卡 ${broken.length} 张（下列各类信号覆盖不到）`];
  const rcPrivate = retiredCount(privateDir);
  const rcWorkspace = retiredCount(workspaceDir);
  const cnt = (src) => cards.filter((c) => c.source === src).length;
  lines.push('== 角色卡池体检（只读）==');
  lines.push(`DSH_HOME     : ${dshHome}`);
  lines.push(`仓库根(REPO) : ${REPO}`);
  lines.push(`解析根[4]    : ${roots.join('、')}（幽灵引用＝在这些根下**全都找不到**才判）`);
  lines.push(`私有卡目录   : ${privateDir}  [${exPrivate ? '存在' : '不存在'}]${exPrivate ? `  .retired: ${rcPrivate === null ? '无该目录' : `${rcPrivate} 个`}` : ''}`);
  lines.push(`工作区卡目录 : ${workspaceDir}  [${exWorkspace ? '存在' : '不存在'}]${exWorkspace ? `  .retired: ${rcWorkspace === null ? '无该目录' : `${rcWorkspace} 个`}` : ''}`);
  lines.push(`卡总数       : ${cards.length}（私有 ${cnt('private')} / 工作区 ${cnt('workspace')}；同 id 工作区覆盖私有）`);
  if (broken.length > 0) {
    lines.push(`坏卡明细（${broken.length} 张，下面各类信号**覆盖不到**它们，必须人工看）：`);
    for (const b of broken) lines.push(`    ! ${b.source}/${b.file}  ${b.reason}`);
  }
  lines.push('');
  const section = (n, title, count, note = '') => {
    lines.push(`-- (${n}) ${title} —— ${count} 条${note}`);
    const own = signals.filter((s) => s.type === n);
    if (own.length === 0) lines.push('     （无）');
    else for (const s of own) lines.push(`   ${s.line}`);
    lines.push('');
  };
  section(1, 'id 不可读（^inline-）', n1);
  section(2, `疑似同岗位重影（去 id:/name: 行后正文前 ${SHADOW_PREFIX} 字逐字相同）`, n2);
  section(3, '疑似一次性已交付（只提示，不判死）', n3);
  section(4, '正文幽灵引用（多根解析，全都找不到才判）', n4, `（已核引用 ${refChecked} 个，其中找到 ${refExisting} 个）`);
  section(5, '同 id 影子卡（私有 vs 工作区各自独立解析；同 id ⇒ 私有被遮蔽）', n5);
  lines.push(`RESULT: ${signals.length} signal(s)`);

  return { fatal: '', signals, text: lines.join('\n'), cards, broken };
}

// ─────────────────────────────────────────────────────────────────────────────
// 反例自检：临时 DSH_HOME + 临时 cwd 造合成卡，逐条证明判据有咬合力
// ─────────────────────────────────────────────────────────────────────────────

function cardText(id, name, body) {
  return ['---', `id: ${id}`, `name: ${name}`, 'tools:', '  allow:', '    - read', '---', '', body, ''].join('\n');
}

async function selftest() {
  const TMP = join(tmpdir(), `role-card-audit-selftest-${process.pid}-${Date.now()}`);
  let pass = 0;
  let fail = 0;
  const check = (label, cond, extra = '') => {
    if (cond) { pass += 1; console.log(`  PASS  ${label}`); } else { fail += 1; console.log(`  FAIL  ${label}  ${extra}`); }
  };
  const writeCard = (home, ws, fileName, text) => {
    const dir = join(home, 'mind-private', 'L2', 'agents');
    mkdirSync(dir, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(dir, fileName), text, 'utf8');
  };
  const writeWsCard = (ws, fileName, text) => {
    const dir = join(ws, '.agent-roles');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), text, 'utf8');
  };
  // 子进程真跑本脚本本体（真退出码 + 真报告文本）
  const run = (home, ws) => spawnSync(process.execPath, [SELF], {
    encoding: 'utf8',
    cwd: ws,
    env: { ...process.env, DSH_HOME: home },
  });
  const s4 = (out) => out.split('\n').filter((l) => l.trimStart().startsWith('[4]'));

  try {
    console.log(`[selftest] 临时区＝${TMP}`);
    console.log(`[selftest] 被测脚本＝${SELF}`);

    // ① 一张 id=inline-abc123 的卡 ⇒ 报第 1 类
    console.log('== ①  id 不可读（inline-abc123）==');
    {
      const home = join(TMP, 'h1');
      const ws = join(TMP, 'w1');
      writeCard(home, ws, 'inline-abc123.md', cardText('inline-abc123', '内联甲', '你是内联建出来的一张卡，只做甲这一件事。'));
      const r = run(home, ws);
      check('退出码 0', r.status === 0, `status=${r.status} ${r.stderr}`);
      check('报第 1 类且带 id/中文名/证据', /\[1\] id不可读\s+id=inline-abc123\s+名=内联甲/.test(r.stdout), r.stdout.split('\n').filter((l) => l.includes('[1]')).join(' | '));
      check('总信号数=1 ⇒ RESULT: 1 signal(s)', /RESULT: 1 signal\(s\)/.test(r.stdout), r.stdout.trim().split('\n').slice(-1)[0]);
    }

    // ② 一张与另一张正文相同（只改 id/name）⇒ 报第 2 类
    console.log('== ②  同岗位重影（只改 id/name，正文逐字相同）==');
    {
      const home = join(TMP, 'h2');
      const ws = join(TMP, 'w2');
      const body = '你是同一个岗位的卡：按同一份规则做同一件事，产出同一份东西。';
      writeCard(home, ws, 'ca.md', cardText('ca', '甲岗', body));
      writeCard(home, ws, 'cb.md', cardText('cb', '乙岗', body));
      const r = run(home, ws);
      check('退出码 0', r.status === 0, `status=${r.status} ${r.stderr}`);
      const line = r.stdout.split('\n').find((l) => l.includes('[2] 疑似重影')) || '';
      check('报第 2 类且两张 id/中文名都在', /id=ca（甲岗）/.test(line) && /id=cb（乙岗）/.test(line), line);
      check('判据（去 id:/name: 行后前 60 字逐字相同）真触发', /去 id:\/name: 行后正文前 60 字逐字相同/.test(line), line);
      check('总信号数=1 ⇒ RESULT: 1 signal(s)', /RESULT: 1 signal\(s\)/.test(r.stdout), r.stdout.trim().split('\n').slice(-1)[0]);
    }

    // ③ 正文引不存在的仓库路径 ⇒ 报第 4 类；反引号要剥掉；存在的路径**不许**报（正对照）
    console.log('== ③  正文幽灵引用（含反引号 + 存在路径的正对照）==');
    {
      const home = join(TMP, 'h3');
      const ws = join(TMP, 'w3');
      writeCard(home, ws, 'ghost.md', cardText('ghost', '幽灵卡', '写法照 `不存在的目录/不存在.md` 抄。'));
      writeCard(home, ws, 'ctrl.md', cardText('ctrl', '对照卡', '实现见 `packages/dshome/lib/host/agent-roles.js`。'));
      const r = run(home, ws);
      check('退出码 0', r.status === 0, `status=${r.status} ${r.stderr}`);
      const ghosts = s4(r.stdout);
      check('反引号剥掉后仍认得出路径，且只报 1 条幽灵', ghosts.length === 1 && ghosts[0].includes('不存在的目录/不存在.md'), ghosts.join(' | '));
      check('幽灵条目带 id/中文名/证据', /id=ghost\s+名=幽灵卡/.test(ghosts[0] || '') && /不存在/.test(ghosts[0] || ''), ghosts[0]);
      check('正对照：存在的路径**不许**报幽灵（agent-roles.js 零命中）', !r.stdout.includes('幽灵引用') || !s4(r.stdout).some((l) => l.includes('agent-roles.js')), s4(r.stdout).join(' | '));
      check('已核引用计数=2（证明真做了 existsSync，不是空转）', /已核引用 2 个，其中找到 1 个/.test(r.stdout), r.stdout.split('\n').find((l) => l.includes('已核引用')) || '');
      check('总信号数=1 ⇒ RESULT: 1 signal(s)', /RESULT: 1 signal\(s\)/.test(r.stdout), r.stdout.trim().split('\n').slice(-1)[0]);
    }

    // ④ 正文写「只写 `03_系统\卡表.md`」⇒ 报第 3 类
    console.log('== ④  一次性已交付硬绑定（只写 `<具体文件>`）==');
    {
      const home = join(TMP, 'h4');
      const ws = join(TMP, 'w4');
      writeCard(home, ws, 'deliver.md', cardText('deliver', '交付卡', '本阶段**只写 `03_系统\\卡表.md`**，别的文件一律不动。'));
      const r = run(home, ws);
      check('退出码 0', r.status === 0, `status=${r.status} ${r.stderr}`);
      const line = r.stdout.split('\n').find((l) => l.includes('[3] 一次性交付')) || '';
      check('报第 3 类且带 id/中文名/命中原句', /id=deliver\s+名=交付卡/.test(line) && /03_系统\\卡表\.md/.test(line), line);
      check('标注「只提示不判死」', /只提示不判死/.test(line), line);
      // 同一张卡还引了「03_系统\卡表.md」，它相对仓库根不存在 ⇒ 第 4 类同时命中（预期 2 条）
      check('总信号数=2（第 3 类 + 该路径同时是幽灵）⇒ RESULT: 2 signal(s)', /RESULT: 2 signal\(s\)/.test(r.stdout), r.stdout.trim().split('\n').slice(-1)[0]);
      // 反例：只是"只写普通/稀有"这种非文件硬绑定，不许报
      const home2 = join(TMP, 'h4b');
      const ws2 = join(TMP, 'w4b');
      writeCard(home2, ws2, 'nobind.md', cardText('nobind', '非绑定卡', '本阶段只写普通 / 稀有；史诗等裁定后再派。'));
      const r2 = run(home2, ws2);
      check('反例（只写"普通/稀有"这种非具体文件）不许报第 3 类', !r2.stdout.includes('[3] 一次性交付'), r2.stdout.split('\n').filter((l) => l.includes('[3]')).join(' | '));
      check('反例总信号数=0 ⇒ RESULT: 0 signal(s)', /RESULT: 0 signal\(s\)/.test(r2.stdout), r2.stdout.trim().split('\n').slice(-1)[0]);
      // 反例（真跑发现的漏报）：反引号路径前**夹了说明字**，不许被"裸词分支"吞掉
      const home3 = join(TMP, 'h4c');
      const ws3 = join(TMP, 'w4c');
      writeCard(home3, ws3, 'filler.md', cardText('filler', '夹字卡', '**只改一个文件**：`mind-private\\L1\\Learn.md`。其它文件一律不读不写。'));
      const r3 = run(home3, ws3);
      const line3 = r3.stdout.split('\n').find((l) => l.includes('[3] 一次性交付')) || '';
      check('④c 夹字的反引号路径仍被认出（gap 内说明字不许吞掉命中）', /只改一个文件\*\*：`mind-private\\L1\\Learn\.md`/.test(line3), line3);
    }

    // ⑤ 清空临时目录后再跑 ⇒ 0 signal(s)、exit 0（不许静默，也不许假报）
    console.log('== ⑤  空卡池 ⇒ 0 signal(s) 且 exit 0 ==');
    {
      const home = join(TMP, 'h5');
      const ws = join(TMP, 'w5');
      mkdirSync(join(home, 'mind-private', 'L2', 'agents'), { recursive: true });
      mkdirSync(join(ws, '.agent-roles'), { recursive: true });
      const r = run(home, ws);
      check('退出码 0', r.status === 0, `status=${r.status} ${r.stderr}`);
      check('卡总数 0', /卡总数\s+: 0/.test(r.stdout), r.stdout.split('\n').find((l) => l.includes('卡总数')) || '');
      check('响亮打印 RESULT: 0 signal(s)（不静默）', /RESULT: 0 signal\(s\)/.test(r.stdout), r.stdout.trim().split('\n').slice(-1)[0]);
    }

    // ⑥ 两个卡目录都不存在 ⇒ 报错 + exit 1
    console.log('== ⑥  无输入 ⇒ 响亮失败 exit 1 ==');
    {
      const home = join(TMP, 'h6');
      const ws = join(TMP, 'w6');
      mkdirSync(home, { recursive: true });
      mkdirSync(ws, { recursive: true });
      const r = run(home, ws);
      check('退出码 1', r.status === 1, `status=${r.status}`);
      const all = `${r.stdout}\n${r.stderr}`;
      check('明确报「没有卡目录，无从体检」', /没有卡目录，无从体检/.test(all), all.trim().split('\n').slice(-2).join(' | '));
      check('绝不静默报 0 信号', !/RESULT: 0 signal\(s\)/.test(r.stdout), r.stdout);
    }

    // ⑦ 同 id 影子卡：私有 + 工作区**各放一张同 id 卡** ⇒ 必报；只在一侧 ⇒ 不报
    console.log('== ⑦  同 id 影子卡（私有 vs 工作区各自独立解析）==');
    {
      const home = join(TMP, 'h7');
      const ws = join(TMP, 'w7');
      const body = '你是同一个岗位的卡，做同一件事。';
      writeCard(home, ws, 'shadow.md', cardText('shadow', '影子卡', body));
      const onlyPrivate = run(home, ws); // 工作区卡目录还不存在
      check('反例 a：只在一侧（工作区目录不存在）不许报第 5 类', !onlyPrivate.stdout.includes('[5] 同id影子卡'), onlyPrivate.stdout.split('\n').filter((l) => l.includes('[5]')).join(' | '));
      check('反例 a 总信号数=0 ⇒ RESULT: 0 signal(s)', /RESULT: 0 signal\(s\)/.test(onlyPrivate.stdout), onlyPrivate.stdout.trim().split('\n').slice(-1)[0]);

      writeWsCard(ws, 'other.md', cardText('other', '别的卡', '别的岗位的卡，干别的活。'));
      const otherId = run(home, ws); // 两边都有卡，但 id 不同
      check('反例 b：两边都有卡但 id 不同 ⇒ 不报（证明是按 id 求交，不是"两边有卡就报"）',
        !otherId.stdout.includes('[5] 同id影子卡'), otherId.stdout.split('\n').filter((l) => l.includes('[5]')).join(' | '));
      check('反例 b 总信号数=0 ⇒ RESULT: 0 signal(s)', /RESULT: 0 signal\(s\)/.test(otherId.stdout), otherId.stdout.trim().split('\n').slice(-1)[0]);

      writeWsCard(ws, 'shadow.md', cardText('shadow', '影子卡', body)); // 工作区放同 id、同文本
      const hit = run(home, ws);
      const line = hit.stdout.split('\n').find((l) => l.includes('[5] 同id影子卡')) || '';
      check('两侧各一张同 id ⇒ **必报**第 5 类', line !== '', hit.stdout);
      check('证据带 id / 两侧中文名 / 两侧文件名', /id=shadow（私有名=影子卡 \/ 工作区名=影子卡）/.test(line) && /私有 shadow\.md 与工作区 shadow\.md/.test(line), line);
      check('标注「工作区覆盖私有 ⇒ 私有被遮蔽」', /工作区卡覆盖私有卡/.test(line) && /遮蔽/.test(line), line);
      check('两侧同文本 ⇒ 标「同一份拷贝」', /同一份拷贝/.test(line), line);
      check('总信号数=1 ⇒ RESULT: 1 signal(s)', /RESULT: 1 signal\(s\)/.test(hit.stdout), hit.stdout.trim().split('\n').slice(-1)[0]);

      writeWsCard(ws, 'shadow.md', cardText('shadow', '影子卡', '你是改造过的另一版岗位卡，做的事已经变了。'));
      const forked = run(home, ws);
      const line2 = forked.stdout.split('\n').find((l) => l.includes('[5] 同id影子卡')) || '';
      check('两侧文本不同 ⇒ 仍报，且标「已分叉」（换掉死判据后这里才有读数）', /已分叉/.test(line2), line2);
    }

    // ⑧ 判据[4] 多根解析：临时 cwd 下存在同名文件 ⇒ 不报；删掉 ⇒ 报
    console.log('== ⑧  幽灵引用多根解析（cwd 命中⇒不报 / 删掉⇒报）==');
    {
      const home = join(TMP, 'h8');
      const ws = join(TMP, 'w8');
      writeCard(home, ws, 'ref.md', cardText('ref', '引用卡', '写法照 `03_系统\\卡表.md` 抄。'));
      const missing = run(home, ws);
      const g1 = s4(missing.stdout);
      check('三根（cwd/REPO/DSH_HOME）都没有 ⇒ 报幽灵 1 条', g1.length === 1 && g1[0].includes('03_系统\\卡表.md'), g1.join(' | '));
      check('证据注明按哪些根解析（含临时 cwd）', /按根逐一 existsSync/.test(g1[0] || '') && (g1[0] || '').includes(ws), g1[0]);
      check('总信号数=1 ⇒ RESULT: 1 signal(s)', /RESULT: 1 signal\(s\)/.test(missing.stdout), missing.stdout.trim().split('\n').slice(-1)[0]);

      mkdirSync(join(ws, '03_系统'), { recursive: true });
      writeFileSync(join(ws, '03_系统', '卡表.md'), '# 卡表\n', 'utf8'); // 只放在**临时 cwd** 下
      const present = run(home, ws);
      check('cwd 下存在 ⇒ **不报**幽灵（多根解析真有咬合力）', s4(present.stdout).length === 0, s4(present.stdout).join(' | '));
      check('总信号数=0 ⇒ RESULT: 0 signal(s)', /RESULT: 0 signal\(s\)/.test(present.stdout), present.stdout.trim().split('\n').slice(-1)[0]);

      rmSync(join(ws, '03_系统'), { recursive: true, force: true });
      const again = run(home, ws);
      check('删掉它 ⇒ 重新报幽灵 1 条', s4(again.stdout).length === 1, s4(again.stdout).join(' | '));
      check('总信号数回到 1 ⇒ RESULT: 1 signal(s)', /RESULT: 1 signal\(s\)/.test(again.stdout), again.stdout.trim().split('\n').slice(-1)[0]);
    }
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
  const cleaned = !existsSync(TMP);
  check('临时目录已清干净', cleaned, TMP);
  console.log(`SELFTEST: ${pass} PASS / ${fail} FAIL`);
  return fail === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

if (!existsSync(MOD_PATH)) {
  console.error(`[致命] 真源缺失：${MOD_PATH}（角色卡解析真源不在，无从体检）`);
  process.exit(1);
}
const mod = await import(pathToFileURL(MOD_PATH).href);

if (process.argv.slice(2).includes('--selftest')) {
  const ok = await selftest();
  process.exit(ok ? 0 : 1);
}

const dshHome = String(process.env.DSH_HOME || '').trim() || DEFAULT_HOME;
const result = audit({ dshHome, cwd: process.cwd(), mod });
if (result.fatal) {
  console.error(`[致命] ${result.fatal}`);
  process.exit(1);
}
process.stdout.write(`${result.text}\n`);
process.exit(0);
