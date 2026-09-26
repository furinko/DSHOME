// e2e: role_card_list / role_card_read / role_card_write / role_card_retire / role_card_rename —— 正例 + 反例 + 不污染
// 用法: node scripts/verify-agent-roles-card-tools.mjs
// 可移植：路径全部从本文件位置反推（`scripts/` → 仓库根），**不写盘符**——本机带盘符的路径
//   既会进推送面（按口径「机器痕迹 0 命中」），换到另一台机器（如公司那台）还会**直接跑不了**。
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // scripts/ → 仓库根
const TMP = join(REPO, '_tmp_cardtools');
const HOME = join(TMP, 'home');
const WS = join(TMP, 'ws');
const CARD_DIR = join(WS, '.agent-roles');
const LEDGER = join(HOME, 'profiles', 'dshome', '.dsh-market', 'agent-roles-card-ledger.jsonl');
const REAL_LEDGER = join(REPO, 'profiles', 'dshome', '.dsh-market', 'agent-roles-card-ledger.jsonl');

let pass = 0; let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label} ${extra}`); }
};

// --- 准备隔离环境（先设 DSH_HOME，homeRoot() 按调用期读它）---
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(HOME, 'mind'), { recursive: true });
mkdirSync(CARD_DIR, { recursive: true });
process.env.DSH_HOME = HOME;

const CARD0 = ['---', 'id: t1', 'name: 端到端测试卡', 'description: e2e', 'version: 1.0.0', 'tools:', '  allow:', '    - read', '---', '', '正文一。', ''].join('\n');
const CARD_PATH = join(CARD_DIR, 't1.md');
writeFileSync(CARD_PATH, CARD0, 'utf8');

const realLedgerBefore = existsSync(REAL_LEDGER) ? readFileSync(REAL_LEDGER, 'utf8') : null;

// 成员归属表夹具：**字段名照抄真机写侧**（`rememberMember` 写的是 childId/cardId/label/**at**）。
// 2026-09-25 补齐此面的原因：读侧曾把 `at` 读成 `ts` ⇒ 成员归属的**时间静默为空**（不报错、不告警），
// 而当时的用例只覆盖卡面（list/read/write/台账），**成员面零断言** ⇒ 22 PASS 全绿也照不出它。
const MEMBER_MAP = join(HOME, 'profiles', 'dshome', '.dsh-market', 'agent-roles-members.jsonl');
const REAL_MEMBER_MAP = join(REPO, 'profiles', 'dshome', '.dsh-market', 'agent-roles-members.jsonl');
mkdirSync(join(HOME, 'profiles', 'dshome', '.dsh-market'), { recursive: true });
writeFileSync(MEMBER_MAP, `${JSON.stringify({ childId: 'child-1', cardId: 't1', label: '端到端测试卡:甲', at: '2026-09-25T12:00:00.000Z' })}\n`, 'utf8');

const mod = await import(pathToFileURL(join(REPO, 'packages', 'dshome', 'lib', 'host', 'agent-roles.js')).href);
const state = { home: HOME, nameIndex: new Map(), pendingGuards: new Map(), childGuards: new Map(), childOwnScope: new Map(), memberCards: new Map(), memberCardsLoaded: false };
const tools = mod.makeRoleTools({ ctx: {}, state });
const exec = { agent: { id: 'test-agent', session: { header: { cwd: WS } } } };
const ledgerLines = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean) : []);

console.log('== 1) role_card_list ==');
const listed = await tools.roleCardList.execute({}, exec);
check('ok=true', listed.ok === true, JSON.stringify(listed));
check('1 张卡', Array.isArray(listed.cards) && listed.cards.length === 1, JSON.stringify(listed.cards));
check('id=t1 且 hash 16 位', listed.cards[0].id === 't1' && String(listed.cards[0].hash).length === 16, JSON.stringify(listed.cards[0]));
check('version 读到 1.0.0', listed.cards[0].version === '1.0.0', listed.cards[0].version);
check('成员归属面：1 条且 childId/cardId 正确', Array.isArray(listed.members) && listed.members.length === 1 && listed.members[0].childId === 'child-1' && listed.members[0].cardId === 't1', JSON.stringify(listed.members));
check('成员归属面：时间字段 `at` 真读到（读成 `ts` ⇒ 空串 ⇒ 本断言必红）', listed.members[0] && listed.members[0].at === '2026-09-25T12:00:00.000Z', JSON.stringify(listed.members[0]));

console.log('== 2) role_card_read ==');
const read1 = await tools.roleCardRead.execute({ cardId: 't1' }, exec);
check('ok=true 且原文一致', read1.ok === true && read1.text === CARD0, read1.error || '');
const h1 = read1.hash;

console.log('== 3) role_card_write 正例（带 expectHash，应推进 version） ==');
const NEW = CARD0.replace('正文一。', '正文一。\n新增一行（e2e 正例）。');
const w1 = await tools.roleCardWrite.execute({ cardId: 't1', content: NEW, reason: 'e2e 正例：加一行', expectHash: h1 }, exec);
check('ok=true', w1.ok === true, JSON.stringify(w1));
check('version 1.0.0 -> 1.1.0', w1.versionFrom === '1.0.0' && w1.versionTo === '1.1.0', `${w1.versionFrom}->${w1.versionTo}`);
check('bumped=true', w1.bumped === true);
check('盘上确实变了', readFileSync(CARD_PATH, 'utf8').includes('新增一行') && readFileSync(CARD_PATH, 'utf8').includes('version: 1.1.0'));
check('台账 begin+done 两行', ledgerLines().length === 2 && JSON.parse(ledgerLines()[0]).phase === 'begin' && JSON.parse(ledgerLines()[1]).phase === 'done', String(ledgerLines().length));
check('台账记了 reason 与前后 hash', JSON.parse(ledgerLines()[1]).reason === 'e2e 正例：加一行' && JSON.parse(ledgerLines()[1]).beforeHash === h1);
const h2 = w1.afterHash;

console.log('== 4) 反例：expectHash 过期（乐观锁） ==');
const before4 = readFileSync(CARD_PATH, 'utf8');
const w2 = await tools.roleCardWrite.execute({ cardId: 't1', content: NEW + '\n脏写。', reason: '不该发生', expectHash: h1 }, exec);
check('code=stale-card', w2.ok === false && w2.code === 'stale-card', JSON.stringify(w2));
check('盘上未被改动', readFileSync(CARD_PATH, 'utf8') === before4);

console.log('== 5) 反例：新文本 id 与目标卡不一致 ==');
const w3 = await tools.roleCardWrite.execute({ cardId: 't1', content: NEW.replace('id: t1', 'id: t2'), reason: '不该发生' }, exec);
check('code=id-mismatch', w3.ok === false && w3.code === 'id-mismatch', JSON.stringify(w3));
check('盘上未被改动', readFileSync(CARD_PATH, 'utf8') === before4);

console.log('== 6) 反例：新文本不可解析（无 frontmatter） ==');
const w4 = await tools.roleCardWrite.execute({ cardId: 't1', content: '这不是卡，只是随手一段文字。', reason: '不该发生' }, exec);
check('code=invalid-card', w4.ok === false && w4.code === 'invalid-card', JSON.stringify(w4));
check('盘上未被改动', readFileSync(CARD_PATH, 'utf8') === before4);

console.log('== 7) 反例：缺 reason ==');
const w5 = await tools.roleCardWrite.execute({ cardId: 't1', content: NEW }, exec);
check('code=bad-args', w5.ok === false && w5.code === 'bad-args', JSON.stringify(w5));

console.log('== 8) 反例：卡不存在 ==');
const w6 = await tools.roleCardWrite.execute({ cardId: 'nope', content: NEW, reason: 'x' }, exec);
check('code=card-not-found 且列出 ids', w6.ok === false && w6.code === 'card-not-found' && Array.isArray(w6.ids) && w6.ids.includes('t1'), JSON.stringify(w6));

console.log('== 9) 反例：台账写不进去 ⇒ 必须拒绝改动（留痕是前置门） ==');
rmSync(LEDGER, { force: true });
mkdirSync(LEDGER, { recursive: true });           // 同名目录 ⇒ appendFileSync 必失败
const lines9 = null;
const w7 = await tools.roleCardWrite.execute({ cardId: 't1', content: NEW + '\n第九例。', reason: '不该发生' }, exec);
check('code=ledger-unwritable', w7.ok === false && w7.code === 'ledger-unwritable', JSON.stringify(w7));
check('卡文件未被改动（拒绝得彻底）', readFileSync(CARD_PATH, 'utf8') === before4);
rmSync(LEDGER, { recursive: true, force: true });

console.log('== 10) 归属表夹具口径 vs 真机写侧（防「夹具照抄读侧」自证） ==');
if (existsSync(REAL_MEMBER_MAP)) {
  const realFirst = readFileSync(REAL_MEMBER_MAP, 'utf8').split('\n').filter(Boolean)[0];
  let realKeys = [];
  try { realKeys = Object.keys(JSON.parse(realFirst)); } catch { realKeys = []; }
  check('真机归属表用 `at`（夹具的来源是它，不是读侧代码）', realKeys.includes('at') && realKeys.includes('childId'), JSON.stringify(realKeys));
} else {
  console.log('  NOTE  真机归属表不存在（本机从未起过成员）⇒ 跳过口径对照，不算失败');
}

console.log('== 11) 不污染本机：真 DSH_HOME 的台账未被创建/改动 ==');
const realLedgerAfter = existsSync(REAL_LEDGER) ? readFileSync(REAL_LEDGER, 'utf8') : null;
check('真台账与跑之前一致', realLedgerBefore === realLedgerAfter, realLedgerAfter === null ? '（真台账不存在，正确）' : '（内容有变化！）');

console.log('== 12) role_card_retire 三态（退役 / 列出 / 取回）+ 反例 ==');
const R0 = await tools.roleCardRetire.execute({}, exec);
check('反例：空参 ⇒ bad-args', R0.ok === false && R0.code === 'bad-args', JSON.stringify(R0));
const R1 = await tools.roleCardRetire.execute({ cardId: 't1' }, exec);
check('反例：缺 reason ⇒ bad-args（留痕是前置门）', R1.ok === false && R1.code === 'bad-args', JSON.stringify(R1));
const R2 = await tools.roleCardRetire.execute({ cardId: 't1', reason: 'e2e：一次性卡已过期' }, exec);
check('退役 ok=true 且 liveMembers=1（面板归属读得到）', R2.ok === true && R2.liveMembers === 1, JSON.stringify(R2));
check('卡已离开卡池原址（不物理存在）', !existsSync(CARD_PATH), CARD_PATH);
check('落到卡目录下 .retired\\（不物理删）', existsSync(R2.to) && R2.to.includes('.retired'), R2.to);
check('返回了 restore 指引与 TRASH 升级命令', String(R2.restore).includes('role_card_retire') && String(R2.trashCmd).includes('evolve-log.mjs trash'), JSON.stringify({ restore: R2.restore, trashCmd: R2.trashCmd }));
const L2 = await tools.roleCardList.execute({}, exec);
check('退役后 role_card_list 看不见它（卡池空）', L2.ok === true && L2.cards.length === 0, JSON.stringify(L2.cards));
const L3 = await tools.roleCardRetire.execute({ list: true }, exec);
check('list 能列出已退役那张', L3.ok === true && L3.retired.some((r) => r.file === R2.to.split(/[\\/]/).pop()), JSON.stringify(L3.retired));
const retireLedger = ledgerLines().map((line) => JSON.parse(line)).filter((entry) => entry.action === 'retire');
check('台账记 begin/done 两行且带 reason', retireLedger.length === 2 && retireLedger[0].phase === 'begin' && retireLedger[1].phase === 'done' && retireLedger[1].reason === 'e2e：一次性卡已过期', JSON.stringify(retireLedger.map((e) => e.phase)));
const R3 = await tools.roleCardRetire.execute({ restore: R2.to.split(/[\\/]/).pop() }, exec);
check('restore 取回 ok=true 且卡池重新可见', R3.ok === true && existsSync(CARD_PATH) && (await tools.roleCardList.execute({}, exec)).cards.length === 1, JSON.stringify(R3));
check('取回也留痕（台账再 +2 行 restore）', ledgerLines().map((line) => JSON.parse(line)).filter((entry) => entry.action === 'restore').length === 2);

console.log('== 13) role_card_rename：改 id 正例 + 反例（每条反例都断言「盘上没动」） ==');
// 观测面：新旧卡路径 + 冲突夹具 + 卡改动台账。**台账也算"盘"**——反例连一行台账都不许写。
const CARD2_PATH = join(CARD_DIR, 't2.md');
const PRIV_DIR = join(HOME, 'mind-private', 'L2', 'agents');
const PRIV_PATH = join(PRIV_DIR, 'p1.md');
const RENAMED_PATH = join(CARD_DIR, 't1-renamed.md');
const FRESH_PATH = join(CARD_DIR, 'fresh.md');
const WATCH = [CARD_PATH, RENAMED_PATH, FRESH_PATH, CARD2_PATH, PRIV_PATH, LEDGER];
const snap = () => JSON.stringify(WATCH.map((p) => [p, existsSync(p) ? readFileSync(p, 'utf8') : null]));

const before13 = readFileSync(CARD_PATH, 'utf8');
const memberMapBefore = readFileSync(MEMBER_MAP, 'utf8');
const read13 = await tools.roleCardRead.execute({ cardId: 't1' }, exec);
const N1 = await tools.roleCardRename.execute({ cardId: 't1', newId: 't1-renamed', reason: 'e2e：inline-hex 折成可读 id', expectHash: read13.hash }, exec);
check('正例：ok=true', N1.ok === true, JSON.stringify(N1));
check('正例：oldPath/path 指向新旧两处', N1.oldPath === CARD_PATH && N1.path === RENAMED_PATH, JSON.stringify({ old: N1.oldPath, path: N1.path }));
check('正例：新路径存在、旧路径不存在（真改名，不是复制）', existsSync(RENAMED_PATH) && !existsSync(CARD_PATH), JSON.stringify({ newExists: existsSync(RENAMED_PATH), oldExists: existsSync(CARD_PATH) }));
const renamedText = readFileSync(RENAMED_PATH, 'utf8');
check('正例：frontmatter 的 id 已改成新 id', /^id: t1-renamed$/m.test(renamedText), renamedText.split('\n').slice(0, 8).join(' | '));
// 「其它字段一字不丢」的强判据：**原文只换 id 那一行**，其余必须逐字节相等（整卡 re-serialize ⇒ 本断言必红）
check('正例：其它字段一字不丢（=原文只动 id 那一行）', renamedText === before13.replace(/^id: t1$/m, 'id: t1-renamed'), 'only the id line differs');
check('正例：version/tools/description 原样还在', renamedText.includes('version: 1.1.0') && renamedText.includes('    - read') && renamedText.includes('description: e2e') && renamedText.includes('新增一行'), renamedText.replace(/\n/g, '\\n'));
check('正例：beforeHash=读卡时的 hash，afterHash=新盘上 hash，currentHash=afterHash', N1.beforeHash === read13.hash && N1.afterHash === mod.cardTextHash(renamedText) && N1.currentHash === N1.afterHash, JSON.stringify({ before: N1.beforeHash, after: N1.afterHash, current: N1.currentHash }));
check('正例：oldRemoved=true 且无 warning（旧文件真删掉了）', N1.oldRemoved === true && N1.warning === '', JSON.stringify({ oldRemoved: N1.oldRemoved, warning: N1.warning }));
const renLedger = ledgerLines().map((line) => JSON.parse(line)).filter((entry) => entry.action === 'rename');
check('正例：台账 begin+done 两行', renLedger.length === 2 && renLedger[0].phase === 'begin' && renLedger[1].phase === 'done', JSON.stringify(renLedger.map((e) => e.phase)));
check('正例：台账如实记新旧 id / 新旧路径 / reason / oldRemoved', renLedger[1].cardId === 't1' && renLedger[1].newId === 't1-renamed' && renLedger[1].oldPath === CARD_PATH && renLedger[1].path === RENAMED_PATH && renLedger[1].oldRemoved === true && renLedger[1].reason === 'e2e：inline-hex 折成可读 id', JSON.stringify(renLedger[1]));
const list13 = await tools.roleCardList.execute({}, exec);
check('正例：卡池现在只有新 id（旧 id 消失）', list13.ok === true && list13.cards.length === 1 && list13.cards[0].id === 't1-renamed', JSON.stringify(list13.cards.map((card) => card.id)));
check('正例：成员归属表一个字没动（append-only 历史，本工具不追改）', readFileSync(MEMBER_MAP, 'utf8') === memberMapBefore, readFileSync(MEMBER_MAP, 'utf8'));
check('正例：归属表仍指旧 id t1 —— 老成员指向旧 id 是**预期**，不是坏数据', JSON.parse(readFileSync(MEMBER_MAP, 'utf8').split('\n').filter(Boolean)[0]).cardId === 't1');

// 冲突反例的夹具：项目卡 t2 + 私密卡 p1（两目录一起看 ⇒ 都要挡）
writeFileSync(CARD2_PATH, ['---', 'id: t2', 'name: 二号卡', 'version: 1.0.0', '---', '', '正文二。', ''].join('\n'), 'utf8');
mkdirSync(PRIV_DIR, { recursive: true });
writeFileSync(PRIV_PATH, ['---', 'id: p1', 'name: 私密卡', '---', '', '正文私。', ''].join('\n'), 'utf8');
const TARGET = 't1-renamed';
const snapBefore = snap();

const F1 = await tools.roleCardRename.execute({ cardId: TARGET, newId: 'bad:id', reason: '不该发生' }, exec);
check('反例①：非法 id（含 ":"）⇒ code=bad-id', F1.ok === false && F1.code === 'bad-id', JSON.stringify(F1));
check('反例①：盘上没动（含台账）', snap() === snapBefore);

const F2 = await tools.roleCardRename.execute({ cardId: TARGET, newId: 't2', reason: '不该发生' }, exec);
check('反例②：与项目目录现存卡 id 冲突 ⇒ code=bad-id', F2.ok === false && F2.code === 'bad-id' && String(F2.error).includes('t2'), JSON.stringify(F2));
check('反例②：盘上没动', snap() === snapBefore);

const F3 = await tools.roleCardRename.execute({ cardId: TARGET, newId: 'p1', reason: '不该发生' }, exec);
check('反例③：与**私密目录**现存卡 id 冲突 ⇒ code=bad-id（两个目录一起看）', F3.ok === false && F3.code === 'bad-id', JSON.stringify(F3));
check('反例③：盘上没动', snap() === snapBefore);

const F4 = await tools.roleCardRename.execute({ cardId: TARGET, newId: TARGET, reason: '不该发生' }, exec);
check('反例④：newId == 原 id ⇒ code=bad-id', F4.ok === false && F4.code === 'bad-id', JSON.stringify(F4));
check('反例④：盘上没动', snap() === snapBefore);

const F5 = await tools.roleCardRename.execute({ cardId: TARGET, newId: 'fresh' }, exec);
check('反例⑤：缺 reason ⇒ code=bad-args', F5.ok === false && F5.code === 'bad-args', JSON.stringify(F5));
const F5b = await tools.roleCardRename.execute({ cardId: TARGET, newId: 'fresh', reason: '   ' }, exec);
check('反例⑤b：reason 只有空白 ⇒ code=bad-args', F5b.ok === false && F5b.code === 'bad-args', JSON.stringify(F5b));
const F5c = await tools.roleCardRename.execute({ cardId: TARGET, reason: 'x' }, exec);
check('反例⑤c：缺 newId ⇒ code=bad-args', F5c.ok === false && F5c.code === 'bad-args', JSON.stringify(F5c));
check('反例⑤：盘上没动', snap() === snapBefore);

const F6 = await tools.roleCardRename.execute({ cardId: TARGET, newId: 'fresh', reason: '不该发生', expectHash: 'deadbeefdeadbeef' }, exec);
check('反例⑥：expectHash 过期 ⇒ code=stale-card', F6.ok === false && F6.code === 'stale-card', JSON.stringify(F6));
check('反例⑥：盘上没动', snap() === snapBefore);

const F7 = await tools.roleCardRename.execute({ cardId: 'ghost-card', newId: 'fresh', reason: 'x' }, exec);
check('反例⑦：卡不存在 ⇒ code=card-not-found 且列出可用 ids', F7.ok === false && F7.code === 'card-not-found' && Array.isArray(F7.ids) && F7.ids.includes(TARGET), JSON.stringify(F7));
check('反例⑦：盘上没动', snap() === snapBefore);

// 反例⑧：台账是**前置门**——写不进去就一个文件都不许动（新路径也不许出现）
rmSync(LEDGER, { force: true });
mkdirSync(LEDGER, { recursive: true });           // 同名目录 ⇒ appendFileSync 必失败
const F8 = await tools.roleCardRename.execute({ cardId: TARGET, newId: 'fresh', reason: '不该发生' }, exec);
check('反例⑧：台账写不进 ⇒ code=ledger-unwritable', F8.ok === false && F8.code === 'ledger-unwritable', JSON.stringify(F8));
check('反例⑧：新旧两个路径都在原位（一个文件都没动）', existsSync(RENAMED_PATH) && !existsSync(CARD_PATH) && !existsSync(FRESH_PATH), JSON.stringify({ renamed: existsSync(RENAMED_PATH), old: existsSync(CARD_PATH), fresh: existsSync(FRESH_PATH) }));
rmSync(LEDGER, { recursive: true, force: true });

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
rmSync(TMP, { recursive: true, force: true });
console.log('临时环境已清理:', !existsSync(TMP));
process.exit(fail === 0 ? 0 : 1);
