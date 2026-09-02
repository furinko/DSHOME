#!/usr/bin/env node
// DSHOME 插件/配置变更守护（DSHOME-ISSUE-004 沉淀）。
// 职责：
//   --preflight        重启前三查（L4 patch 顶层数组 / lock autoInstallPeers / 裸跑后端冒烟）+ 备份 3 件套 + 写最新备份指针
//   --recover [目录]   按最新备份恢复 3 件套 + pnpm install（目录缺省用指针）
// 用法示例：
//   node scripts/plugin-change-guard.mjs --preflight
//   node scripts/plugin-change-guard.mjs --recover
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROFILE = process.env.DSH_PROFILE || 'dshome';
const PROFILE_DIR = path.join(ROOT, 'profiles', PROFILE);
const PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const PROFILE_PKG = path.join(PROFILE_DIR, 'package.json');
const LOCK = path.join(ROOT, 'pnpm-lock.yaml');
const POINTER = path.join(os.tmpdir(), 'dshome-rollback-latest.json');
const CLI = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BOOT_PAT = /dsh web:/i;

let failed = false;
const ok = (m) => console.log(`[OK]   ${m}`);
const bad = (m) => console.error(`[FAIL] ${m}`);
const fail = (m) => { bad(m); failed = true; };

/** L4 patch 顶层必须是 YAML 数组：纯注释解析为 null → 启动即崩。 */
function l4MeaningfulBody() {
  if (!existsSync(PATCH)) return '';
  const raw = readFileSync(PATCH, 'utf8');
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join('\n').trim();
}

function checkL4() {
  const body = l4MeaningfulBody();
  if (body === '') return fail(`L4 ${PATCH} 顶层为空（纯注释）→ boot 解析为 null 启动即崩；应保留显式空数组 []`);
  if (!body.startsWith('-') && !body.startsWith('[')) return fail(`L4 ${PATCH} 顶层不是 YAML 数组形态（每行以 - 开头或为 []）`);
  ok('L4 patch 顶层数组形态');
}

function checkLock() {
  if (!existsSync(LOCK)) return fail(`缺少 ${LOCK}`);
  const raw = readFileSync(LOCK, 'utf8');
  const m = /^autoInstallPeers:\s*(true|false)\b/m.exec(raw);
  if (m && m[1] === 'false') return fail('pnpm-lock.yaml settings.autoInstallPeers=false（社区插件 peer 不再自动安装）；改回 true 并重跑 pnpm install');
  ok(`lock autoInstallPeers=${m ? m[1] : '(未写，默认 true)'}`);
}

/** 裸跑后端冒烟：随机端口起 dsh，等到 "dsh web:" 输出即成功（ISSUE-001 教训）。resolve(true)=通过。 */
function checkBareBoot(timeoutMs = 30000) {
  if (!existsSync(CLI)) { fail(`找不到 dsh CLI: ${CLI}`); return Promise.resolve(false); }
  const port = 3100 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, [CLI, '--profile', PROFILE, '--no-open', '--port', String(port)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: ROOT, DSH_PROFILE: PROFILE },
  });
  let out = '';
  let done = false;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (done) return;
      done = true; child.kill();
      fail(`后端冒烟超时（${timeoutMs}ms），未见 dsh web: 输出`);
      resolve(false);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (!done && BOOT_PAT.test(out)) {
        done = true; clearTimeout(t); child.kill();
        ok('后端裸跑冒烟：dsh web: 输出就绪');
        resolve(true);
      }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', () => {
      if (done) return;
      done = true; clearTimeout(t);
      fail(`后端冒烟启动失败（进程退出）\n${out.split('\n').slice(-8).join('\n')}`);
      resolve(false);
    });
  });
}

/**
 * 备份 3 件套到 %TEMP%\dshome-rollback-<ts>，并写最新指针。
 * 指针语义 =「变更前安全点」：若已存在未被消费的备份指针，跳过覆盖（保留变更前状态），
 * 防止「变更后检查」把坏状态写成最新备份（ISSUE-005 实证：装后 preflight 覆盖装前备份 → 回滚恢复到坏状态）。
 */
