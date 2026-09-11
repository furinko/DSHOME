// DSHOME shell — 安全模式覆盖层（纯函数，零 Electron 依赖，可单独用 node 测试）。
// 背景（2026-09-11 实测，主人报「崩了没报错框 + 安全模式打不开」）：
//   旧实现有两处硬伤：① 只取「找到的第一个 patch 文件」→ 只覆盖 L3 产品层 15 行，
//   L4 覆盖层后加的 dsh-imagegen / Agent Teams 实验包不在禁用范围（dump-config 已证实）；
//   ② --patch 被拼在 app 参数（--no-open/--port）之后 → dsh 报 `unknown option '--patch'`
//   → 后端根本起不来（安全模式反而变成崩溃源）。
// 本模块负责：① 汇总自有插件 id（L3 产品层 + L4 profile 覆盖层）② 生成覆盖层文本
//   ③ 把 --patch 插到命令行 launcher 旗标区（必须在 app 参数之前）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** insert 块开头：`- insert:` */
const INSERT_RE = /^(\s*)-\s*insert:\s*$/;
/** 行级 id：`- id: xxx`（容忍引号与行尾注释） */
const ID_RE = /^(\s*)-\s*id:\s*("?)([^"'\s#]+)\2\s*(?:#.*)?$/;
/** 任意顶层列表项开头：`- something` */
const ENTRY_RE = /^(\s*)-\s+\S/;

/** 从一份 patch YAML 文本里抽「本层新增的行 id」。
 *  规则：insert 块内（缩进深于 `- insert:`）的行 id 全部算自有；
 *  另加兜底——任何位置的 `dshome*` 行 id 也算自有（产品层历史写法）。
 *  刻意**不**收 insert 块之外的非 dshome 行（如 web-runtime / webserver / llm-deepseek
 *  这类「覆盖官方行」的条目）——禁掉它们会把宿主一起打死。 */
function idsFromPatchText(text) {
  const ids = [];
  const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  let insertIndent = -1; // >= 0 表示当前在 insert 块内（值为 `- insert:` 的缩进）
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const ins = INSERT_RE.exec(line);
    if (ins) { insertIndent = ins[1].length; continue; }

    const id = ID_RE.exec(line);
    if (id) {
      const indent = id[1].length;
      const name = id[3];
      if (insertIndent >= 0 && indent > insertIndent) push(name);
      else if (/^dshome/.test(name)) push(name);
      if (insertIndent >= 0 && indent <= insertIndent) insertIndent = -1;
      continue;
    }

    // 非 id 行：顶层新条目（缩进不深于 insert）意味着 insert 块结束
    if (insertIndent >= 0) {
      const m = ENTRY_RE.exec(line);
      if (m && m[1].length <= insertIndent) insertIndent = -1;
    }
  }
  return ids;
}

/** 从命令行里取 `--profile <name>`（dev 分支的 DSHOME_BACKEND_CMD）。 */
function profileFromCmd(cmd) {
  const m = /--profile\s+("[^"]*"|'[^']*'|\S+)/.exec(String(cmd ?? ''));
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

/** DSH_HOME 兜底推断：从壳目录向上找第一个含 `profiles` 子目录的祖先。 */
function dshHomeFromShellDir(shellDir) {
  let dir = shellDir;
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'profiles'))) return dir;
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 候选 patch 文件（去重保序，只返回真实存在的文件）。
 *  L3 = 产品默认层（随包分发）；L4 = 本机 profile 覆盖层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）。
 *  profile 名未知时**不**扫其它 profile——把别人的行 id 灌进本 profile 的补丁会造出无名行。 */
function patchCandidates({ shellDir, profDir = null, instDir = null, dshHome = null, profile = null } = {}) {
  const out = [];
  const push = (f) => { if (f && !out.includes(f)) out.push(f); };
  if (profDir) push(path.join(profDir, 'node_modules', 'dshome', 'cordis.patch.yml'));
  if (instDir) push(path.join(instDir, 'packages', 'dshome', 'cordis.patch.yml'));
  let dir = shellDir;
  for (let i = 0; i < 6; i++) {
    push(path.resolve(dir, 'cordis.patch.yml'));
    push(path.resolve(dir, '..', 'cordis.patch.yml'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = dshHome || dshHomeFromShellDir(shellDir);
  if (home && profile) push(path.join(home, 'profiles', profile, 'cordis.patch.yml'));
  return out.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

/** 汇总所有候选层里的自有插件 id。 */
function collectSafeIds(opts = {}) {
  const ids = [];
  const sources = [];
  for (const file of patchCandidates(opts)) {
    try {
      const found = idsFromPatchText(fs.readFileSync(file, 'utf8'));
      if (!found.length) continue;
      sources.push({ file, count: found.length });
      for (const id of found) if (!ids.includes(id)) ids.push(id);
    } catch { /* 单文件读失败不影响其余层 */ }
  }
  return { ids, sources };
}

/** 生成 --patch 覆盖层文本（禁用每一行自有插件）。 */
function overlayText(ids) {
  return [
    '# DSHOME safe-mode overlay: disable every own plugin row (dynamic from patch layers L3+L4).',
    ...ids.map((id) => `- id: ${id}\n  disabled: true`),
    '',
  ].join('\n');
}

/** 安全模式：把 `--patch "<file>"` 插到 launcher 旗标区。
 *  🔴 必须在 app 参数（--no-open/--port/--host…）之前；实测拼在末尾会被 dsh 判
 *  `unknown option '--patch'`，后端直接起不来。首选插在 `--profile <name>` 之后。 */
function withPatchFlag(cmd, file) {
  const text = String(cmd ?? '');
  const flag = `--patch "${file}"`;
  if (/--patch\b/.test(text)) return text; // 调用方已带 → 不重复插
  const prof = /--profile\s+("[^"]*"|'[^']*'|\S+)/.exec(text);
  if (prof) {
    const at = prof.index + prof[0].length;
    return `${text.slice(0, at)} ${flag}${text.slice(at)}`;
  }
  const app = /\s--(?:no-open|port|host|open)\b/.exec(text);
  if (app) return `${text.slice(0, app.index)} ${flag}${text.slice(app.index)}`;
  return `${text} ${flag}`;
}

module.exports = {
  idsFromPatchText,
  profileFromCmd,
  patchCandidates,
  collectSafeIds,
  overlayText,
  withPatchFlag,
};
