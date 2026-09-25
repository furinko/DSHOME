// e2e: role_card_list / role_card_read / role_card_write —— 正例 + 反例 + 不污染
// 用法: node _t-card-tools-e2e.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TMP = 'E:\\DSHOME\\_tmp_cardtools';
const HOME = join(TMP, 'home');
const WS = join(TMP, 'ws');
const CARD_DIR = join(WS, '.agent-roles');
const LEDGER = join(HOME, 'profiles', 'dshome', '.dsh-market', 'agent-roles-card-ledger.jsonl');
const REAL_LEDGER = 'E:\\DSHOME\\profiles\\dshome\\.dsh-market\\agent-roles-card-ledger.jsonl';

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
const REAL_MEMBER_MAP = 'E:\\DSHOME\\profiles\\dshome\\.dsh-market\\agent-roles-members.jsonl';
mkdirSync(join(HOME, 'profiles', 'dshome', '.dsh-market'), { recursive: true });
writeFileSync(MEMBER_MAP, `${JSON.stringify({ childId: 'child-1', cardId: 't1', label: '端到端测试卡:甲', at: '2026-09-25T12:00:00.000Z' })}\n`, 'utf8');

const mod = await import('file:///E:/DSHOME/packages/dshome/lib/host/agent-roles.js');
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

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
rmSync(TMP, { recursive: true, force: true });
console.log('临时环境已清理:', !existsSync(TMP));
process.exit(fail === 0 ? 0 : 1);