function backup() {
  if (existsSync(POINTER)) {
    try {
      const prev = JSON.parse(readFileSync(POINTER, 'utf8'));
      if (prev && prev.dir && existsSync(prev.dir)) {
        ok(`已有未消费备份（${prev.dir}），跳过覆盖——回滚将恢复到该变更前状态`);
        return prev.dir;
      }
    } catch { /* 指针损坏 → 走新备份 */ }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(os.tmpdir(), `dshome-rollback-${stamp}`);
  mkdirSync(dir, { recursive: true });
  for (const [src, name] of [[PROFILE_PKG, 'package.json'], [LOCK, 'pnpm-lock.yaml'], [PATCH, 'cordis.patch.yml']]) {
    if (!existsSync(src)) { fail(`备份源缺失 ${src}`); return null; }
    copyFileSync(src, path.join(dir, name));
  }
  writeFileSync(POINTER, JSON.stringify({ dir, timestamp: new Date().toISOString(), profile: PROFILE }, null, 2));
  ok(`备份完成: ${dir}`);
  ok(`最新备份指针: ${POINTER}`);
  return dir;
}

/** 回滚：恢复 3 件套 + pnpm install + 回滚后冒烟；成功后消费（删除）备份指针。 */
async function recover(dir) {
  if (!dir) {
    if (!existsSync(POINTER)) { fail('没有可用备份指针（先跑 --preflight）'); return 1; }
    dir = JSON.parse(readFileSync(POINTER, 'utf8')).dir;
  }
  console.log(`恢复目录: ${dir}`);
  const files = { 'package.json': PROFILE_PKG, 'pnpm-lock.yaml': LOCK, 'cordis.patch.yml': PATCH };
  for (const [name, dest] of Object.entries(files)) {
    const src = path.join(dir, name);
    if (!existsSync(src)) { fail(`备份缺文件 ${src}`); return 1; }
    copyFileSync(src, dest);
    ok(`恢复 ${name} → ${dest}`);
  }
  // 恢复出的 L4 若仍是纯注释（备份时即坏），补显式空数组，避免恢复后依然启动即崩。
  const body = l4MeaningfulBody();
  if (body === '') {
    writeFileSync(PATCH, readFileSync(PATCH, 'utf8').replace(/\s*$/, '\n') + '\n[]\n', 'utf8');
    ok('L4 恢复后为空 → 已补显式空数组 []（防启动即崩）');
  }
  ok('备份已恢复，重跑 pnpm install（若后端在运行，建议先停后端点再执行）');
  const r = spawnSync('pnpm install', { cwd: ROOT, stdio: 'inherit', shell: true, windowsHide: true });
  if (r.status !== 0) { fail('pnpm install 失败，请人工检查'); return 1; }
  ok('pnpm install 完成，回滚结束');
  // 回滚后冒烟：恢复的备份若本身是坏状态，立即暴露，提示尝试更早备份（ISSUE-005 教训）。
  const bootOk = await checkBareBoot(40000);
  if (!bootOk) {
    fail('回滚后后端冒烟未通过——备份本身可能是坏状态；可用 --recover <更早备份目录> 指定更早备份');
    return 1;
  }
  try { unlinkSync(POINTER); ok('备份指针已消费清除（下次变更将建立新安全点）'); } catch { /* 指针可能不存在 */ }
  return 0;
}

// ---- 入口 ----
const args = process.argv.slice(2);
const mode = args[0];
if (mode === '--preflight') {
  checkL4();
  checkLock();
  const bootOk = await checkBareBoot();
  if (!bootOk) failed = true;
  if (failed) { console.error('\n预检未通过：先修复上述问题，不要重启后端。'); process.exit(1); }
  backup();
  console.log('\n预检全部通过，备份已就位，可以安全重启。');
} else if (mode === '--recover') {
  process.exit(await recover(args[1]));
} else {
  console.log('用法: node scripts/plugin-change-guard.mjs --preflight | --recover [备份目录]');
  process.exit(2);
}
