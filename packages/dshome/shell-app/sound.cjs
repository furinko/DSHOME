// dshome shell — 通知音（分事件音色）纯函数层。
//
// 为什么单独一个文件：main.cjs 是 Electron 主进程（require('electron')），在测试里**加载不了**；
// 而「值 → 绝对路径」「绝对路径 → PowerShell 命令」这两步判据是本次功能的全部风险面
// （路径注入 / 回退分支），必须能在无 Electron 环境里隔离真跑 ⇒ 抽到这里，
// 由 `scripts/verify-notify-sound.mjs` 直接 require 断言。
//
// 契约（冻结 v1.1 + Lead 裁决 v1.2 的 preview 三分支）：
//   · 值是**文件名或 .wav 绝对路径**；空串 = 不额外播音（只听系统通知自带的音）。
//   · 文件名（不含路径分隔符）⇒ `%WINDIR%\Media\<值>`。
//   · 校验：以 `.wav` 结尾（大小写不敏感）且 fs.existsSync 为真。
//   · 三种「值不可播」的处置**故意不同**（别把它们统一成一种，那是功能残废）：
//       ① preview + 缺省/空串 ⇒ 播系统默认音 + 204（设置页下拉首项「（默认，跟随系统）」要听得见）
//       ② preview + 非法值     ⇒ 400 + 调用方记日志（用户填错就得在设置页看到）
//       ③ 通知投递 + 非法值    ⇒ 播回退音 + 204（字段写错不能让"提醒"变静音 = 假绿）
//   · 回退音 = `[System.Media.SystemSounds]::Asterisk`（系统默认提示音）。
//   · 播放：`powershell.exe -NoProfile -NonInteractive -Command <脚本>`，**绝对路径只能 base64
//     进脚本再解码**——禁止把路径直接拼进 PowerShell 字符串（那是注入面）；
//     `execFile(..., { windowsHide: true })` 不可省（Electron 主进程 spawn 控制台子进程会闪黑框）。
//   · 本模块**不 require electron**：纯 Node，可被脚本单测。
'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Windows 目录（`%WINDIR%` 被精简时退回 C:\Windows；测试可用 DSHOME_WINDIR 覆盖）。 */
function windir() {
  return process.env.WINDIR || 'C:\\Windows';
}

/** 系统媒体库目录。DSHOME_SOUND_DIR 只为隔离测试留的接缝（正式路径恒为 %WINDIR%\Media）。 */
function mediaDir() {
  return process.env.DSHOME_SOUND_DIR || path.join(windir(), 'Media');
}

/** Windows 系统目录（同上，测试可用 DSHOME_SYSTEMROOT 覆盖）。 */
function systemRoot() {
  return process.env.SystemRoot || 'C:\\Windows';
}

/** powershell.exe 的绝对路径；优先绝对路径（开机自启场景环境变量/PATH 可能被精简），
 *  该文件不存在再回退裸名（交给 PATH 解析）。 */
function powershellPath() {
  if (process.env.DSHOME_POWERSHELL) return process.env.DSHOME_POWERSHELL;
  const abs = path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fs.existsSync(abs)) return abs;
  } catch { /* 探测失败 → 退回裸名 */ }
  return 'powershell.exe';
}

/** 播放一个 .wav 文件的 PowerShell 脚本：路径 base64 传入 + 进程内解码，**从不字符串拼接**。 */
function buildPlayScript(absPath) {
  const payload = Buffer.from(String(absPath ?? ''), 'utf8').toString('base64');
  return [
    '$ErrorActionPreference = "Stop";',
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'));`,
    '$sp = New-Object System.Media.SoundPlayer $p;',
    '$sp.Load();',
    '$sp.PlaySync();',
  ].join(' ');
}

/** 回退音：系统默认提示音（本机实测可用，类型 System.Media.SystemSound）。
 *  不含任何外部输入 ⇒ 单独一个固定脚本，便于断言「回退分支≠文件播放脚本」。 */
function systemDefaultPlayScript() {
  return '$ErrorActionPreference = "Stop"; [System.Media.SystemSounds]::Asterisk.Play();';
}

/**
 * 值 → 可播放的绝对路径（判据本体）。
 * @param {unknown} value - 设置里的值：文件名 / .wav 绝对路径 / 空串。
 * @param {(p: string) => boolean} [exists] - 存在性探测（默认 fs.existsSync；测试注入假体）。
 * @returns {{ok: boolean, path: string, reason: string}} ok=false ⇒ 调用方播系统默认音。
 *   reason 取值：no-sound-value（空/非字符串，按契约不播音） / not-wav / missing / resolve-error。
 */
function resolveSoundPath(value, exists) {
  const probe = typeof exists === 'function' ? exists : (p) => fs.existsSync(p);
  if (typeof value !== 'string') return { ok: false, path: '', reason: 'no-sound-value' };
  const raw = value.trim();
  if (raw === '') return { ok: false, path: '', reason: 'no-sound-value' };
  if (!/\.wav$/i.test(raw)) return { ok: false, path: '', reason: 'not-wav' };
  let abs;
  try {
    // 不含路径分隔符（/\ 都算）⇒ 视为文件名，落在 %WINDIR%\Media。
    abs = /[\\/]/.test(raw) ? path.resolve(raw) : path.join(mediaDir(), raw);
  } catch {
    return { ok: false, path: '', reason: 'resolve-error' };
  }
  let there = false;
  try { there = probe(abs) === true; } catch { there = false; }
  if (!there) return { ok: false, path: '', reason: 'missing' };
  return { ok: true, path: abs, reason: 'ok' };
}

