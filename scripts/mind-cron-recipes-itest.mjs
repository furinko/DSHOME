#!/usr/bin/env node
// scripts/mind-cron-recipes-itest.mjs — 出厂自治「处方」自测（2026-09-14 建）
//
// 验什么：2026-09-14 定的切法**真成立** —— 机制/处方出厂 · 实例私有 · **默认关**，
//   且处方本体本身过得出厂卫生（出厂区会推上公开仓库）。
//
// 反例（写不出反例 = 没验过；每条的"应当失败"面都写进来）：
//   R1 默认关：空机（出厂态）0 任务；且**没有任何自动 seed 路径**（处方只被 seed 路由引用）
//   R2 出厂卫生：处方文件本体不含盘符路径 / 本机项目名 / 个人目录 / 凭据形态
//   R3 参数化：换一个工作区渲染 → prompt 跟随该工作区、不提 DSHOME、无未渲染占位符
//   R4 幂等：同一实例 seed 两次 → 第二次全部 skipped=exists、任务数不增；实例落私有区
//   R5 落点：self-clean 的待办落点用 {{projectKey}} 渲染成该工作区的 project.md
//
// 隔离：DSH_HOME 指临时目录（不碰真仓库）；跑完删除。
// 用法：node scripts/mind-cron-recipes-itest.mjs
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const LIB = join(repoRoot, 'packages', 'dshome-mind', 'lib');
const RECIPES_PATH = join(LIB, 'cron-recipes.cjs');
const INDEX_PATH = join(LIB, 'index.cjs');
const CRON_PATH = join(LIB, 'cron.cjs');

const results = [];
const check = (name, ok, extra) => results.push([name, ok ? 'PASS' : 'FAIL', extra]);

const { RECIPES, resolveRecipes, projectKeyOf } = require(RECIPES_PATH);

// ── R2 出厂卫生（处方本体）──────────────────────────────────────────────────
// 口径：① 结构形态（盘符路径/个人目录/凭据）② **私有禁词表**——与 `mind-validate ⑨` 用**同一份真源**
//   （`mind-private\tasks\private-denylist.txt`），不自己另编名单（两处口径必然漂）。
//   ⚠️ 注意产品名/包名（`dshome-*`、仓库名）不是私有词，不能拿它当命中。
{
  const src = readFileSync(RECIPES_PATH, 'utf8');
  const banned = [
    [/\b[A-Za-z]:[\\/]/, '盘符路径'],
    [/[\\/]Users[\\/]/i, '个人目录'],
    [/sk-[A-Za-z0-9]{6,}/, '凭据形态'],
  ];
  const hit = banned.filter(([re]) => re.test(src)).map(([, n]) => n);
  const denyPath = join(repoRoot, 'mind-private', 'tasks', 'private-denylist.txt');
  const words = existsSync(denyPath)
    ? readFileSync(denyPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  const wordHit = words.filter((w) => src.includes(w));
  check('R2a 处方本体无盘符路径/个人目录/凭据', hit.length === 0, hit.join('+') || '0 命中');
  check('R2b 处方本体无私有禁词（与门禁同一份真源）', wordHit.length === 0,
    words.length ? (wordHit.join('+') || `${words.length} 词 · 0 命中`) : '（禁词表不在，跳过）');
}

// ── R3 / R5 参数化（换工作区渲染）────────────────────────────────────────────
{
  const out = resolveRecipes({ cwd: 'D:/work/MyProject', projectKey: 'MyProject' });
  const clean = out.find((r) => r.id === 'self-clean');
  // 只有**带占位符**的处方必须被渲染；不带占位符的（用泛化"<项目>"）不强制含工作区名
  const withPh = RECIPES.filter((r) => r.prompt.includes('{{projectKey}}'));
  check('R3 带占位符的处方渲染跟随工作区',
    withPh.length > 0 && withPh.every((r) => out.find((x) => x.id === r.id).prompt.includes('MyProject')),
    withPh.map((r) => r.id).join(',') || '（无处方用占位符）');
  check('R3b 无残留未渲染占位符', out.every((r) => !/\{\{/.test(r.prompt)), '');
  check('R3c projectKeyOf 取目录名（含尾斜杠/反斜杠）',
    projectKeyOf('D:/work/MyProject') === 'MyProject' && projectKeyOf('E:\\DSHOME\\') === 'DSHOME',
    projectKeyOf('E:\\DSHOME\\'));
  check('R3d 处方**模板**不硬编码任何项目名（渲染前）',
    RECIPES.every((r) => !/dshome/i.test(r.prompt)), '');
  check('R5 self-clean 待办落点用 projectKey 渲染',
    clean.prompt.includes('projects\\MyProject\\project.md'), '');
}

// ── R1 默认关（出厂态）+ 无自动 seed 路径 ────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'dshome-recipes-r1-'));
  mkdirSync(join(home, 'mind'), { recursive: true });
  process.env.DSH_HOME = home;
  const { DshCron, loadCron } = require(CRON_PATH);
  const cron = new DshCron({ get: () => undefined });
  check('R1a 空机（出厂默认）0 任务', loadCron().length === 0 && cron.tasks.length === 0,
    `loadCron=${loadCron().length} tasks=${cron.tasks.length}`);
  const idxSrc = readFileSync(INDEX_PATH, 'utf8');
  const cronSrc = readFileSync(CRON_PATH, 'utf8');
  const requireRefs = (idxSrc.match(/require\('\.\/cron-recipes\.cjs'\)/g) || []).length;
  const seedRefs = (idxSrc.match(/resolveRecipes\(/g) || []).length;
  check('R1b 处方只被 index 的 seed 路径用；cron.cjs 不自动建任务',
    requireRefs === 1 && seedRefs === 1 && !/cron-recipes|resolveRecipes/.test(cronSrc),
    `require=${requireRefs} resolve=${seedRefs}`);
  rmSync(home, { recursive: true, force: true });
}

// ── R4 幂等 + 实例落私有区 ──────────────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'dshome-recipes-r4-'));
  mkdirSync(join(home, 'mind'), { recursive: true });
  process.env.DSH_HOME = home;
  const { DshCron } = require(CRON_PATH);
  const cron = new DshCron({ get: () => undefined });
  const seedOnce = () => resolveRecipes({ cwd: home, projectKey: projectKeyOf(home) }).map((r) => {
    if ((cron.tasks || []).some((t) => t.id === r.id)) return { id: r.id, ok: false, skipped: 'exists' };
    return { id: r.id, ...cron.add({ id: r.id, cron: r.cron, prompt: r.prompt, cwd: home, catchUp: true, preset: 'standard' }) };
  });
  const first = seedOnce();
  check('R4a 首次 seed 建成 2 条且启用', first.every((x) => x.ok) && cron.tasks.length === 2 && cron.tasks.every((t) => t.enabled !== false),
    `n=${cron.tasks.length}`);
  const second = seedOnce();
  check('R4b 二次 seed 全部跳过（幂等，不重复建）',
    second.every((x) => x.skipped === 'exists') && cron.tasks.length === 2, JSON.stringify(second));
  check('R4c 实例落在私有区 mind-private/tasks/cron.json',
    existsSync(join(home, 'mind-private', 'tasks', 'cron.json')), '');
  check('R4d 处方条数 = 2（self-clean / self-feed）',
    RECIPES.length === 2 && cron.tasks.map((t) => t.id).sort().join(',') === 'self-clean,self-feed',
    cron.tasks.map((t) => t.id).join(','));
  cron.clear();
  rmSync(home, { recursive: true, force: true });
}

let failed = 0;
for (const [name, verdict, extra] of results) {
  if (verdict === 'FAIL') failed++;
  console.log(`[itest] ${name}: ${verdict}${extra ? ' (' + extra + ')' : ''}`);
}
console.log(`[itest] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