/** 扫描媒体库里的 .wav（目录不存在 ⇒ 空数组，不报错）；返回按名排序的稳定清单。 */
function listSounds() {
  const dir = mediaDir();
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter((n) => /\.wav$/i.test(n))
      .sort((a, b) => a.localeCompare(b));
  } catch { names = []; }
  return { dir, sounds: names };
}

/**
 * `/notify` 的判据本体（纯函数，便于隔离断言「preview 与 sound 的组合行为」）。
 *
 * 三分支（契约 v1.1 + Lead 裁决 v1.2，逐条对应设置页要看到的行为）：
 *   ① preview + sound 缺省/空串 ⇒ **播系统默认音 + 204**。设置页音色下拉首项＝「（默认，跟随系统）」，
 *      点它的「试听」必须听得到东西 ⇒ 这里不能 400（那是功能残废，不是"响亮失败"）。
 *   ② preview + sound 非法（非 .wav / 文件不存在）⇒ **400**，由调用方记一行日志。
 *      用户手输/选错了值就该在设置页看到他填错了（客户端对非 2xx 出 warn）⇒ 不许拿回退音掩盖。
 *   ③ 非 preview + sound 非法 ⇒ **回退音 + 204**：用户把字段写错，不能让"提醒"变成静音的假绿。
 *
 * @param {{title?: unknown, body?: unknown, sound?: unknown, preview?: unknown}} payload
 * @returns {{status: number, kind: string, notify: boolean, play: string, fallback: boolean, resolved: string, silent: boolean}}
 *   kind: preview（只播音）/ notify（弹通知±播音）/ invalid（preview 但值非法 ⇒ 400）。
 *   play 为空串 = 不播音；fallback=true = play 是系统默认音脚本。
 */
function buildNotifyResponse(payload) {
  const raw = payload ?? {};
  // 只认**真函数**的 exists：它不属于 HTTP body 契约，若被调用方（或恶意请求）塞进 body 就忽略——
  // 否则判据会拿一个字符串当探测函数用（本脚本第一次跑就是这么红的）。
  const exists = typeof raw.exists === 'function' ? raw.exists : undefined;
  const resolved = resolveSoundPath(raw.sound, exists);
  const wanted = typeof raw.sound === 'string' && raw.sound.trim() !== '';
  if (raw.preview === true) {
    // 试听：只播音、不弹通知（title/body 忽略）。
    if (resolved.ok) {
      return { status: 204, kind: 'preview', notify: false, play: buildPlayScript(resolved.path), fallback: false, resolved: resolved.path, silent: false };
    }
    if (!wanted) {
      // ①「（默认，跟随系统）」这一项：播系统默认音（听得见），并明确告知这是回退音。
      return { status: 204, kind: 'preview', notify: false, play: systemDefaultPlayScript(), fallback: true, resolved: 'default-system', silent: false };
    }
    // ② 值非法：响亮 400（resolved 带原因：not-wav / missing），调用方记日志。
    return { status: 400, kind: 'invalid', notify: false, play: '', fallback: false, resolved: resolved.reason, silent: false };
  }
  // ③ 通知投递：不可播但有值 ⇒ 回退音，绝不静默。缺省/空串 ⇒ 不额外播音（只听系统通知自带的音）。
  const play = resolved.ok ? buildPlayScript(resolved.path) : (wanted ? systemDefaultPlayScript() : '');
  const fallback = !resolved.ok && wanted;
  return {
    status: 204, kind: 'notify', notify: true, play, fallback, silent: play !== '',
    resolved: resolved.ok ? resolved.path : (wanted ? resolved.reason : 'no-sound-value'),
  };
}

/** 播放一段 PowerShell 脚本：尽力而为——任何失败只回调日志，绝不抛、绝不崩壳。
 *  `onDone(result)`：`{ok:true,path}` 播完 / `{ok:false,error}` 失败（成功也回调：壳侧要留"回退音响了"的痕）。 */
function playScript(script, onDone) {
  if (typeof script !== 'string' || script.trim() === '') return;
  const report = typeof onDone === 'function' ? onDone : () => {};
  try {
    execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, // 不闪黑框：Electron 主进程 spawn 控制台子进程默认会弹窗，每条通知闪一次
      timeout: 15000,
    }, (error) => {
      report(error ? { ok: false, error } : { ok: true, script });
    });
  } catch (error) {
    report({ ok: false, error });
  }
}

module.exports = {
  windir,
  mediaDir,
  systemRoot,
  powershellPath,
  buildPlayScript,
  systemDefaultPlayScript,
  resolveSoundPath,
  listSounds,
  buildNotifyResponse,
  playScript,
};
