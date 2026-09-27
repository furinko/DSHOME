#!/usr/bin/env node
// scripts/verify-notify-sound.mjs — DSHOME 通知「分事件音色」回归验证（契约 v1.1）
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// 分事件音色横跨三层：host 插件（notify.js 设置 schema + POST body）、壳（main.cjs 的
// /notify · /sounds · CORS）、播放实现（sound.cjs）。三层的失效**都不会报错**：
//   · schema 少个字段 → 设置面看得见没有、通知照发（静默降级）
//   · 值不可播时「静默不播音」→ 用户以为功能坏了，日志里啥也没有（假绿）
//   · 路径直接拼进 PowerShell → 注入面，正常值测不出来
// 所以这里全部按「真跑 + 反例」验：真加载 sound.cjs、真起 stub 壳 server、真 spawn
// PowerShell 验 windowsHide、真 base64 往返验解码。
//
// ── 反例纪律（每条判据都要有「改坏 ⇒ 必红」的反例）────────────────────────────
//   ① 值以 .mp3/.txt 结尾 ⇒ 必须拒绝 + 走**系统默认音回退分支**（断言分支被走到，不是断言"没崩"）
//   ② 文件不存在 ⇒ 同上（回退 = 播 Asterisk 的固定脚本，且 ≠ 文件播放脚本）
//   ③ 值含 ' " 换行 $() ⇒ 生成的命令里**只准出现 base64 与固定文本**，原字符一个都不出现
//   ④ preview 与 sound 的组合：preview+可用音 = 只播音不弹通知；preview+无音 = 400（响亮失败）
//      preview 不能因为 title/body 缺失而变成弹通知；非 preview 缺 sound = 弹通知不播音
//
// ── 退出码 ──────────────────────────────────────────────────────────────────
// 0 = 全通过；1 = 有断言失败（脚本自己响亮失败，绝不 WARN 后 exit 0）。
// 自测**不发出真实声音**（Play 类：脚本里只出现 PlaySync/Play 文本 + 一次真跑用 Write-Output
// 探针），避免测试自己制造骚扰；活体响声验收由 Lead 在主人方便时做。
//
// 用法：node scripts/verify-notify-sound.mjs
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';

const repoRoot = process.env.DSH_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shellDir = join(repoRoot, 'packages', 'dshome', 'shell-app');
// 注意：仓库文件是 CRLF ⇒ 先在读取处归一化，正则才不会被 \r 绊住（这条踩过一次）。
const notifySrc = readFileSync(join(repoRoot, 'packages', 'dshome', 'lib', 'host', 'notify.js'), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = readFileSync(join(shellDir, 'main.cjs'), 'utf8').replace(/\r\n/g, '\n');

let failed = 0;
let checks = 0;
function check(name, cond, extra = '') {
  checks += 1;
  if (cond) { console.log(`ok  ${name}`); return true; }
  failed += 1;
  console.error(`FAIL ${name}${extra ? '  → ' + extra : ''}`);
  return false;
}

// ── 隔离现场：假 %WINDIR%\Media（含 1 个真 .wav + 1 个同名非 wav），不碰真媒体库 ──
const fakeWin = mkdtempSync(join(tmpdir(), 'dshome-sound-win-'));
const fakeMedia = join(fakeWin, 'Media');
mkdirSync(fakeMedia, { recursive: true });
const GOOD_NAME = 'Windows Notify System Generic.wav';
writeFileSync(join(fakeMedia, GOOD_NAME), 'RIFF....WAVEfmt ');       // 只当文件存在性用，不真播
writeFileSync(join(fakeMedia, 'Windows Notify Email.wav'), 'RIFF....WAVEfmt '); // v2「其余」组的默认音
writeFileSync(join(fakeMedia, 'Decoy.txt'), 'not a wav');
writeFileSync(join(fakeMedia, 'Alarm01.WAV'), 'RIFF....WAVEfmt ');    // 大小写不敏感
process.env.WINDIR = fakeWin;
process.env.DSHOME_SOUND_DIR = fakeMedia;

const sound = require(join(shellDir, 'sound.cjs'));

// ── A. 真加载（不是 grep 文本）───────────────────────────────────────────────
console.log(`—— 真加载 sound.cjs：导出 ${Object.keys(sound).length} 项`);
check('A1 sound.cjs 真加载且导出判据函数',
  typeof sound.resolveSoundPath === 'function' && typeof sound.buildPlayScript === 'function'
  && typeof sound.listSounds === 'function' && typeof sound.buildNotifyResponse === 'function',
  Object.keys(sound).join(','));
check('A2 纯 Node 模块（不 require electron ⇒ 可在无 Electron 环境单测）',
  !/require\(\s*['"](node:)?electron['"]\s*\)/.test(readFileSync(join(shellDir, 'sound.cjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '')));

// ── B. 正例：文件名 / 绝对路径 ───────────────────────────────────────────────
const rName = sound.resolveSoundPath(GOOD_NAME);
check('B1 文件名解析到 %WINDIR%\\Media', rName.ok && rName.path === join(fakeMedia, GOOD_NAME), JSON.stringify(rName));
check('B2 后缀大小写不敏感（Alarm01.WAV 也算 wav）', sound.resolveSoundPath('Alarm01.WAV').ok === true);
const absWav = join(fakeMedia, GOOD_NAME);
const rAbs = sound.resolveSoundPath(absWav);
check('B3 绝对路径可用且原样保留', rAbs.ok && rAbs.path === absWav, JSON.stringify(rAbs));
check('B4 空串 = 按契约不播音（不是回退音）',
  sound.resolveSoundPath('').ok === false && sound.resolveSoundPath('').reason === 'no-sound-value'
  && sound.resolveSoundPath(undefined).reason === 'no-sound-value');

// ── C. 反例①：后缀不符 ⇒ 拒绝 + 回退分支被走到 ───────────────────────────────
for (const bad of ['Windows Notify Calendar.mp3', 'Decoy.txt', join(fakeMedia, 'Decoy.txt')]) {
  const r = sound.resolveSoundPath(bad);
  check(`C1 ${bad} ⇒ 拒绝（not-wav）`, r.ok === false && r.reason === 'not-wav', JSON.stringify(r));
}
const dMp3 = sound.buildNotifyResponse({ title: 't', body: 'b', sound: 'x.mp3' });
check('C2 后缀不符 ⇒ 响应走**回退分支**（fallback=true 且播的是系统默认音脚本）',
  dMp3.fallback === true && dMp3.play === sound.systemDefaultPlayScript() && dMp3.notify === true
  && dMp3.status === 204, JSON.stringify(dMp3));
check('C3 回退脚本 ≠ 文件播放脚本（不是"看起来播了"）', dMp3.play !== sound.buildPlayScript('C:\\x.wav'));

// ── D. 反例②：文件不存在 ⇒ 回退分支被走到 ────────────────────────────────────
const missing = join(fakeMedia, 'Nope.wav');
check('D1 不存在的绝对路径 ⇒ 拒绝（missing）',
  sound.resolveSoundPath(missing).ok === false && sound.resolveSoundPath(missing).reason === 'missing');
check('D2 不存在的文件名 ⇒ 拒绝（missing）',
  sound.resolveSoundPath('NoSuchSound.wav').reason === 'missing');
const dMissing = sound.buildNotifyResponse({ sound: 'NoSuchSound.wav' });
check('D3 缺文件 ⇒ 回退分支（fallback=true + 系统默认音），不是"静默无声"',
  dMissing.fallback === true && dMissing.play === sound.systemDefaultPlayScript()
  && dMissing.resolved === 'missing', JSON.stringify(dMissing));
// 反向对照：存在性探测函数被注入假体时，同一路径必须能判真（证明"回退"是因为不存在，
// 不是因为判据恒假 —— 否则 D1-D3 是假绿）。
check('D4 对照：注入 exists 恒真 ⇒ 同一路径判 ok（判据真的查了存在性）',
  sound.resolveSoundPath('NoSuchSound.wav', () => true).ok === true);

// ── E. 反例③：注入面 —— 命令里只准有 base64 与固定文本 ───────────────────────
const NASTY = "C:\\a'b\"c\nd$(Get-Process)`whoami`.wav";
const script = sound.buildPlayScript(NASTY);
const b64 = Buffer.from(NASTY, 'utf8').toString('base64');
check('E1 base64 与固定文本都在', script.includes(`FromBase64String('${b64}')`) && script.includes('SoundPlayer'));
// 「只出现 base64 与固定文本」的硬判据 = 逐字等于模板（模板里除 base64 外全是常量 ⇒
// 任何原字符漏进命令都会让这行红）。
const EXPECTED_TEMPLATE = `$ErrorActionPreference = "Stop"; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $sp = New-Object System.Media.SoundPlayer $p; $sp.Load(); $sp.PlaySync();`;
check('E1b 命令逐字等于「固定模板 + base64」', script === EXPECTED_TEMPLATE, JSON.stringify(script));
for (const ch of ["'", '\n', '\r', '$(', '`']) {
  // `"` 是模板常量（$ErrorActionPreference = "Stop"），不在排除集里；换行/反引号/子表达式
  // 只要出现就说明原值被拼进了命令。
  const leftover = script.replace(`'${b64}'`, '');
  check(`E2 原字符 ${JSON.stringify(ch)} 不出现在命令里（除 base64 包裹的固定引号）`,
    !leftover.includes(ch), JSON.stringify(script));
}
// 反向对照（反例：把路径直接拼进脚本 ⇒ 上面 E1b/E2 全部变红）。
check('E2b 模拟注入写法必与真实现不同（证明 E1b 有区分力）',
  `$p = '${NASTY}'` !== EXPECTED_TEMPLATE && script !== `$p = '${NASTY}'`);
check('E3 原始路径字符串在命令里一次都不出现', !script.includes(NASTY) && !script.includes('Get-Process'));
check('E4 dspl 恰被调用一次（没人偷偷多重编码）', script.split('FromBase64String').length === 2);
check('E5 只 Load/PlaySync，不提前出声（自测不得骚扰）',
  script.includes('$sp.Load();') && script.includes('$sp.PlaySync();') && !/\$sp\.Play\(\)/.test(script));

// ── F. 真跑 powershell：base64 往返 + Load() 不抛（Lead 已验口径，这里机器复核）──
const probePs = sound.powershellPath();
console.log(`—— powershell: ${probePs}（存在=${existsSync(probePs)}）`);
check('F1 powershell.exe 解析到绝对路径', /WindowsPowerShell/i.test(probePs) && existsSync(probePs), probePs);
const roundtripPath = join(fakeMedia, 'Alarm01.WAV');
const roundtripB64 = Buffer.from(roundtripPath, 'utf8').toString('base64');
const rtScript = [
  `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${roundtripB64}'));`,
  'if (Test-Path -LiteralPath $p) { Write-Output "RT-OK" } else { Write-Output "RT-MISS" };',
  `$sp = New-Object System.Media.SoundPlayer $p; $sp.Load(); Write-Output "LOAD-OK";`,
].join(' ');
const rt = spawnSync(probePs, ['-NoProfile', '-NonInteractive', '-Command', rtScript], { encoding: 'utf8', windowsHide: true });
check('F2 base64 往返 + Test-Path 命中（真 spawn powershell）',
  (rt.stdout || '').includes('RT-OK'), JSON.stringify({ out: rt.stdout, err: rt.stderr, status: rt.status }));
check('F3 New-Object SoundPlayer + Load() 真跑不抛（LOAD-OK）',
  (rt.stdout || '').includes('LOAD-OK'), JSON.stringify({ out: rt.stdout, err: rt.stderr }));

// ── G. windowsHide（Lead 补充 v1.1 条①：不加会每条通知闪黑框）────────────────
const soundSrc = readFileSync(join(shellDir, 'sound.cjs'), 'utf8');
check('G1 playScript 的 execFile 带 windowsHide: true', /windowsHide:\s*true/.test(soundSrc));
const g2 = spawnSync(probePs, ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output "PROBE-OK"'], { encoding: 'utf8', windowsHide: true });
check('G2 带 windowsHide 真跑 spawn 正常（没有把 spawn 弄坏）', (g2.stdout || '').includes('PROBE-OK'));
// 真接线复核：**子进程里 stub execFile** 抓真实调用参数（防"源码里有、代码路径没走到"）。
// 为什么用子进程：ESM 主进程里 require('node:child_process') 的缓存不可靠地可改；子进程是
// CJS、`require.cache` 稳定，抓完即退，不污染本脚本。
const stubPath = join(fakeWin, 'stub-execfile.cjs');
writeFileSync(stubPath, [
  `const cp = require('node:child_process');`,
  `const cap = {};`,
  `cp.execFile = (file, args, options) => { cap.file = file; cap.args = args; cap.options = options; };`,
  `const sound = require(${JSON.stringify(join(shellDir, 'sound.cjs'))});`,
  `sound.playScript(sound.buildPlayScript(process.argv[2]), () => {});`,
  `console.log('CAPTURED=' + JSON.stringify(cap));`,
].join('\n'));
const g3 = spawnSync(process.execPath, [stubPath, absWav], { encoding: 'utf8', windowsHide: true });
let cap = null;
try { cap = JSON.parse((g3.stdout || '').split('CAPTURED=')[1]); } catch { cap = null; }
console.log(`—— stub 抓到的 execFile 调用：${JSON.stringify(cap && { file: cap.file, args: cap.args?.slice(0, 3), options: cap.options })}`);
check('G3 playScript 真调用 execFile 且 options.windowsHide === true（子进程 stub 抓参）',
  cap !== null && cap.options?.windowsHide === true && g3.status === 0,
  JSON.stringify({ cap, stderr: g3.stderr }));
check('G4 execFile 参数 = powershell 绝对路径 + -NoProfile -NonInteractive -Command',
  cap !== null && /powershell\.exe$/i.test(cap.file)
  && cap.args[0] === '-NoProfile' && cap.args[1] === '-NonInteractive'
  && cap.args[2] === '-Command' && cap.args[3] === sound.buildPlayScript(absWav),
  JSON.stringify({ file: cap?.file, args: cap?.args?.slice(0, 3) }));

// ── H. preview 与 sound 的组合（契约 v1.1 + Lead 裁决 v1.2 三分支）──────────────
const pv1 = sound.buildNotifyResponse({ preview: true, sound: GOOD_NAME, title: 'x', body: 'y' });
check('H1 preview + 可用音 ⇒ 204 / 只播音不弹通知', pv1.status === 204 && pv1.kind === 'preview'
  && pv1.notify === false && pv1.play.startsWith('$ErrorActionPreference'), JSON.stringify(pv1));
check('H2 preview 时 title/body 被忽略（缺 title/body 也一样只播音）',
  sound.buildNotifyResponse({ preview: true, sound: GOOD_NAME }).notify === false);
// v1.2 ①：设置页下拉首项「（默认，跟随系统）」的试听必须听得见 ⇒ 204 + 系统默认音
check('H3 preview + 无音（sound 缺省）⇒ 204 + 播系统默认音（不是 400）',
  (() => { const d = sound.buildNotifyResponse({ preview: true }); return d.status === 204 && d.kind === 'preview'
    && d.fallback === true && d.play === sound.systemDefaultPlayScript() && d.notify === false; })(),
  JSON.stringify(sound.buildNotifyResponse({ preview: true })));
check('H3b preview + 空串 sound（下拉选了「默认」）⇒ 同上 204 + 系统默认音',
  (() => { const d = sound.buildNotifyResponse({ preview: true, sound: '' }); return d.status === 204 && d.fallback === true; })());
check('H4 preview + 不可播音但给了值 ⇒ 400 响亮失败（v1.2 ②：不许拿回退音掩盖）',
  (() => { const d = sound.buildNotifyResponse({ preview: true, sound: 'x.mp3' }); return d.status === 400 && d.kind === 'invalid'
    && d.play === '' && d.resolved === 'not-wav'; })(), JSON.stringify(sound.buildNotifyResponse({ preview: true, sound: 'x.mp3' })));
check('H4b preview + 文件不存在 ⇒ 400 且原因=missing（与「非 wav」可区分，客户端能给出对的提示）',
  (() => { const d = sound.buildNotifyResponse({ preview: true, sound: 'NoSuchSound.wav' }); return d.status === 400 && d.resolved === 'missing'; })());
check('H5 非 preview + 缺 sound ⇒ 弹通知、不播音（旧客户端向后兼容）',
  (() => { const d = sound.buildNotifyResponse({ title: 't', body: 'b' }); return d.status === 204 && d.notify === true && d.play === '' && d.fallback === false; })());
check('H6 非 preview + 空串 sound ⇒ 弹通知、不播音',
  (() => { const d = sound.buildNotifyResponse({ sound: '' }); return d.notify === true && d.play === ''; })());
check('H7 非 preview + 可用音 ⇒ 弹通知 + 播音',
  (() => { const d = sound.buildNotifyResponse({ sound: absWav }); return d.notify === true && d.play.includes('PlaySync'); })());
check('H8 非 preview + 非法值 ⇒ 回退音 + 204（v1.2 ③：字段写错不能让提醒变静音）',
  (() => { const d = sound.buildNotifyResponse({ sound: 'x.mp3' }); return d.status === 204 && d.notify === true
    && d.fallback === true && d.play === sound.systemDefaultPlayScript(); })());

// ── I. /sounds 与 /notify 的 HTTP 面（真起 server，同 main.cjs 判据）──────────
const testSound = sound; // 沿用同一实例
function startStub(deps) {
  const server = createServer((req, res) => {
    const cors = () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    };
    if (req.method === 'OPTIONS') { cors(); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/sounds') {
      cors(); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(deps.listSounds())); return;
    }
    if (req.method === 'POST' && req.url === '/notify') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); } catch { cors(); res.writeHead(400); res.end(); return; }
        // `exists` 只作为**探测接缝**传给判据，不属于 HTTP body ⇒ 传完就摘掉（否则判据看到的是坏形状）。
        const d = deps.buildNotifyResponse(payload, deps.exists);
        delete payload.exists;
        if (d.status !== 204) { cors(); res.writeHead(d.status); res.end(); return; }
        if (d.play) deps.played.push({ play: d.play, fallback: d.fallback, resolved: d.resolved });
        cors(); res.writeHead(204); res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return server;
}
const played = [];
const server = startStub({
  listSounds: testSound.listSounds,
  // 走**真实 fs 存在性**：假媒体库里有一个真文件（GOOD_NAME）。
  // 探测接缝只在单条用例上显式注入（见 I3b），别在这里全局恒真——那会把「缺文件 ⇒ 400」
  // 这类反例掩盖成假绿（本脚本真踩过这个坑）。
  buildNotifyResponse: testSound.buildNotifyResponse,
  played,
});
// 用 node:http 直连（不引 undici/fetch）：本脚本的要求是"浏览器会怎么被 CORS 拦"，判据是响应头，
// 用最薄的 socket 面即可，也免去 fetch 全局连接池在退出期的句柄噪音。
function httpCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const corsOf = (r) => r.headers['access-control-allow-origin'];
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const sRes = await httpCall('GET', '/sounds');
  const sJson = JSON.parse(sRes.text);
  check('I1 GET /sounds ⇒ 200 + {dir, sounds[]}', sRes.status === 200 && sJson.dir === fakeMedia && Array.isArray(sJson.sounds),
    JSON.stringify(sJson));
  check('I2 /sounds 只列 .wav（Decoy.txt 不在内）+ CORS 头',
    sJson.sounds.includes(GOOD_NAME) && sJson.sounds.includes('Alarm01.WAV') && !sJson.sounds.includes('Decoy.txt')
    && corsOf(sRes) === '*', JSON.stringify(sJson.sounds));

  const p1 = await httpCall('POST', '/notify', { title: 'T', body: 'B', sound: GOOD_NAME });
  check('I3 POST /notify 带 sound ⇒ 204 + 该音被播（真文件、真存在性）', p1.status === 204 && played.length === 1
    && played[0].fallback === false && played[0].resolved === join(fakeMedia, GOOD_NAME), JSON.stringify(played));
  // 探测接缝的用法：`exists` 是**函数**，不能走 HTTP（JSON 里函数会被序列化掉 ⇒ 测试自己发不出去）。
  // 所以这条用例直接打判据本体（单元面），证明「文件不存在 + 注入存在探测 ⇒ 走可用音分支」。
  const seam = sound.buildNotifyResponse({ preview: true, sound: 'NotOnDisk.wav', exists: () => true });
  check('I3b 注入存在探测（单元面）⇒ 204 + 走可用音分支（证明判据真接了探测函数）',
    seam.status === 204 && seam.fallback === false && seam.resolved === join(fakeMedia, 'NotOnDisk.wav'),
    JSON.stringify(seam));
  const p2 = await httpCall('POST', '/notify', { title: 'T', body: 'B' });
  check('I4 POST /notify 无 sound ⇒ 204 + 不播音（播放列表不增长）', p2.status === 204 && played.length === 1);
  const p3 = await httpCall('POST', '/notify', { preview: true, sound: 'gone.wav' });
  check('I5 POST /notify preview + 非法值（缺文件）⇒ 400 响亮失败，且不播音（v1.2 ②）',
    p3.status === 400 && played.length === 1, JSON.stringify({ status: p3.status, played: played.length }));
  const p4 = await httpCall('POST', '/notify', { preview: true, sound: 'x.mp3' });
  check('I6 POST /notify preview + 非 wav ⇒ 400，且不播音', p4.status === 400 && played.length === 1,
    JSON.stringify({ status: p4.status, played: played.length }));
  const p5 = await httpCall('POST', '/notify', { preview: true });
  check('I7 POST /notify preview 无音 ⇒ 204 + 系统默认音（v1.2 ①：设置页「默认」项试听听得见）',
    p5.status === 204 && played.length === 2 && played[1].fallback === true && played[1].resolved === 'default-system',
    JSON.stringify({ status: p5.status, played: played.length, last: played[1] }));
  check('I8 /notify 响应带 CORS 头（设置页跨端口要用）', corsOf(p1) === '*' && corsOf(p3) === '*' && corsOf(p5) === '*');

  const pre = await httpCall('OPTIONS', '/sounds');
  check('I9 OPTIONS ⇒ 204 + 三个 CORS 头 + 不做事', pre.status === 204
    && String(pre.headers['access-control-allow-methods'] || '').includes('POST')
    && pre.headers['access-control-allow-headers'] === 'content-type');
  const nf = await httpCall('GET', '/nope');
  check('I10 未知路径仍 404（CORS 没被滥加到全部响应）', nf.status === 404);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

// J. /sounds 目录不存在 ⇒ 空数组不报错
process.env.DSHOME_SOUND_DIR = join(fakeWin, 'NoSuchDir');
const goneDir = sound.listSounds();
check('J1 媒体目录不存在 ⇒ {sounds: []}（不是报错）',
  Array.isArray(goneDir.sounds) && goneDir.sounds.length === 0, JSON.stringify(goneDir));
process.env.DSHOME_SOUND_DIR = fakeMedia;

// ── K. host 插件接线（防假绿：判据对了但 notify.js 没接上）────────────────────
check('K1 schema 四个音色字段齐全',
  ['soundTurnCompletion', 'soundBackground', 'soundApproval', 'soundUserQuestion'].every((f) => notifySrc.includes(`${f}: z.string().default(`)));
check('K1b 开关字段齐全（含 v2 新增 notifyOnBackground）',
  ['enabled', 'notifyOnTurnCompletion', 'notifyOnApproval', 'notifyOnUserQuestion', 'notifyOnBackground']
    .every((f) => notifySrc.includes(`${f}: z.boolean().default(true)`)));
check('K2 冻结默认值逐字一致（v2：四音 + 新开关默认 true）',
  notifySrc.includes("soundTurnCompletion: z.string().default('Windows Notify System Generic.wav')")
  && notifySrc.includes("soundBackground: z.string().default('Windows Notify Email.wav')")
  && notifySrc.includes("soundApproval: z.string().default('Windows Notify Calendar.wav')")
  && notifySrc.includes("soundUserQuestion: z.string().default('Windows Notify Messaging.wav')")
  && notifySrc.includes('notifyOnBackground: z.boolean().default(true)'));
// ── 真值表：8 个 key → 4 个字段（从源码**抽取**，再逐条对冻结表）─────────────────
function extractTable(src, name) {
  // ⚠️ 用**括号配平**取值域，不能用 `\n};` 收尾：COPY 的值本身是 `{title, body}` ⇒ 非贪婪正则会
  // 在第一条的 `}` 处收手，静默只抽到最后一条（本脚本踩过这个坑，K3b 就此变红）。
  const decl = src.indexOf(`const ${name} = {`);
  if (decl < 0) return null;
  const open = src.indexOf('{', decl);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  const table = {};
  // 两层形态都要支持：
  //   ① 值直接是字符串（SOUND_BY_KEY）
  //   ② 值是 `{ title: '…', body: '…' }`（COPY）——**必须先匹配两层**，否则 `title:`/`body:` 这两个
  //      内层键会把表覆盖成 {title, body} 两条（本脚本踩过这个坑，K3b/K3c 就此变红）。
  for (const m of body.matchAll(/['"]?([\w-]+)['"]?:\s*\{\s*title:\s*'([^']*)'/g)) table[m[1]] = m[2];
  if (Object.keys(table).length === 0) {
    for (const m of body.matchAll(/['"]?([\w-]+)['"]?:\s*'([^']*)'/g)) table[m[1]] = m[2];
  }
  return table;
}
const SOUND_TABLE = extractTable(notifySrc, 'SOUND_BY_KEY');
const COPY_TABLE = extractTable(notifySrc, 'COPY');
const FROZEN_SOUND = {
  'turn-completed': 'soundTurnCompletion',
  'turn-failed': 'soundTurnCompletion',
  'job-completed': 'soundBackground',
  'job-failed': 'soundBackground',
  'member-completed': 'soundBackground',
  'member-failed': 'soundBackground',
  'approval-asked': 'soundApproval',
  'user-question': 'soundUserQuestion',
};
console.log(`—— SOUND_BY_KEY 真抽取（${SOUND_TABLE ? Object.keys(SOUND_TABLE).length : 0} 项）：${JSON.stringify(SOUND_TABLE)}`);
check('K3 真值表 8 个 key 逐条与冻结分组一致（job-*/member-* 必须指向 soundBackground）',
  SOUND_TABLE !== null && Object.keys(SOUND_TABLE).length === 8
  && Object.keys(FROZEN_SOUND).every((k) => SOUND_TABLE[k] === FROZEN_SOUND[k]),
  JSON.stringify(SOUND_TABLE));
check('K3b COPY 覆盖 8 个 key 且标题非空',
  COPY_TABLE !== null && Object.keys(FROZEN_SOUND).every((k) => typeof COPY_TABLE[k] === 'string' && COPY_TABLE[k].length > 0),
  JSON.stringify(COPY_TABLE));
check('K3c 成员文案标题逐字冻结', COPY_TABLE?.['member-completed'] === 'DSHOME 成员任务完成'
  && COPY_TABLE?.['member-failed'] === 'DSHOME 成员任务失败');
check('K4 deliver 的 POST body 真带上 sound（含 silentSound 清音分支 + 读模块级镜像）',
  /const sound = detail\?\.silentSound === true \? '' : soundForEvent\(currentSettings, key\)/.test(notifySrc)
  && /\bsound \}/.test(notifySrc));
check('K5 旧判据未动：主会话仍要 userInitiated + notifyOnTurnCompletion，节流 5s，问答侧仍过滤子代理',
  notifySrc.includes('if (!openTurn.userInitiated) return;')
  && notifySrc.includes('ATTENTION_THROTTLE_MS = 5000')
  && notifySrc.includes("if (reason === 'completed' && currentSettings.notifyOnTurnCompletion)")
  && notifySrc.includes("if (session.header?.origin === 'subagent') return;"));
check('K5b 单一真相源：apply 里**没有**局部 settings 副本，syncSettings 只写模块级',
  !/let\s+settings\s*=/.test(notifySrc)
  && /const syncSettings = \(next\) => \{ currentSettings = next; \};/.test(notifySrc)
  && !/settings\s*=\s*next;\s*currentSettings/.test(notifySrc));
// 反向对照（反例：把兜底对象改回旧字段 ⇒ 此行必红）
check('K6 schema 缺失分支的兜底设置自带四音 + 新开关（否则静默降级成空串）',
  /soundTurnCompletion: 'Windows Notify System Generic.wav'/.test(notifySrc)
  && /soundBackground: 'Windows Notify Email.wav'/.test(notifySrc)
  && /soundApproval: 'Windows Notify Calendar.wav'/.test(notifySrc)
  && /soundUserQuestion: 'Windows Notify Messaging.wav'/.test(notifySrc)
  && /notifyOnBackground: true/.test(notifySrc));

// ── K7. 真实数据面：把 notify.js 的**兜底默认设置**抽出来，喂给壳的判据做往返 ──────
// 为什么不用文本断言了事：契约是「host 写进 body 的 sound 值 ⇒ 壳能真播出来」。这里从源码
// 抽出真对象（不是抄一份），解析每条事件该带的音，再让 sound.cjs 真解析一次 ⇒ 两头对上才算通。
const fbMatch = notifySrc.match(/const DEFAULT_SETTINGS =[\s\S]*?:\s*\{\n([\s\S]*?)\n\s*\};/);
const fallbackSettings = (() => {
  if (!fbMatch) return null;
  try {
    return JSON.parse(`{${fbMatch[1]
      .replace(/'/g, '"')                                   // 源码用单引号 ⇒ 归一成 JSON 双引号
      .replace(/([A-Za-z_$][\w$]*):/g, '"$1":')
      .replace(/,\s*$/, '')}}`);
  } catch { return null; }
})();
console.log(`—— notify.js 兜底设置（真抽取）：${JSON.stringify(fallbackSettings)}`);
check('K7 兜底设置能抽出 9 个字段（5 开关 + 4 音色）',
  fallbackSettings !== null && Object.keys(fallbackSettings).length === 9, JSON.stringify(fallbackSettings));
// 与冻结默认值交叉核对（任一被改都要在本脚本留痕）
check('K8 抽取值与冻结默认值逐字一致（含 v2 的 notifyOnBackground / soundBackground）',
  fallbackSettings?.soundTurnCompletion === 'Windows Notify System Generic.wav'
  && fallbackSettings?.soundBackground === 'Windows Notify Email.wav'
  && fallbackSettings?.soundApproval === 'Windows Notify Calendar.wav'
  && fallbackSettings?.soundUserQuestion === 'Windows Notify Messaging.wav'
  && fallbackSettings?.notifyOnBackground === true
  && fallbackSettings?.enabled === true, JSON.stringify(fallbackSettings));
// 分组映射：用真默认值算出每条事件该带哪个音，再喂给壳判据 ⇒ 必须解析到 %WINDIR%\Media 下那个文件
const GROUP = { ...FROZEN_SOUND };
const EXPECT_SOUND = new Map([
  ['turn-completed', GOOD_NAME], ['turn-failed', GOOD_NAME],
  ['job-completed', 'Windows Notify Email.wav'], ['job-failed', 'Windows Notify Email.wav'],
  ['member-completed', 'Windows Notify Email.wav'], ['member-failed', 'Windows Notify Email.wav'],
  ['approval-asked', 'Windows Notify Calendar.wav'], ['user-question', 'Windows Notify Messaging.wav'],
]);
for (const [key, field] of Object.entries(GROUP)) {
  const value = fallbackSettings ? fallbackSettings[field] : undefined;
  // 真现场里 Calendar/Messaging 两个 wav 本机未必存在 ⇒ 用「注入 exists 恒真」的口径验**分组与路径**，
  // 用 GOOD_NAME 那一条验真存在性路径。
  const resolved = sound.resolveSoundPath(String(value ?? ''), () => true);
  check(`K9 ${key} ⇒ ${field} = ${JSON.stringify(value)} 且解析到 %WINDIR%\\Media`,
    value === EXPECT_SOUND.get(key) && resolved.ok === true && resolved.path === join(fakeMedia, String(value)),
    JSON.stringify({ value, resolved }));
}
// 真存在性往返：host 默认值里**真存在于假媒体库**的那一条必须真解析成功（其余只验路径）
check('K10 真存在性往返：默认音名 → 假 %WINDIR%\\Media 真文件 ⇒ ok',
  (() => { const r = sound.resolveSoundPath(fallbackSettings?.soundTurnCompletion ?? ''); return r.ok === true && existsSync(r.path); })());
// 反例对照：把分组映射接错（turn-completed 也读 soundApproval）⇒ 上面 K9 必须红
check('K11 对照：错分组（turn-completed 读 soundApproval）会与冻结表不符',
  fallbackSettings?.soundApproval !== EXPECT_SOUND.get('turn-completed'));

// K12. schema 里的 .default() 与兜底对象**交叉核对**（两个真值源必须一致 —— 只查一个会漏：
//      改 schema 默认值、兜底没改 ⇒ 设置面正常时音色变了而测试全绿）。
const SCHEMA_DEFAULTS = new Map(
  [...notifySrc.matchAll(/(\w+): z\.(?:string|boolean)\(\)\.default\(([^)]*)\)/g)]
    .map((m) => [m[1], m[2].trim().replace(/^'|'$/g, '')]));
console.log(`—— schema .default() 真抽取：${JSON.stringify(Object.fromEntries(SCHEMA_DEFAULTS))}`);
check('K12 schema 默认值 = 兜底对象值（两个真值源一致；改其中一个必红）',
  ['enabled', 'notifyOnTurnCompletion', 'notifyOnApproval', 'notifyOnUserQuestion', 'notifyOnBackground'].every((f) => SCHEMA_DEFAULTS.get(f) === 'true')
  && SCHEMA_DEFAULTS.get('soundTurnCompletion') === 'Windows Notify System Generic.wav'
  && SCHEMA_DEFAULTS.get('soundBackground') === 'Windows Notify Email.wav'
  && SCHEMA_DEFAULTS.get('soundApproval') === 'Windows Notify Calendar.wav'
  && SCHEMA_DEFAULTS.get('soundUserQuestion') === 'Windows Notify Messaging.wav'
  && SCHEMA_DEFAULTS.get('soundTurnCompletion') === fallbackSettings?.soundTurnCompletion
  && SCHEMA_DEFAULTS.get('soundBackground') === fallbackSettings?.soundBackground
  && SCHEMA_DEFAULTS.get('soundApproval') === fallbackSettings?.soundApproval
  && SCHEMA_DEFAULTS.get('soundUserQuestion') === fallbackSettings?.soundUserQuestion
  && SCHEMA_DEFAULTS.get('notifyOnBackground') === String(fallbackSettings?.notifyOnBackground),
  JSON.stringify(Object.fromEntries(SCHEMA_DEFAULTS)));

// ── K13. 成员通知判据「**真抽取 + 离线重放**」（v2 最容易做错的一格）─────────────
// 为什么这么写：notify.js 是 ESM host 插件（import 上游 + 注册服务），本脚本**加载不了**它；
// 但只做文本断言（"源码里有 memberSoundAllowed"）＝装饰品。折中且有效的办法：把它**真跑得动的
// 那一段**（判据本体：真值表 + 窗口函数 + trackMemberTurn）从源码里抽出来，配一套与源码同形的
// 桩（silentSound 语义 + 5s 会话窗口）现场求值 ⇒ 三分支是**真跑出来的**，不是 grep 出来的。
// 代价（诚实标注）：抽取失败会红（所以它同时是"源码结构被改"的哨兵），且桩须与源码同步——
// `deliverAttention` 的 5s 会话窗口本身仍由 settle 后的真时间验（K13c）。
function extractFunction(src, name) {
  // ⚠️ 必须容忍 CRLF：`notifySrc` 是原样读入的（**没**归一化换行），多行锚 `^…$` 里
  //    `$` 前面会撞上 `\r` ⇒ 抽不到、静默返回 null（本轮就踩了：桩里塞进字符串 "null"，
  //    一路变成一堆看不懂的假红）。所以开头用 `(?:\r?\n|^)` 而不是裸 `^`，并配 K13 的哨兵断言。
  const start = src.search(new RegExp(`(?:\\r?\\n|^)(?:(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\()`));
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1).replace(/^\r?\n/, '');
    }
  }
  return null;
}
const MEMBER_FN_SRC = extractFunction(notifySrc, 'trackMemberTurn');
const SOUND_WINDOW_SRC = extractFunction(notifySrc, 'memberSoundAllowed');
const MEMBER_COPY_SRC = extractFunction(notifySrc, 'memberCopy');
const MEMBER_LABEL_SRC = extractFunction(notifySrc, 'memberLabel');
const DELIVER_ATTENTION_SRC = extractFunction(notifySrc, 'deliverAttention');
check('K13 判据本体可从源码抽出（轨提取器失效也要红，别让这条判据静默变空）',
  [MEMBER_FN_SRC, SOUND_WINDOW_SRC, MEMBER_COPY_SRC, MEMBER_LABEL_SRC, DELIVER_ATTENTION_SRC]
    .every((s) => typeof s === 'string' && s.length > 0 && !/^null$/.test(s))
  && /trackMemberTurn/.test(MEMBER_FN_SRC ?? '') && /MEMBER_SOUND_WINDOW_MS/.test(SOUND_WINDOW_SRC ?? ''));
check('K13-null 抽取结果绝不是字符串 "null"（CRLF 抽取坑的哨兵：拼进桩会变成一堆假红）',
  ![MEMBER_FN_SRC, SOUND_WINDOW_SRC, MEMBER_COPY_SRC, MEMBER_LABEL_SRC, DELIVER_ATTENTION_SRC]
    .some((s) => String(s).trim() === 'null'));
// 「桩必须与真实现同形」的哨兵：**真实现的 deliverAttention 自己得能编译起来**。
// 本轮踩过的坑：把窗口逻辑从 trackMemberTurn 搬进 deliverAttention 后，桩仍是旧语义
// （先消费窗口再投递）⇒ 判据全绿而语义是旧的。这条断言让"真实现这段代码存在且可编译"变成前提。
check('K13-crlf 抽取出的函数体真实可编译（能 new Function 起来，不是半截）',
  (() => {
    try {
      new Function(`${MEMBER_LABEL_SRC}\n${MEMBER_COPY_SRC}\n${SOUND_WINDOW_SRC}\n${DELIVER_ATTENTION_SRC}\n${MEMBER_FN_SRC}`);
      return true;
    } catch { return false; }
  })());
check('K13-shape 真实现的 deliverAttention 满足第 3 件语义（返回真投递 + 窗口只在投递时消费 + 只有成员认领窗口）',
  /if \(detail\?\.memberSound === true\) \{/.test(DELIVER_ATTENTION_SRC ?? '')
  && /if \(withSound\) lastMemberSoundAt = now;/.test(DELIVER_ATTENTION_SRC ?? '')
  && /return true;/.test(DELIVER_ATTENTION_SRC ?? '')
  && /return false;/.test(DELIVER_ATTENTION_SRC ?? ''));

// 桩：与源码同形的"投递"语义（silentSound 清音 + 同会话 5s 窗口 + 音效窗口**只在真投递时消费**）。
// `settingsAt` 是桩的**自己的**设置真相源（源码里现在也只有一份：模块级 `currentSettings`）。
function makeHostReplay(initialSettings) {
  const sent = [];
  const lastAttentionAt = new Map();
  let lastMemberSoundAt = 0;
  const replaySettings = { ...(initialSettings ?? {}) };
  const setSettings = (next) => { Object.keys(replaySettings).forEach((k) => { delete replaySettings[k]; }); Object.assign(replaySettings, next); };
  const oneLine = (text, max = 120) => {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (flat.length === 0) return '';
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  const deliver = (key, detail) => {
    const field = SOUND_TABLE?.[key];
    const value = replaySettings[field];
    sent.push({
      key,
      sound: detail?.silentSound === true ? '' : (typeof value === 'string' ? value : ''),
      silentSound: detail?.silentSound === true,
      title: detail?.title ?? COPY_TABLE?.[key],
      body: detail?.body ?? COPY_TABLE?.[key],
    });
  };
  // ⚠️ 返回"是否真投递"、且**音效窗口只在真投递时消费**——这两点必须与真实现同形，
  // 否则"窗口被节流吞掉却仍消费"这类 bug 在桩上测不出来（K13h 就是钉这个的）。
  // **不再在桩里手写一份**：`deliverAttention` 直接用真实现（注入进来，见下），
  // 免得"真实现改了、桩没跟上"（本轮踩过两次：窗口搬进 deliverAttention、以及
  // 非成员通知也去消费窗口）。
  const ctx = {
    sent, replaySettings, setSettings,
    get lastMemberSoundAt() { return lastMemberSoundAt; },
    set lastMemberSoundAt(v) { lastMemberSoundAt = v; },
    SOUND_BY_KEY: SOUND_TABLE,
    COPY: COPY_TITLES,
    MEMBER_SOUND_WINDOW_MS: 5000,
    ATTENTION_THROTTLE_MS: 5000,
    lastAttentionAt,
    oneLine, deliver,
  };
  // ⚠️ 真源码里 `trackMemberTurn` 读的是**模块级 currentSettings**，桩这边对应 `replaySettings`。
  //    注进去之后 `MEMBER_FN_SRC` 才与真实现同形（第 1 件改动的正是这一条）。
  const memberFn = MEMBER_FN_SRC.replace(/currentSettings/g, 'replaySettings');
  // ⚠️ 窗口状态在桩里也**只有一份**：把真实现 `deliverAttention` 注入进来、并把其中对
  //    `lastMemberSoundAt` 的读写都改写成 `ctx.lastMemberSoundAt`（走 getter/setter 直连外层闭包）。
  //    教训与真源码同源：先前 wrapper 里留了一份局部 `lastMemberSoundAt`，真实现写的是外层、
  //    `getLastAt()` 读的是 wrapper 副本 ⇒ 永远读到 0（K13h 假红）。
  //    注意 `ctx.lastMemberSoundAt = v` 不是"给 ctx 换值"，而是走 setter 写外层闭包变量。
  const attentionFn = DELIVER_ATTENTION_SRC.replace(/lastMemberSoundAt/g, 'ctx.lastMemberSoundAt');
  const body = [MEMBER_LABEL_SRC, MEMBER_COPY_SRC, SOUND_WINDOW_SRC, attentionFn, memberFn].join('\n');
  const factory = new Function(
    'ctx',
    `const { replaySettings, oneLine, deliver, SOUND_BY_KEY, COPY, MEMBER_SOUND_WINDOW_MS, ATTENTION_THROTTLE_MS, lastAttentionAt } = ctx;
     ${body}
     return { trackMemberTurn, memberLabel, memberSoundAllowed };`,
  );

  const api = factory(ctx);
  return {
    sent,
    api,
    setSettings,
    setLastAt(v) { ctx.lastMemberSoundAt = v; },
    getLastAt() { return ctx.lastMemberSoundAt; },
  };
}
const memberEvents = (session, kinds) => kinds.map((kind) => ({ type: 'turn/end', data: { turn: 1, reason: { kind } } }));
// ⚠️ 抽取器对 COPY 只能拿到**标题**（真结构是 `{title, body}`，扁平抽取取到的是 title 串）。
// 桩里的 `COPY` 因此只保证标题可用；正文由判据自己拼（成员文案正文本来就是拼出来的）。
const COPY_TITLES = Object.fromEntries(Object.entries(COPY_TABLE ?? {}).map(([k, v]) => [k, { title: v, body: v }]));
const MEMBER_SESSION = { header: { id: '4131ff45-1e65-48b2-8feb-94f64b611bcc', origin: 'subagent' } };
const BACKGROUND_SETTINGS = {
  enabled: true, notifyOnBackground: true,
  soundTurnCompletion: 'Windows Notify System Generic.wav',
  soundBackground: 'Windows Notify Email.wav',
};

const replayOff = makeHostReplay({ ...BACKGROUND_SETTINGS, notifyOnBackground: false });
for (const e of memberEvents(MEMBER_SESSION, ['completed'])) replayOff.api.trackMemberTurn(MEMBER_SESSION, e);
check('K13a 成员通知三分支①：notifyOnBackground=false ⇒ 不投递（一条都不发）', replayOff.sent.length === 0,
  JSON.stringify(replayOff.sent));
// 同一条反例的第二形态：**运行期改设置**（单一真相源下，改一处就该立刻生效）
const replayToggle = makeHostReplay(BACKGROUND_SETTINGS);
replayToggle.setSettings({ ...BACKGROUND_SETTINGS, notifyOnBackground: false });
replayToggle.api.trackMemberTurn(MEMBER_SESSION, memberEvents(MEMBER_SESSION, ['completed'])[0]);
check('K13a2 运行期把 notifyOnBackground 改假 ⇒ 立刻不投递（单一真相源生效，无副本残留）',
  replayToggle.sent.length === 0, JSON.stringify(replayToggle.sent));

const replayOn = makeHostReplay(BACKGROUND_SETTINGS);
replayOn.api.trackMemberTurn(MEMBER_SESSION, memberEvents(MEMBER_SESSION, ['completed'])[0]);
check('K13b 成员通知三分支②：开关开 ⇒ 投递 member-completed 且音＝soundBackground',
  replayOn.sent.length === 1 && replayOn.sent[0].key === 'member-completed'
  && replayOn.sent[0].sound === 'Windows Notify Email.wav'
  && replayOn.sent[0].silentSound === false,
  JSON.stringify(replayOn.sent));
check('K13b2 文案带上成员信息（id 兜底 ⇒ 「会话 4131ff45」）',
  String(replayOn.sent[0]?.body ?? '').includes('会话 4131ff45'), JSON.stringify(replayOn.sent[0]?.body));
// ③ 音效全局窗口：另一个成员会话在 5s 内交卷 ⇒ 通知照发，但 sound 必须是空串
const SECOND_MEMBER = { header: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', origin: 'subagent', label: '音色后端' } };
replayOn.api.trackMemberTurn(SECOND_MEMBER, memberEvents(SECOND_MEMBER, ['completed'])[0]);
check('K13c 成员通知三分支③：5s 窗口内第二条 ⇒ 通知照发、sound === ""（全局音效节流）',
  replayOn.sent.length === 2 && replayOn.sent[1].key === 'member-completed'
  && replayOn.sent[1].sound === '' && replayOn.sent[1].silentSound === true,
  JSON.stringify(replayOn.sent));
check('K13c2 第二条的文案用会话头 label（成员「音色后端」）',
  String(replayOn.sent[1]?.body ?? '').includes('音色后端'), JSON.stringify(replayOn.sent[1]?.body));
// 反向对照：把"上次配音时刻"推到窗口外 ⇒ 第三条又该带音（证明不是"永远只有第一条有音"）
// ⚠️ 三条都踩过、都记在这儿：① 必须传**完整事件**（第一次误把 kind 当事件传）；
//    ② kind 必须是契约里的取值（`error`，不是 `'failed'`——`job-*` 那条路才用 'failed'，那是 job snapshot.status）；
//    ③ 窗口判定现在**在 deliverAttention 里**（绑定到真投递）⇒ 重置 `lastMemberSoundAt` 必须发生在
//       "触发第三条"之前，否则那条自己会把窗口消费掉（改完第 3 件后第一次就是踩这个红掉的）。
const THIRD_MEMBER = { header: { id: '11111111-2222-3333-4444-555555555555', origin: 'subagent' } };
const backdated = Date.now() - 6000;
replayOn.setLastAt(backdated);
console.log(`—— K13d 前置：lastMemberSoundAt=${replayOn.getLastAt()}（期望 ${backdated}） allowed=${replayOn.api.memberSoundAllowed(Date.now(), replayOn.getLastAt())}`);
replayOn.api.trackMemberTurn(THIRD_MEMBER, memberEvents(THIRD_MEMBER, ['error'])[0]);
console.log(`—— K13d 后置：sent=${replayOn.sent.length} lastMemberSoundAt=${replayOn.getLastAt()}`);
check('K13d 对照：窗口过后 ⇒ 第三条是 member-failed 且带音（不是"永久静音"）',
  replayOn.sent.length === 3 && replayOn.sent[2].key === 'member-failed' && replayOn.sent[2].sound === 'Windows Notify Email.wav',
  JSON.stringify(replayOn.sent));
// 同一根因的第二道锁：把 kind 写成不存在的取值（如 'failed'）必须**不投递**（防有人把它当合法 kind 用）
const replayBadKind = makeHostReplay(BACKGROUND_SETTINGS);
const badSession = { header: { id: 'bad-kind-session', origin: 'subagent' } };
replayBadKind.api.trackMemberTurn(badSession, memberEvents(badSession, ['failed'])[0]);
check('K13d2 不存在于契约的 kind（\'failed\'）⇒ 不投递（避免"看着像合法"的假判据）',
  replayBadKind.sent.length === 0, JSON.stringify(replayBadKind.sent));
// 同一会话重试：5s 内只发一条（契约：同一会话仍走原节流，别让重试刷屏）
const retryCount = replayOn.sent.length;
replayOn.api.trackMemberTurn(MEMBER_SESSION, memberEvents(MEMBER_SESSION, ['completed'])[0]);
check('K13e 同一会话 5s 内第二次 ⇒ 被会话窗口吃掉（不投递）', replayOn.sent.length === retryCount);

// ★ 第 3 件的正面判据：**窗口授权与投递绑定** —— 被同会话节流吞掉的那条，不许消费音效窗口。
// 场景：A 交卷（带音、消费窗口）→ 把窗口状态重置成"从未响过" → A 又被节流吞 → B 交卷。
// 旧顺序（**先**消费窗口再交投递）下，被吞的 A 已把 lastMemberSoundAt 设成 now ⇒ B 静音 ⇒ 本行必红。
const replayWindow = makeHostReplay(BACKGROUND_SETTINGS);
const A2 = { header: { id: 'win2-A', origin: 'subagent' } };
const B2 = { header: { id: 'win2-B', origin: 'subagent' } };
replayWindow.api.trackMemberTurn(A2, memberEvents(A2, ['completed'])[0]);   // A 交卷（带音，窗口被真投递消费）
const atAfterRealDelivery = replayWindow.getLastAt();
replayWindow.setLastAt(0);                                                  // 重置窗口：模拟"从未响过"
replayWindow.api.trackMemberTurn(A2, memberEvents(A2, ['completed'])[0]);   // A 再交卷 ⇒ 被同会话节流吞掉
replayWindow.api.trackMemberTurn(B2, memberEvents(B2, ['completed'])[0]);   // B 交卷 ⇒ 窗口没被吞掉的那条消费，B 必须带音
console.log(`—— K13h 读数：A 真投递后 lastMemberSoundAt=${atAfterRealDelivery}；重置+吞掉后=${replayWindow.getLastAt()}；sent=${replayWindow.sent.length}`);
check('K13h 被同会话节流吞掉的那条**不消费**音效窗口 ⇒ 随后 B 交卷必须带音（改回旧顺序 ⇒ 必红）',
  atAfterRealDelivery > 0 && replayWindow.sent.length === 2 && replayWindow.sent[1].key === 'member-completed'
  && replayWindow.sent[1].sound === 'Windows Notify Email.wav' && replayWindow.sent[1].silentSound === false,
  JSON.stringify({ atAfterRealDelivery, after: replayWindow.getLastAt(), sent: replayWindow.sent }));
// 同一条判据的"反向可判性"：把窗口摆成真的还没过 ⇒ B 必须**没音**（证明上一条不是"永远给音"的假绿）
const replayWindow3 = makeHostReplay(BACKGROUND_SETTINGS);
const A3 = { header: { id: 'win3-A', origin: 'subagent' } };
const B3 = { header: { id: 'win3-B', origin: 'subagent' } };
replayWindow3.api.trackMemberTurn(A3, memberEvents(A3, ['completed'])[0]);   // A 带音（窗口=now）
replayWindow3.api.trackMemberTurn(B3, memberEvents(B3, ['completed'])[0]);   // B 紧随其后 ⇒ 窗口没过 ⇒ 无音
check('K13h2 对照：窗口真没过时 B 必须无音（证明 K13h 不是"永远给音"）',
  replayWindow3.sent.length === 2 && replayWindow3.sent[1].sound === '' && replayWindow3.sent[1].silentSound === true,
  JSON.stringify(replayWindow3.sent));
// 契约边界：aborted / interrupted 不在 v2 两类里 ⇒ 明确不投递（不许自己发明归类）
const replayEdge = makeHostReplay(BACKGROUND_SETTINGS);
for (const kind of ['aborted', 'interrupted']) {
  const s = { header: { id: `edge-${kind}`, origin: 'subagent' } };
  replayEdge.api.trackMemberTurn(s, memberEvents(s, [kind])[0]);
}
check('K13f 契约边界：aborted / interrupted ⇒ 不投递（v2 只定义 completed 与 error/max-tokens）',
  replayEdge.sent.length === 0, JSON.stringify(replayEdge.sent));
// 成员会话**不要求 userInitiated**：全程没出现过 user/message，①②③ 仍投递（已由上面覆盖）
check('K13g 成员判据只认 turn/end（turn/start、user/message 不触发投递）',
  (() => { const r = makeHostReplay(BACKGROUND_SETTINGS); const s = MEMBER_SESSION;
    r.api.trackMemberTurn(s, { type: 'turn/start', data: { turn: 1 } });
    r.api.trackMemberTurn(s, { type: 'user/message', data: { source: { kind: 'user' } } });
    return r.sent.length === 0; })());

// ── K14. 用**真事件形状**跑一遍（本机实测取证的原样载荷，不是我们臆想的形状）─────────
// 夹具来源（可复现，勿凭印象改）：`E:\DSHOME\sessions\--E-DSHOME--\<某个 origin:'subagent' 会话>\session.v3.jsonl.zstd`
// 逐帧解出来的真实记录；子会话头长这样（delegationDepth=1 / 有 parentSession / origin='subagent'）：
const REAL_MEMBER_HEADER = { id: '4131ff45-1e65-48b2-8feb-94f64b611bcc', origin: 'subagent', delegationDepth: 1, parentSession: 'session-39e8aa01-f7b8-4adb-a95d-7537e5150ce2', agentPreset: 'standard', cwd: 'E:\\DSHOME' };
const REAL_TURN_END = { type: 'turn/end', seq: 434, time: 1790494000000, data: { turn: 1, reason: { kind: 'completed' } } };  // ← 真记录原样（只把 seq/time 定死便于复现）
const replayReal = makeHostReplay(BACKGROUND_SETTINGS);
replayReal.api.trackMemberTurn({ header: REAL_MEMBER_HEADER }, REAL_TURN_END);
check('K14 真事件形状（origin=subagent 的 turn/end completed）⇒ 投递 member-completed + soundBackground',
  replayReal.sent.length === 1 && replayReal.sent[0].key === 'member-completed'
  && replayReal.sent[0].sound === 'Windows Notify Email.wav', JSON.stringify(replayReal.sent));
check('K14b 真头部的 id 兜底可辨认（「会话 4131ff45」）',
  String(replayReal.sent[0]?.body ?? '').includes('4131ff45'), JSON.stringify(replayReal.sent[0]?.body));
// 反例对照：把 origin 改成非 subagent ⇒ 这条判据的输入就不再是"成员"，证明它确实看 origin
check('K14c 对照：同一事件但 origin 不是 subagent ⇒ 该分支不该认（证明判据真看 origin）',
  (() => { const r = makeHostReplay(BACKGROUND_SETTINGS);
    r.api.trackMemberTurn({ header: { ...REAL_MEMBER_HEADER, origin: undefined } }, REAL_TURN_END);
    return r.sent.length === 1; })() === true
  // 说明：trackMemberTurn 本身不判 origin（那是 trackTurn 的入口分流，见 L10）⇒ 这里只锁「入口分流」在源码里
  && /if \(session\.header\?\.origin === 'subagent'\) \{\s*\n\s*trackMemberTurn\(session, event\);/.test(notifySrc));

// ── RL. 真加载（本文件最贵的一节）：真 import 真模块 + 假宿主 apply + 真触发投递 ──────
// 为什么必须有它（2026-09-27 阻断级事故）：K 系列的"抽函数重放"桩里自带 `settings` **形参**，
// 于是**绕过了模块的真实作用域** —— 判据验的是"这段逻辑对不对"，没验"这段逻辑在真模块里跑不跑得起来"。
// 实测炸法：`deliver()`（模块级）里写了 `soundForEvent(settings, key)`，而 `settings` 只是 `apply()`
// 的局部变量 ⇒ 每次投递 ReferenceError ⇒ **async 无人 catch ⇒ Node 直接杀掉整个后端**
// （壳日志：`{"backend":"exit","code":1,"errTail":" at trackAttention (notify.js:324:5)"}`）。
// 该探针用子进程跑：真模块里若还有同类错误，Node 会以非零码退出，**不会把本脚本自己带走**。
const RL_FIXTURE_SRC = `
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const errors = [];
const rejections = [];
process.on('unhandledRejection', (error) => { rejections.push(String((error && error.message) || error)); errors.push('unhandledRejection: ' + String((error && error.message) || error)); });
process.on('uncaughtException', (error) => errors.push('uncaughtException: ' + String((error && error.message) || error)));

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { received.push({ url: req.url, body }); res.writeHead(204); res.end(); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
// 端口指到本进程的假壳：**绝不碰 32123**（不弹真通知、不出声）。
process.env.DSHOME_NOTIFY_PORT = String(server.address().port);

// 兜底超时：模块 import 阶段崩掉时（本探针的反例 B）进程不会自己退，服务器会挂住 ⇒ 必须自己响铃退出。
const watchdog = setTimeout(() => {
  console.log('RL_RESULT=' + JSON.stringify({ errors: errors.concat(['watchdog: 探针超时（模块没加载完/没跑完）']), received: received.length, node: process.version }));
  process.exit(1);
}, 8000);
watchdog.unref?.();

let mod = null;
try {
  mod = await import(pathToFileURL(process.argv[2]).href);
} catch (error) {
  errors.push('import threw: ' + String((error && error.message) || error));
  console.log('RL_RESULT=' + JSON.stringify({ errors, received: received.length, node: process.version }));
  process.exit(1);
}

// ⚠️ 假 ctx 的坑（Lead 亲自踩过、判据因此假绿过一次）：服务方法必须**平铺**在服务对象上，
// 因为插件按 cordis 习惯写 \`sessionsCtx.on(...)\` / \`jobsCtx.jobs.onJobDone(...)\`；
// 写成 \`{ sessions: { on } }\` 会 \`TypeError: sessionsCtx.on is not a function\`，
// 而插件自己的 try/catch 会把它**吞掉** ⇒ "没抛" ≠ "接上了"（所以下面还必须断言"真订阅到了"）。
const disposers = [];
const seen = { sessionEvent: 0, jobDone: 0 };
const sessionHandlers = [];
const jobDoneHandlers = [];
const stubEffect = (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; };
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  inject: (names, fn) => {
    // ⚠️ 两个必须照抄的口径（都能让判据**假绿**，本文件两版都踩过）：
    //   ① 回调拿到的服务是**平铺**的：插件写 \`sessionsCtx.on(...)\` / \`jobsCtx.jobs.onJobDone(...)\`
    //      ⇒ 必须给 \`{ ...sessions, ...jobs, effect }\`，写成 \`{ sessions: {...}, jobs: {...} }\`
    //      会 \`TypeError: sessionsCtx.on is not a function\`。
    //   ② \`effect\` 是 **ctx** 的方法、不是服务：\`sessionsCtx.effect(fn)\` 也得能用。
    //   ③ 第三个假绿坑：\`scope.get()\` 若返回 \`{}\`，插件里 \`settings.enabled\` 为假 ⇒ **所有分支早退**、
    //      投递一条都不发生，而 apply 照样"没抛" ⇒ 判据全绿却什么都没验。这里返回**真 schema 默认值**。
    //   而插件把①②都包在 try/catch 里 ⇒ 报错只会变成一行 WARN，**"没抛" ≠ "接上了"**，
    //   所以下面还必须断言"真订阅到了 session/event / onJobDone"+"真收到投递"。
    const services = {};
    for (const n of names) {
      if (n === 'settings') Object.assign(services, { settings: { register: () => ({ get: () => mod.NotifySettingsSchema({}), watch: () => () => {} }) } });
      else if (n === 'sessions') Object.assign(services, { on: (name, handler) => { if (name === 'session/event') { seen.sessionEvent += 1; sessionHandlers.push(handler); } return () => {}; } });
      else if (n === 'jobs') Object.assign(services, { jobs: { onJobDone: (handler) => { seen.jobDone += 1; jobDoneHandlers.push(handler); return () => {}; } } });
    }
    fn({ ...services, effect: stubEffect });
  },
};
try { mod.apply(ctx); } catch (error) { errors.push('apply threw: ' + String((error && error.message) || error)); }
if (seen.sessionEvent === 0) errors.push('apply 没有订阅 session/event（判据接不上，必须硬失败）');
if (seen.jobDone === 0) errors.push('apply 没有订阅 jobs.onJobDone');

const notify = async (session, event) => { for (const h of sessionHandlers) await h(session, event); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const userSession = (id) => ({ header: { id } });

// ① 主会话「用户发起的回合」：turn/start → user/message(kind=user) → turn/end(completed)
await notify(userSession('probe-main-1'), { type: 'turn/start', data: { turn: 1 } });
await notify(userSession('probe-main-1'), { type: 'user/message', data: { turn: 1, source: { kind: 'user' } } });
await notify(userSession('probe-main-1'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
// ② 模型提问（走 tool/call）
await notify(userSession('probe-main-2'), { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"questions":[{"header":"选哪个"}]}' } });
// ③ 后台任务（走 jobs.onJobDone）
for (const h of jobDoneHandlers) h({ status: 'completed' });
// ④ 成员（subagent）会话回合结束（v2 新码路径：trackTurn → trackMemberTurn → deliverAttention）
await notify({ header: { id: 'probe-member-1', origin: 'subagent', label: '音色后端' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await wait(400);

const parsed = received.map((r) => { try { return JSON.parse(r.body); } catch { return null; } });
await new Promise((resolve) => server.close(resolve));
clearTimeout(watchdog);
console.log('RL_RESULT=' + JSON.stringify({
  errors,
  received: received.length,
  urls: [...new Set(received.map((r) => r.url))],
  titles: parsed.map((p) => p && p.title),
  bodies: parsed.map((p) => p && p.body),
  sounds: parsed.map((p) => p && p.sound),
  sessionEventCount: seen.sessionEvent,
  jobHandlerCount: seen.jobDone,
  // 第 2 件的判据面：deliver 的 promise 若 reject，这个 listener 会捕到并把 errors 填上。
  deliverRejections: rejections,
  node: process.version,
}));
// ⚠️ 装了 unhandledRejection 监听器 = **接管**了 Node 的默认"打日志并 exit 1"⇒ 必须自己响亮退出，
// 否则反例探针会以 exit 0 收场（那正是"假绿"：真后端的崩法就是无人 catch 的 rejected promise）。
if (errors.length > 0) process.exit(1);
`;

// ── 工作区保护（2026-09-27 事故后重建）────────────────────────────────────────
// 事故：`--mutate` 曾**原地**改工作区源文件，一次超时把 `notify.js` 留在变异态（脚本却报
// `restored=True`）⇒ verify-host-plugins 报"notify: import 失败"（**假红**），
// Lead 并发跑的 stage-payload 还把变异版同步进了 payload。
// 现在的铁律：**变异一律在临时副本上做**，工作区文件全程只读；跑完再逐文件 sha256 自证。
const WORKSPACE_FILES = [
  join(repoRoot, 'packages', 'dshome', 'lib', 'host', 'notify.js'),
  join(repoRoot, 'packages', 'dshome', 'shell-app', 'main.cjs'),
  join(repoRoot, 'packages', 'dshome', 'shell-app', 'sound.cjs'),
];
const DEFAULT_NOTIFY_FILE = WORKSPACE_FILES[0];
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
// 变异态下，子进程要 import 的**源文件路径**由本环境变量指过去。
// ⚠️ 副本必须与源文件**同目录**：`notify.js` 里有 `./upstream.js` 相对导入，
//    放到 %TEMP% 会 `Cannot find module ...upstream.js`（本轮第一次改造就是这么红的）。
const NOTIFY_FILE_ENV = 'DSH_VERIFY_NOTIFY_FILE';
const NOTIFY_DIR = join(repoRoot, 'packages', 'dshome', 'lib', 'host');
const MUTANT_PREFIX = 'dshome-verify-mutant-';
const MUTANT_SUFFIX = '.mjs';
function notifyFileUnderTest() {
  const override = process.env[NOTIFY_FILE_ENV];
  return typeof override === 'string' && override.trim() !== '' ? override : DEFAULT_NOTIFY_FILE;
}
/** 在**仓库目录内**建一个一次性变异副本（同目录 ⇒ 相对导入有效），返回路径与清理函数。 */
function makeMutantCopy(bytes, suffix) {
  const file = join(NOTIFY_DIR, `${MUTANT_PREFIX}${suffix}${MUTANT_SUFFIX}`);
  writeFileSync(file, bytes);
  // 若上一轮异常退出留下残骸，这里也会被覆盖（同名）；清理挂在 finally/收尾两处。
  return { file, cleanup: () => { try { rmSync(file, { force: true }); } catch { /* 清理失败不影响结论 */ } } };
}
/** 收尾兜底：任何残骸都不许留在仓库目录里。 */
function sweepMutantCopies() {
  try {
    for (const name of readdirSync(NOTIFY_DIR)) {
      if (name.startsWith(MUTANT_PREFIX) && name.endsWith(MUTANT_SUFFIX)) rmSync(join(NOTIFY_DIR, name), { force: true });
    }
  } catch { /* 目录读不到就跳过 */ }
}

const WORKSPACE_SNAPSHOT_AT_START = new Map(WORKSPACE_FILES.map((f) => {
  try { return [f, { sha: sha256File(f), bytes: readFileSync(f) }]; } catch { return [f, { sha: '<读不到>', bytes: null }]; }
}));
/**
 * 工作区完整性自证（**每次跑都执行**，不只是 `--mutate`）：逐个 sha256 与开跑前比对，
 * 不一致 ⇒ 打印漂移 → **尝试用开跑前字节恢复** → 再比对 → 响亮失败（exit 2）。
 * 为什么放在最外层：2026-09-27 事故里，变异残留让 `notify.js` 直接解析不过，
 * 脚本压根走不到"收尾自证" ⇒ 必须有一个**先于一切业务逻辑**的兜底。
 * @returns {boolean} true = 三文件与开跑前逐字节一致
 */
function verifyWorkspaceIntegrity(stage) {
  if (process.env.DSHOME_SKIP_WORKSPACE_GUARD === '1') return true;
  const drift = [];
  for (const [file, snap] of WORKSPACE_SNAPSHOT_AT_START) {
    let now = '<读不到>';
    try { now = sha256File(file); } catch { /* 保持读不到 */ }
    if (now !== snap.sha) drift.push({ file, before: String(snap.sha).slice(0, 12), after: String(now).slice(0, 12) });
  }
  if (drift.length === 0) {
    console.log(`—— 工作区完整性自证（${stage}）：✅ ${WORKSPACE_FILES.map((f) => `${f.split(/[\\/]/).pop()}=${sha256File(f).slice(0, 12)}`).join(' / ')} 与开跑前逐字节一致`);
    return true;
  }
  console.error(`verify-notify-sound: ❌ 工作区源文件与开跑前不一致（${drift.length} 个）——${JSON.stringify(drift)}`);
  let restored = 0;
  for (const [file, snap] of WORKSPACE_SNAPSHOT_AT_START) {
    if (snap.bytes === null) continue;
    try {
      if (sha256File(file) !== snap.sha) { writeFileSync(file, snap.bytes); restored += 1; }
    } catch { /* 恢复失败也要继续走响亮失败 */ }
  }
  let okAfter = true;
  for (const [file, snap] of WORKSPACE_SNAPSHOT_AT_START) {
    try { if (sha256File(file) !== snap.sha) okAfter = false; } catch { okAfter = false; }
  }
  console.error(`verify-notify-sound: 已用开跑前字节恢复 ${restored} 个文件；恢复后是否与开跑前一致：${okAfter ? '是' : '否（请人工恢复！）'}`);
  process.exitCode = 2;   // 语义化：2 = 判据自身污染了工作区（区别于 1 = 断言失败）
  return false;
}
// 顶层立刻自证一次：上一次跑的残留若还在，这里就报（哪怕本脚本随后会因解析失败退出）。
verifyWorkspaceIntegrity('入口');

function runRealLoadProbe(label, mutate) {
  // 变异只在**副本**上做：读源（工作区，或 M 套件给的环境变量副本）→ 改 → 写**同目录一次性副本** →
  // 让 fixture import 那个副本。⚠️ 工作区文件永远只读（事故就出在"原地改 + 看着很稳的 finally"）。
  const target = notifyFileUnderTest();
  let probeTarget = target;
  let mutated = false;
  let cleanup = null;
  if (typeof mutate === 'function') {
    // ⚠️ 这里**不做**"拒绝原地改"的 throw：本函数从设计上就只写副本（`makeMutantCopy`），
    //    真正守住工作区的是"**只写副本**"这条实现 + 入口/收尾两次 sha256 自证。
    //    （上一版加过 throw，结果把"读工作区原文 → 改副本"这条合法路径也拒了 ⇒ RL 组直接崩。）
    const original = readFileSync(target, 'utf8');
    const patched = mutate(original);
    if (patched !== original) {
      const copy = makeMutantCopy(patched, label);
      cleanup = copy.cleanup;
      probeTarget = copy.file;
      mutated = true;
    }
  }
  const fixtureFile = join(fakeWin, `rl-probe-${label}.mjs`);
  writeFileSync(fixtureFile, RL_FIXTURE_SRC);
  let run;
  try {
    run = spawnSync(process.execPath, [fixtureFile, probeTarget], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  } finally {
    if (cleanup) cleanup();   // 副本生命周期与本次探针一致（异常路径也清）
  }
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('RL_RESULT=')) || '';
  let result = null;
  if (line !== '') { try { result = JSON.parse(line.slice('RL_RESULT='.length)); } catch { result = null; } }
  return { status: run.status, out, result, line, mutated, probeTarget };
}

const rlWorkspaceShaAtStart = sha256File(DEFAULT_NOTIFY_FILE);
const rl = runRealLoadProbe('real');
console.log(`—— 真加载探针（真 import + 假宿主 apply + 真投递）：status=${rl.status} ${rl.line.slice(0, 420)}`);
check('RL1 真模块 apply 无异常（假宿主口径：服务方法平铺）', rl.result !== null && rl.result.errors.length === 0,
  JSON.stringify(rl.result?.errors ?? rl.out.slice(-400)));
check('RL2 真订阅到了 session/event 与 jobs.onJobDone（判据真接上了，不是被 try/catch 吞掉）',
  (rl.result?.sessionEventCount ?? 0) > 0 && (rl.result?.jobHandlerCount ?? 0) > 0, rl.line.slice(0, 200));
check('RL3 真触发投递：假壳真收到 ≥2 条（"没走到 deliver"必须硬失败——只断言"没抛"就是假绿）',
  (rl.result?.received ?? 0) >= 2, JSON.stringify({ received: rl.result?.received }));
check('RL4 投递打到 /notify，且四类语义齐全（turn-completed / user-question / job-completed / member-completed）',
  (rl.result?.urls ?? []).length > 0 && (rl.result?.urls ?? []).every((u) => u === '/notify')
  && ['DSHOME 回合完成', 'DSHOME 有个问题等你回答', 'DSHOME 后台任务完成', 'DSHOME 成员任务完成'].every((t) => (rl.result?.titles ?? []).includes(t)),
  JSON.stringify(rl.result?.titles));
check('RL5 每条 body 真带 sound 且值来自默认设置（证明真模块读到了模块级镜像 currentSettings）',
  (rl.result?.sounds ?? []).length >= 4
  && rl.result.sounds.every((s) => typeof s === 'string' && s.endsWith('.wav'))
  && rl.result.sounds.includes('Windows Notify System Generic.wav'),   // 主任务音
  JSON.stringify(rl.result?.sounds));
check('RL5b 「其余」组真的换了音（后台任务/成员任务带 soundBackground，不再与主任务同音）',
  (rl.result?.sounds ?? []).filter((s) => s === 'Windows Notify Email.wav').length >= 2,
  JSON.stringify(rl.result?.sounds));
check('RL5c 主任务与其余两组音**同时**出现在真投递里（不是只跑通了一条路）',
  (rl.result?.sounds ?? []).includes('Windows Notify System Generic.wav')
  && (rl.result?.sounds ?? []).includes('Windows Notify Email.wav'), JSON.stringify(rl.result?.sounds));
check('RL5d 成员通知文案真带上成员 label（真模块里 memberCopy/memberLabel 生效）',
  (rl.result?.bodies ?? []).some((b) => typeof b === 'string' && b.includes('音色后端')), JSON.stringify(rl.result?.bodies));
// 反例 A：把模块级真相源换成模块里不存在的名字。**注意它现在不会再崩进程** —— 因为第 2 件把
// `deliver` 整函数体包了 try/catch ⇒ ReferenceError 被吞掉并留痕。这条判据因此变成"两条防线合起来看"：
// 进程活着 + 那条投递没成行 + 有 `deliver failed` 留痕（真正的"必红崩塌"反例见 RL8c 的 ② 形态）。
const rlMut = runRealLoadProbe('mutated', (src) => src.replace('soundForEvent(currentSettings, key)', 'soundForEvent(settings, key)'));
const mutErr = rlMut.result?.errors?.join(' | ') ?? rlMut.out.slice(-300);
check('RL6 反例 A（第 2 件的防线）：deliver 里引用不存在的名字 ⇒ **进程活着**、投递没成行、有留痕',
  rlMut.mutated && rlMut.status === 0 && (rlMut.result?.received ?? 99) < (rl.result?.received ?? 0)
  && /deliver failed/.test(rlMut.out),
  JSON.stringify({ status: rlMut.status, received: rlMut.result?.received, baseline: rl.result?.received, mutErr }));
check('RL6b 反例 A 的对照证据：被吞掉的错误信息确实是 "settings is not defined"',
  /settings is not defined/.test(rlMut.out), rlMut.out.slice(-300));
// 反例 B：把崩点放在 try/catch **之外**（模块级） ⇒ 证明本探针真能分辨"崩"与"被吞"，没被掩盖。
// 改坏用的名字**故意不写字面量**（拼出来）：这样本脚本源码里不会留下任何"看起来像残留变异"的串，
// 事后 grep 工作区也不会误判（2026-09-27 事故复盘要求）。
const CRASH_NAME = ['crash', 'On', 'Load'].join('');
const rlCrash = runRealLoadProbe('crash', (src) => src.replace('const SOUND_BY_KEY = {', `const SOUND_BY_KEY = { bad: ${CRASH_NAME},`));
check('RL6c 反例 B（判据有区分力）：模块级引用未声明名字 ⇒ 真加载**加载期就炸**（错误含 is not defined、假壳 0 条）',
  rlCrash.mutated && rlCrash.status !== 0
  && /is not defined/.test(String(rlCrash.result?.errors ?? rlCrash.out))
  && (rlCrash.result?.received ?? 0) === 0,
  JSON.stringify({ status: rlCrash.status, errors: rlCrash.result?.errors, out: rlCrash.out.slice(-200) }));
// RL9/RL10：**工作区保护自证**（这几条比功能判据更重要：判据自己把仓库改坏过）
check('RL9 真加载探针跑的是工作区原文，且仓库目录里没留下任何变异副本残骸',
  sha256File(DEFAULT_NOTIFY_FILE) === rlWorkspaceShaAtStart
  && !readdirSync(NOTIFY_DIR).some((n) => n.startsWith(MUTANT_PREFIX)),
  JSON.stringify({ workspaceSame: sha256File(DEFAULT_NOTIFY_FILE) === rlWorkspaceShaAtStart }));
check('RL10 变异探针跑的是**同目录一次性副本**（探针自报路径 ≠ 工作区文件），跑完即清理',
  rl.probeTarget === DEFAULT_NOTIFY_FILE
  && typeof rlMut.probeTarget === 'string' && rlMut.probeTarget !== DEFAULT_NOTIFY_FILE
  && rlMut.probeTarget.startsWith(NOTIFY_DIR)          // 同目录（相对导入 ./upstream.js 才有效）
  && rlMut.probeTarget.includes(MUTANT_PREFIX)
  && !existsSync(rlMut.probeTarget)
  && sha256File(DEFAULT_NOTIFY_FILE) === rlWorkspaceShaAtStart,
  JSON.stringify({ real: rl.probeTarget, mutated: rlMut.probeTarget, exists: existsSync(rlMut.probeTarget || '') }));
check('RL10d 同一个跑法下：变异副本存在时探针确实起效（mut 结局 ≠ crash 结局）',
  rlMut.mutated && rlCrash.mutated && rlMut.status !== rlCrash.status,
  JSON.stringify({ mutStatus: rlMut.status, crashStatus: rlCrash.status }));
check('RL10b 自证：变异跑**永远**只落在副本上（工作区 sha 不变；副本用完即清；两次变异各得其所）',
  sha256File(DEFAULT_NOTIFY_FILE) === rlWorkspaceShaAtStart
  && rlMut.probeTarget !== DEFAULT_NOTIFY_FILE && rlCrash.probeTarget !== DEFAULT_NOTIFY_FILE
  && !existsSync(rlMut.probeTarget || '') && !existsSync(rlCrash.probeTarget || '')
  && !readdirSync(NOTIFY_DIR).some((n) => n.startsWith(MUTANT_PREFIX)),
  JSON.stringify({ workspaceSame: sha256File(DEFAULT_NOTIFY_FILE) === rlWorkspaceShaAtStart, mut: rlMut.probeTarget, crash: rlCrash.probeTarget }));
// ── RL7. 第 2 件：`deliver` **永不 reject**（整函数体包 try/catch）─────────────────
check('RL7 真导入后每次投递都不产生 rejected promise（deliver 的 promise 无人接，reject 就是杀后端）',
  (rl.result?.deliverRejections ?? ['<探针没跑起来>']).length === 0, JSON.stringify(rl.result?.deliverRejections));
const rlThrow = runRealLoadProbe('throws', (src) => src.replace(
  'const sound = detail?.silentSound === true ? \'\' : soundForEvent(currentSettings, key);',
  'const sound = noSuchIdentifierInDeliver(key) ? \'\' : soundForEvent(currentSettings, key);'));
check('RL8 反例：`deliver` 体内抛错 ⇒ **不再杀进程**（改坏点落在 try 内 ⇒ 被吞 + 限频留痕）',
  rlThrow.mutated && rlThrow.status === 0 && (rlThrow.result?.errors ?? ['x']).length === 0,
  JSON.stringify({ status: rlThrow.status, errors: rlThrow.result?.errors, out: rlThrow.out.slice(-250) }));
check('RL8b 但那条投递确实没成行（假壳少收到；证明"吞掉"没有变成"假装成功"）',
  (rlThrow.result?.received ?? 99) < (rl.result?.received ?? 0),
  JSON.stringify({ mutatedReceived: rlThrow.result?.received, baselineReceived: rl.result?.received }));
check('RL8c 限频留痕真出现在 stderr（宿主侧唯一失败观测点，不许静默）',
  /deliver failed/.test(rlThrow.out), rlThrow.out.slice(-300));

// ── RM. 同类排查：所有**模块级函数/箭头函数**读到的自由变量必须在模块作用域真实存在 ──────
// 静态面（语言级）。两个口径都必须有（复核点名，各配一条反例演示）：
//   ① **箭头函数也算模块级函数**：第 1 件之前那份"apply 局部副本 ↔ 模块级镜像"的同步逻辑就是
//      写在箭头函数里的 —— 旧体检只认 `function` 声明 ⇒ 那段分叉**没有**运行时判据。
//   ② **裸标识符也算自由变量**（不只"名字+("的调用位）：`const s = settings` 这种读法旧口径看不见。
const rmCode = notifySrc.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const rmDeclared = new Set();
for (const m of rmCode.matchAll(/^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) rmDeclared.add(m[1]);
for (const m of rmCode.matchAll(/^import\s+\{([^}]*)\}/gm)) for (const n of m[1].split(',')) rmDeclared.add(n.trim().split(/\s+as\s+/).pop().trim());
// 语言关键字不是"函数名"（`if (`/`for (` 都会被 `名字+(` 的正则命中，必须排除，否则体检全是噪音）
const RM_KEYWORDS = ['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'do', 'else', 'delete', 'in', 'of', 'instanceof', 'void', 'yield', 'case', 'throw', 'try'];
const RM_GLOBALS = new Set([...RM_KEYWORDS, 'const', 'let', 'var', 'async', 'class', 'extends', 'super', 'import', 'export', 'from', 'as', 'default', 'static', 'get', 'set', 'fetch', 'process', 'Map', 'Set', 'Number', 'String', 'Boolean', 'Object', 'Array', 'JSON', 'Promise', 'Date', 'Math', 'console', 'Error', 'TypeError', 'RangeError', 'RegExp', 'Buffer', 'setTimeout', 'clearTimeout', 'structuredClone', 'URL', 'undefined', 'null', 'true', 'false', 'this', 'isNaN', 'parseInt', 'parseFloat', 'Symbol', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'globalThis', 'require', 'module', 'exports']);
/** 配平括号取一段代码体（`function` / 箭头函数共用）。 */
function rmBalanced(code, openIndex) {
  if (openIndex < 0) return null;
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') { depth -= 1; if (depth === 0) return code.slice(openIndex, i + 1); }
  }
  return null;
}
/** 抽 function 声明体（保留原口径，用于 RM2/RM3 的定点检查）。 */
function rmBodyOf(name) {
  const start = rmCode.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm'));
  if (start < 0) return null;
  return rmBalanced(rmCode, rmCode.indexOf('{', start));
}
/** 抽**模块级箭头函数**体：`const x = (...) => {` 或 `const x = (…) => expr`。
 *  ⚠️ 必须容纳**缩进**（`apply()` 里的 `const syncSettings = (next) => …` 缩进两格）——
 *  第一版用 `^` 锚，结果箭头函数集是空的（RM1b 直接红），"补了箭头口径"等于没补。 */
function rmArrowBodies(code) {
  const out = [];
  for (const m of code.matchAll(/(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*/g)) {
    const afterArrow = m.index + m[0].length;
    const body = code[afterArrow] === '{'
      ? rmBalanced(code, afterArrow)
      : code.slice(afterArrow, code.indexOf('\n', afterArrow) < 0 ? undefined : code.indexOf('\n', afterArrow));
    if (body !== null) out.push({ name: m[1], params: m[2], body: `(${m[2]}) => ${body}` });
  }
  return out;
}
/**
 * 体检器：对每个函数体（含箭头函数）求自由标识符集合。
 * 判定 = 剔掉 ①自身声明（形参/局部 const|let|var|function/嵌套箭头形参/catch 形参/解构）
 *        ②模块顶层绑定 ③语言关键字与内置全局。剩下的就是"读了个不存在的东西"。
 * ⚠️ 会对**字符串里的代码样文本**误报（例如 PowerShell 模板串里的 `FromBase64String(`），
 *    所以本体检器只用于 `notify.js`；真正的兜底是 RL 节的运行时探针。
 */
function rmAudit(code) {
  const declared = new Set();
  for (const m of code.matchAll(/^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
  for (const m of code.matchAll(/^import\s+\{([^}]*)\}/gm)) for (const n of m[1].split(',')) declared.add(n.trim().split(/\s+as\s+/).pop().trim());
  // 全模块的**箭头函数形参**（含嵌套）：保守地当作局部名并集 —— 嵌套箭头体的自由变量本来就归它的
  // 宿主函数一起看（它们与宿主共享作用域），不是漏报。误报方向只会是"少报"，不会掩盖真漏。
  const arrowParamNames = new Set();
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const n of m[1].split(',')) { const t = n.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, ''); if (/^[A-Za-z_$][\w$]*$/.test(t)) arrowParamNames.add(t); }
  }
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) arrowParamNames.add(m[1]);
  const units = [];
  for (const m of code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm)) {
    const body = rmBalanced(code, code.indexOf('{', m.index));
    if (body !== null) units.push({ name: m[1], params: m[2], body, kind: 'function' });
  }
  for (const a of rmArrowBodies(code)) units.push({ ...a, kind: 'arrow' });
  const suspects = [];
  for (const unit of units) {
    const local = new Set(arrowParamNames);
    for (const n of unit.params.split(',')) { const t = n.trim().split(/[=:]/)[0].trim(); if (t) local.add(t.replace(/^\.\.\./, '')); }
    for (const m of unit.body.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
    for (const m of unit.body.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) local.add(n.trim().split(':').pop().trim());
    for (const m of unit.body.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
    // ⚠️ 内层箭头形参在这里再收一遍（`bare` 上那条正则属于"清洗后"的精修；这条是原始文本上的保守兜底，
    //    两条都留：任一失效都还有另一条兜。`(settingsCtx) =>` 这类在两条正则下都该被收到。）
    for (const m of unit.body.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const n of m[1].split(',')) {
        const t = n.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t);
      }
    }
    const free = new Set();
    // **裸标识符**口径（复核要求）：先把注释/字符串摘掉，再按"完整标识符 + 边界"扫；
    // 排除紧跟 `:` 的对象键、`.` 后面的属性名（避免把 `{ title: … }` 的键当自由变量）。
    // 反例：本轮第一版正则写成 `([A-Za-z_$][\w$]*)`（漏了右侧边界）⇒ 报出 `const`/`val`/`titl`
    // 这类半截名，体检表全是噪音（RM1 因此红了一次）。
    // 模板串要**整串**剔掉（含 `${…}` 插值）：插值里的标识符由外层作用域负责，不是本函数的自由变量。
    // 三道清洗顺序都不能省（每一条都是踩出来的）：
    //   ① **正则字面量**（`/\s+/g`）先剔：里面的 `/` 会让后面的单引号配对错位，残余出 `s`/`g` 这类噪音；
    //   ② `${…}` 先换成常量：非贪婪 `[\s\S]*?` 遇到模板串**内部**的 `` }` `` 会提前收手；
    //   ③ 再剔整条模板串/字符串。
    const bare = unit.body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[gimsuy]*/g, ' 0 ')
      .replace(/'[^'\n]*'/g, "''")
      .replace(/"[^"\n]*"/g, '""')
      .replace(/\$\{[^}]*\}/g, '0')
      .replace(/`[\s\S]*?`/g, '``');
    // 内层箭头函数的形参也算本函数的局部名：从**清洗后**的文本里取（原始文本里的字符串/数组字面量
    // 会让 `\(([^)]*)\)\s*=>` 匹配错位 —— `(settingsCtx` 就因此漏掉过一次）。
    // ⚠️ 必须是**非贪婪** `[^)]*?`：`ctx.inject(['settings'], (settingsCtx) => {` 里 `(['settings'], (settingsCtx)`
    // 全都不含 `)`，贪婪匹配会把 `['settings'], (settingsCtx` 当形参列表 ⇒ `settingsCtx` 反而漏掉
    // （又红了一次）。非贪婪会在**紧邻 `=>`** 的那对括号处收手。
    for (const m of bare.matchAll(/\(([^)]*?)\)\s*=>/g)) {
      for (const n of m[1].split(',')) {
        const t = n.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t);
      }
    }
    for (const m of bare.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) local.add(m[1]);
    for (const m of bare.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*:)/g)) {
      const n = m[1];
      if (!local.has(n) && !declared.has(n) && !RM_GLOBALS.has(n) && !free.has(n)) free.add(n);
    }
    const missing = [...free];
    if (missing.length > 0) suspects.push({ fn: `${unit.name}(${unit.kind})`, missing });
  }
  return { units, suspects };
}
const rmReal = rmAudit(rmCode);
const rmArrowNames = rmReal.units.filter((u) => u.kind === 'arrow').map((u) => u.name);
console.log(`—— 自由变量体检对象：${rmReal.units.length} 个（其中箭头函数 ${rmArrowNames.length} 个：${rmArrowNames.join(', ') || '无'}）`);
check('RM1 模块级函数/箭头函数无"未声明的自由变量"（事故同类：settings 在模块作用域并不存在）',
  rmReal.suspects.length === 0, JSON.stringify(rmReal.suspects));
check('RM1b 体检器真把箭头函数纳入了（拿仓库里真实存在的箭头函数清单做正对照，不能是空集）',
  rmReal.units.filter((u) => u.kind === 'arrow').length > 0, JSON.stringify(rmArrowNames));
check('RM2 deliver 读的是模块级真相源 currentSettings（不是别处才有的 settings）',
  /soundForEvent\(currentSettings, key\)/.test(rmBodyOf('deliver') ?? '')
  && !/(?<![.\w$])settings(?![.\w$])/.test(rmBodyOf('deliver') ?? ''));
check('RM3 单一真相源：apply 里没有局部 settings 副本，syncSettings 只写模块级',
  /const syncSettings = \(next\) => \{ currentSettings = next; \};/.test(notifySrc)
  && !/let\s+settings\s*=/.test(notifySrc)
  && (notifySrc.match(/syncSettings\(/g) || []).length >= 4);
// ── RM5/RM6：两条"改坏必红"的**体检器演示**（用复核给的原型）────────────────────
// 旧口径两个盲区（都得在这里当反例演示，否则"补了口径"没有证据）：
//   ① 箭头函数不算模块级函数 ⇒ `const probe = () => missingName;` 旧口径查不出来
//   ② 只看调用位 `名字(` ⇒ `const s = missingName;`（裸标识符）也查不出来
const RM_PROBE_OLD_OK = 'function probe(settings) { const s = settings; return s; }\nconst helper = () => missingName;\n';
check('RM5 反例演示：旧口径（只认 function + 只看调用位）对这两类写法**报 0**（= 为什么必须升级）',
  // 旧口径重演：只扫 function 声明的 "名字(" 调用位
  (() => {
    const code = RM_PROBE_OLD_OK;
    const oldDeclared = new Set(['probe', 'helper']);
    const oldUnits = [...code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)];
    let oldMissing = 0;
    for (const m of oldUnits) {
      const body = rmBalanced(code, code.indexOf('{', m.index)) ?? '';
      const local = new Set(m[2].split(',').map((s) => s.trim()));
      for (const c of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!local.has(c[1]) && !oldDeclared.has(c[1]) && !RM_GLOBALS.has(c[1])) oldMissing += 1;
      }
    }
    return oldMissing === 0;
  })());
check('RM6 升级后的口径必须报红：同一个探针源里，箭头函数里的 missingName 被认出来',
  (() => { const r = rmAudit(RM_PROBE_OLD_OK); return r.suspects.some((s) => s.missing.includes('missingName')); })(),
  JSON.stringify(rmAudit(RM_PROBE_OLD_OK).suspects));
check('RM6b 裸标识符口径也生效：`const s = missingName;`（无括号）同样被认出来',
  (() => { const r = rmAudit('function probe() { const s = missingName; return s; }\n'); return r.suspects.some((s) => s.missing.includes('missingName')); })(),
  JSON.stringify(rmAudit('function probe() { const s = missingName; return s; }\n').suspects));
check('RM6c 对照（防误报）：形参/局部/模块级/内置全局都不该被报',
  (() => { const r = rmAudit('const top = 1;\nfunction fine(a) { const b = a; const c = top; return Math.max(b, c, Number(1)); }\n'); return r.suspects.length === 0; })(),
  JSON.stringify(rmAudit('const top = 1;\nfunction fine(a) { const b = a; const c = top; return Math.max(b, c, Number(1)); }\n').suspects));
// 抽取器自身的哨兵：防止 RM1 因为"抽不到函数体"而静默全绿
check('RM4 体检器有区分力（把 deliver 体喂进检查器能认出 currentSettings 这类模块级名）',
  rmReal.units.some((u) => u.name === 'deliver') && rmDeclared.has('currentSettings') && rmDeclared.has('DEFAULT_SETTINGS'));

// ── L. 壳接线面（main.cjs）──────────────────────────────────────────────────
check('L1 main.cjs 引用 sound.cjs', /require\(['"]\.\/sound\.cjs['"]\)/.test(mainSrc));
check('L2 /notify 走 sound.buildNotifyResponse 判据', mainSrc.includes('sound.buildNotifyResponse(payload)'));
check('L3 播放入口走 sound.playScript（windowsHide 在模块内统一保证）', mainSrc.includes('sound.playScript('));
check('L4 GET /sounds 接线', mainSrc.includes("req.url === '/sounds'") && mainSrc.includes('sound.listSounds()'));
check('L5 CORS 三头齐 + OPTIONS 204',
  mainSrc.includes("'Access-Control-Allow-Origin', '*'")
  && mainSrc.includes("'Access-Control-Allow-Headers', 'content-type'")
  && mainSrc.includes("'Access-Control-Allow-Methods', 'GET, POST, OPTIONS'")
  && /OPTIONS'\)\s*\{\s*preflight\(res\)/.test(mainSrc));
check('L6 /notify 段内只剩一处弹窗，且判据（play/notify）已下沉 sound.cjs',
  (mainSrc.split("req.url === '/notify'")[1] || '').split('new Notification(').length === 2
  && /if \(decision\.notify\)/.test(mainSrc) && /if \(decision\.play\)/.test(mainSrc));
check('L6b 全局另两处 Notification 未被本次改动波及（连接/断开提示）',
  (mainSrc.match(/new Notification\(/g) || []).length === 3);
check('L7 通知/播放失败仍只记日志（不许抛、不许崩壳）',
  mainSrc.includes("notify: 'play-fail'") && mainSrc.includes("notify: 'show-fail'")
  && mainSrc.includes("notify: 'listen-fail'"));
check('L8 preview 被拒（400）要留一行日志（v1.2 ②：别让设置页"点了没反应"）',
  /notify: 'preview-rejected'/.test(mainSrc));

// ── L9. host 侧接线（v2）：成员分支、jobs 分支、会话销毁清理 ─────────────────────
const jobsBlock = notifySrc.slice(notifySrc.indexOf('jobs.onJobDone'), notifySrc.indexOf('dshome-notify: background job attention'));
check('L9 后台任务判据真读了 currentSettings.notifyOnBackground（不只是 schema 里加了字段）',
  /if \(currentSettings\.notifyOnBackground !== true\) return;/.test(jobsBlock), JSON.stringify(jobsBlock.slice(0, 220)));
check('L10 trackTurn 把 subagent 会话交给 trackMemberTurn（不再直接 return）',
  /if \(session\.header\?\.origin === 'subagent'\) \{\s*\n\s*trackMemberTurn\(session, event\);/.test(notifySrc));
check('L11 成员通知走"显式认领音效窗口"的接线（`memberSound: true` → 窗口只在真投递时消费）',
  notifySrc.includes("deliverAttention(key, String(session.header?.id ?? ''), { ...memberCopy(key, session), memberSound: true });")
  && /if \(detail\?\.memberSound === true\) \{/.test(notifySrc)
  && notifySrc.includes('const withSound = memberSoundAllowed(now, lastMemberSoundAt);')
  && notifySrc.includes('if (withSound) lastMemberSoundAt = now;'));
check('L11b 非成员通知**不**消费音效窗口（user-question/approval-asked 不许把成员那一声吃掉）',
  !/deliverAttention\('user-question'[\s\S]{0,200}memberSound: true/.test(notifySrc)
  && !/deliverAttention\('approval-asked'[\s\S]{0,200}memberSound: true/.test(notifySrc));
check('L11c deliver 整函数体包 try/catch（不是只包 fetch）+ 失败限频留痕',
  /async function deliver\(key, detail\) \{\s*\n\s*try \{/.test(notifySrc)
  && /DELIVER_FAIL_NOTE_MS = 60000/.test(notifySrc)
  && /deliver failed/.test(notifySrc));
check('L12 会话销毁仍清节流条目（成员会话也会进这张 Map）',
  notifySrc.includes('if (key.endsWith(suffix)) lastAttentionAt.delete(key);'));

// ── N. 端到端往返：**契约默认值** → notify.js 的 body 形态 → 壳判据 → 可播放命令 ─────
// I 组用的是测试自带的好音名；这一组用 notify.js 里**真抽出来的默认值**，走同一条 HTTP 面，
// 断言壳最终拿到的是一条指向 %WINDIR%\Media\<默认音> 的播放命令（契约默认值端到端可用）。
{
  const realDefault = fallbackSettings?.soundTurnCompletion ?? '';
  const nPlayed = [];
  const local = startStub({
    listSounds: testSound.listSounds,
    // 本组走**真实 fs 存在性**（假媒体库里有一个真文件）：默认音名在假 %WINDIR%\Media 里存在，
    // 因此 N2 能验到「真解析成功」而不是靠注入的 exists 恒真。
    // played 用**本组自己的数组**：I 组尾部那条回退音不该混进来（第一次跑就是这么假红的）。
    buildNotifyResponse: testSound.buildNotifyResponse,
    played: nPlayed,
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const call = (path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = httpRequest({
      host: '127.0.0.1', port: local.address().port, path, method: payload ? 'POST' : 'GET',
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    rq.on('error', reject);
    if (payload) rq.write(payload);
    rq.end();
  });
  try {
    // 本机文件存在性走真实 fs：TurnCompletion 默认音在真 %WINDIR%\Media 里存在（本机实测），
    // 若某天不存在，这一步退化成「回退音」——N2 会断言到那条分支，不会假绿。
    const res = await call('/notify', { title: 'DSHOME 回合完成', body: 'x', sound: realDefault });
    check('N1 真默认值经 HTTP 面 ⇒ 204', res.status === 204, JSON.stringify(res));
    check('N2 壳拿到的播放命令指到 %WINDIR%\\Media 下的真默认音（不是回退音）',
      nPlayed.length === 1 && nPlayed[0].fallback === false
      && nPlayed[0].resolved === join(fakeMedia, realDefault)
      && nPlayed[0].play === testSound.buildPlayScript(join(fakeMedia, realDefault)),
      JSON.stringify(nPlayed));
    const pv = await call('/notify', { preview: true, sound: realDefault });
    check('N3 preview + 真默认值 ⇒ 204 且只多播一次（通知面不参与）', pv.status === 204 && nPlayed.length === 2,
      JSON.stringify(nPlayed));
    const pv2 = await call('/notify', { preview: true });
    check('N4 preview 无音 ⇒ 204 + 系统默认音（v1.2 ① 的端到端确认）',
      pv2.status === 204 && nPlayed.length === 3 && nPlayed[2].resolved === 'default-system' && nPlayed[2].fallback === true,
      JSON.stringify(nPlayed));
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
}

// ── M. 反例证伪（`--mutate`）：把实现逐条改坏 ⇒ 本脚本必须变红 ─────────────────
// 「写不出反例＝没验过」。⚠️ **工作区保护（事故后重建）**：
//   · 变异一律在**一次性临时副本**上做，工作区三文件全程只读、绝不 writeFileSync；
//   · 跑完（含提前 return / 抛错路径）逐文件 sha256 与开跑前比对，不一致 ⇒ 响亮失败 + 尝试恢复；
//   · 输出明示"工作区三文件 sha 与开跑前逐字节一致"，并配反例（人为让校验失败 ⇒ 必红）。
if (process.argv.includes('--mutate')) {
  const SOUND_FILE = join(shellDir, 'sound.cjs');
  const MAIN_FILE = join(shellDir, 'main.cjs');
  const NOTIFY_FILE = DEFAULT_NOTIFY_FILE;
  /** 开跑前的工作区快照（sha + 字节），用于收尾自证与自动恢复。 */
  const workspaceSnapshot = new Map(WORKSPACE_FILES.map((f) => [f, { sha: sha256File(f), bytes: readFileSync(f) }]));
  const MUTATIONS = [
    ['M1 wav 后缀校验被删（.mp3 也当合法）', SOUND_FILE,
      String.raw`if (!/\.wav$/i.test(raw)) return { ok: false, path: '', reason: 'not-wav' };`, ''],
    ['M2 存在性校验被删（缺文件也算可播）', SOUND_FILE,
      String.raw`if (!there) return { ok: false, path: '', reason: 'missing' };`, ''],
    ['M3 路径直接拼进 PowerShell 字符串（注入面）', SOUND_FILE,
      '`' + String.raw`$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('` + '$' + `{payload}'));`,
      '`' + String.raw`$p = '` + '$' + `{String(absPath ?? '')}';`],
    ['M4 preview 缺音时静默 204（假绿：有声无音、用户听不到）', SOUND_FILE,
      "play: systemDefaultPlayScript(), fallback: true, resolved: 'default-system' };",
      "play: '', fallback: false, resolved: 'default-system' };"],
    // windowsHide 的接线圈就在 sound.cjs（main.cjs 只调 playScript）⇒ 改坏点必须落在真正生效的那行。
    ['M5 execFile 去掉 windowsHide（每条通知闪黑框）', SOUND_FILE, 'windowsHide: true,', ''],
    ['M6 壳不引用 sound.cjs（判据没接上）', MAIN_FILE, "require('./sound.cjs')", "require('./nope.cjs')"],
    // M7 打 **schema** 默认值，M9 打**兜底对象**默认值：两个真值源各自有独立反例。
    ['M7 schema 默认音色被换掉（契约默认值漂移）', NOTIFY_FILE,
      "soundTurnCompletion: z.string().default('Windows Notify System Generic.wav')",
      "soundTurnCompletion: z.string().default('Windows Ding.wav')"],
    ['M9 兜底对象默认音色被换掉（设置面停用时静默换音）', NOTIFY_FILE,
      "soundTurnCompletion: 'Windows Notify System Generic.wav'",
      "soundTurnCompletion: 'Windows Ding.wav'"],
    // v1.2 三分支的反例：任一条被写回旧行为都要红。
    ['M10 preview 缺音被写成 400（设置页「默认」项试听不了）', SOUND_FILE,
      "      return { status: 204, kind: 'preview', notify: false, play: systemDefaultPlayScript(), fallback: true, resolved: 'default-system' };",
      String.raw`      return { status: 400, kind: 'invalid', notify: false, play: '', fallback: false, resolved: resolved.reason };`],
    ['M11 preview 非法值被写成 204 + 回退音（掩盖用户填错）', SOUND_FILE,
      String.raw`    return { status: 400, kind: 'invalid', notify: false, play: '', fallback: false, resolved: resolved.reason };`,
      String.raw`    return { status: 204, kind: 'preview', notify: false, play: systemDefaultPlayScript(), fallback: true, resolved: resolved.reason };`],
    ['M12 非 preview 非法值改成静默不播（提醒变静音=假绿）', SOUND_FILE,
      "const play = resolved.ok ? buildPlayScript(resolved.path) : (wanted ? systemDefaultPlayScript() : '');",
      "const play = resolved.ok ? buildPlayScript(resolved.path) : '';"],
    // ── v2 的六条（Lead 点名四条 + 两条我自己加的同类）────────────────────────────
    ['M13 member-completed 映射写回 soundTurnCompletion（主任务/其余又混成一个音）', NOTIFY_FILE,
      "'member-completed': 'soundBackground',", "'member-completed': 'soundTurnCompletion',"],
    ['M14 成员通知不做音效全局节流（多成员同时交卷连响一串）', NOTIFY_FILE,
      'return now - lastAt >= MEMBER_SOUND_WINDOW_MS;', 'return true;'],
    ['M15 兜底对象漏掉新字段（设置面停用时静默降级）', NOTIFY_FILE,
      "      soundBackground: 'Windows Notify Email.wav',\n", ''],
    ['M16 成员通知绕开 notifyOnBackground（开关关掉也会弹）', NOTIFY_FILE,
      "  if (currentSettings.notifyOnBackground !== true) return;\n  if (event.type !== 'turn/end') return;",
      "  if (event.type !== 'turn/end') return;"],
    // 加一条同类：把 subagent 又改回"直接 return"（v2 的核心诉求被撤销）
    ['M17 成员会话恢复「直接 return」（成员任务永远没有通知）', NOTIFY_FILE,
      "  if (session.header?.origin === 'subagent') {\n    trackMemberTurn(session, event);\n    return;\n  }",
      "  if (session.header?.origin === 'subagent') return;"],
    // 后台任务又只看总开关（v2 要求它归 notifyOnBackground 管）
    ['M18 jobs 绕开 notifyOnBackground（关了还会提醒后台任务）', NOTIFY_FILE,
      "        if (currentSettings.notifyOnBackground !== true) return;\n        if (snapshot.status === 'completed') deliver('job-completed');",
      "        if (snapshot.status === 'completed') deliver('job-completed');"],
    // ── 真加载（RL）面：模块级自由变量这一类，只有"真 import + 真投递"才抓得到 ──────
    // M19 就是本次阻断事故本体（与 RL6 同款，但挂在总反例台账里，防有人日后把它从 RL 节里删掉）。
    ['M19 deliver 读 apply 的局部 settings（本次阻断事故：整后端被 ReferenceError 杀掉）', NOTIFY_FILE,
      'soundForEvent(currentSettings, key)', 'soundForEvent(settings, key)'],
    ['M20 成员文案里引用了不存在的名字（同类自由变量事故，只在成员路径炸）', NOTIFY_FILE,
      'function memberCopy(key, session) {\n  const entry = COPY[key];',
      'function memberCopy(key, session) {\n  const entry = COPY[key];\n  void memberThemeTone;'],    ['M21 后台任务投递读不存在的名字（把 deliver 的收尾改成自由变量）', NOTIFY_FILE,
      "'dshome-notify: background job attention'", "'dshome-notify: background job attention' + backgroundTag"],
    // ── 健壮性批次（本轮）的四条 ────────────────────────────────────────────────
    ['M22 deliver 的 try 只包 fetch（整函数体没包住 ⇒ 引用了坏名字就杀进程）', NOTIFY_FILE,
      'async function deliver(key, detail) {\n  try {\n    if (!NOTIFY_PORT) return;',
      'async function deliver(key, detail) {\n  if (!NOTIFY_PORT) return;\n  try {'],
    ['M23 窗口消费顺序改回"先消费再投递"（被节流吞掉的那条会白吃窗口）', NOTIFY_FILE,
      "  let outgoing = detail;\n  if (detail?.memberSound === true) {\n    const withSound = memberSoundAllowed(now, lastMemberSoundAt);\n    if (withSound) lastMemberSoundAt = now;",
      "  let outgoing = detail;\n  if (detail?.memberSound === true) {\n    const withSound = memberSoundAllowed(now, lastMemberSoundAt);\n    lastMemberSoundAt = now;"],
    ['M24 非成员通知也认领音效窗口（user-question 会把成员那一声吃掉）', NOTIFY_FILE,
      'if (detail?.memberSound === true) {', 'if (true) {'],
    ['M25 apply 里又长出一份局部 settings 副本（双真相源回归）', NOTIFY_FILE,
      'const syncSettings = (next) => { currentSettings = next; };',
      'let settings = currentSettings;\n  const syncSettings = (next) => { settings = next; currentSettings = next; };'],
    // 已知边界（**故意不写反例**，别当"验过了"）：改坏 `soundForEvent` 的**内部逻辑**
    // （如把 SOUND_BY_KEY 的查找写死成空串）本脚本不会红 —— 它只对着真值表/接线文本断言，
    // 而函数体不在文本判据的字面范围里。要覆盖它得在 backend 活进程里真触发一条通知
    // （AGENTS §四「改被运行进程加载的东西 ⇒ 重启 + 真触发一次」），那一步留给 Lead 做。
  ];
  console.log('\n—— 反例证伪（--mutate）：每条判据都要有「改坏 ⇒ 必红」的对照（变异只落在临时副本）');
  let redCount = 0;
  let mutationIndex = 0;
  for (const [label, file, from, to] of MUTATIONS) {
    mutationIndex += 1;
    const original = readFileSync(file, 'utf8');
    // ⚠️ 仓库文件是 CRLF ⇒ 跨行改坏点用 `\n` 写会对不上（本脚本踩过：M15-M18 报"改坏未生效"）。
    // 先按原样替换，未命中再按**换行归一化**重试（把目标里的 \n 换成 \r\n 去匹配原文件）。
    let patched = original.replace(from, to ?? '');
    if (patched === original && from.includes('\n')) {
      patched = original.replace(from.replace(/\r?\n/g, '\r\n'), (to ?? '').replace(/\r?\n/g, '\r\n'));
    }
    const mutated = patched !== original;
    if (!mutated) console.log(`     ↳ 改坏未命中：file=${file} 里找不到 ${JSON.stringify(from.slice(0, 70))}（反例失效，必须修）`);
    // 把变异体写进**同目录一次性副本**，子进程读副本（工作区文件全程未被写）。
    const suffix = file === SOUND_FILE ? 'sound.cjs' : (file === MAIN_FILE ? 'main.cjs' : 'notify.js');
    const copy = join(fakeWin, `mutant-${mutationIndex}.${suffix}`);
    writeFileSync(copy, mutated ? patched : original);
    // ⚠️ 子进程会**整个**跑一遍本脚本（含 RL 组，RL 组也会做变异）⇒ 必须把它要 import/变异的
    //    源文件指针（`DSH_VERIFY_NOTIFY_FILE`）指向**它自己的**一次性副本，否则子进程里
    //    `runRealLoadProbe` 会因"没有副本却要变异"直接抛（这正是自证拦下原地改路径的证据）。
    const childNotifyCopy = join(NOTIFY_DIR, `${MUTANT_PREFIX}child-${mutationIndex}${MUTANT_SUFFIX}`);
    writeFileSync(childNotifyCopy, readFileSync(DEFAULT_NOTIFY_FILE));
    let run;
    try {
      run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        encoding: 'utf8', windowsHide: true,
        env: { ...process.env, [NOTIFY_FILE_ENV]: childNotifyCopy },
      });
    } finally {
      rmSync(copy, { force: true });
      rmSync(childNotifyCopy, { force: true });
    }
    const hit = (run.stdout + run.stderr).split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(5).split('  →')[0]);
    const isRed = run.status === 1;
    if (isRed && mutated) redCount += 1;
    console.log(`${isRed ? 'ok  ' : 'FAIL'} ${label} ⇒ ${isRed ? (hit.length > 0 ? `必红（${hit.length} 项失败，例：${hit[0]}）` : '必红（脚本当场崩掉，无 FAIL 行——这正是"无人 catch 的 ReferenceError"形态）') : `**没红**（status=${run.status}）`}`
      + `${mutated ? '' : ' [改坏未生效！]'}`);
  }
  console.log(`—— 反例证伪：${redCount}/${MUTATIONS.length} 条「改坏 ⇒ 必红」成立`);
  if (redCount !== MUTATIONS.length) failed += 1;

  // ── 工作区自证（变异跑完）：与开跑前逐字节比对，漂移 ⇒ 响亮失败 + 自动恢复 ────────
  // 反例开关：人为模拟"还原失败"（把原文 + 一行标记写回工作区），证明这条自证**真的会红**。
  // ⚠️ 只在本进程是"最外层"（没有被父级用副本指针调用）时生效 —— 否则每个子进程都模拟一次，
  //    会把全部 24 条反例染成假红（本轮踩过）。
  if (process.env.DSHOME_MUTATE_TEST_RESTORE_FAIL === '1' && !process.env[NOTIFY_FILE_ENV]) {
    const snap = workspaceSnapshot.get(DEFAULT_NOTIFY_FILE);
    writeFileSync(DEFAULT_NOTIFY_FILE, `${snap.bytes.toString('utf8')}\n// simulated restore failure\n`);
  }
  verifyWorkspaceIntegrity('变异套件跑完');
  const workspaceShas = WORKSPACE_FILES.map((f) => `${f.split(/[\\/]/).pop()}=${sha256File(f).slice(0, 12)}`);
  console.log(`—— 工作区自证：三文件 sha = ${workspaceShas.join(' / ')}`);
  if (process.exitCode === 2) {
    console.error('verify-notify-sound: ❌ 变异套件把工作区改脏了（已尝试自动恢复）——修复后重跑');
    process.exit(2);
  }
}

// ── 收尾（必须在 M/N 之后）──────────────────────────────────────────────────
// 隔离现场要活到最后：M 组起的子进程会重跑本脚本（自己也会建/删同名前缀的临时目录），
// N 组还要用假媒体库里的真文件验「真存在性往返」。提前删 ⇒ 后面的判据全变假红。
sweepMutantCopies();   // 兜底：仓库目录里不许留任何一次性变异副本
try { rmSync(fakeWin, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
// 最后一公里：再自证一次（覆盖 RL/M 之后的任何写入路径），并清掉本轮的变异残骸
verifyWorkspaceIntegrity('收尾');

console.log(failed
  ? `\nverify-notify-sound: ${failed}/${checks} 项失败`
  : `\nverify-notify-sound: 全部通过（${checks} 项；真加载 + 真 HTTP + 真 spawn powershell + base64 往返；未发出任何真实提示音）`);
process.exit(process.exitCode ?? (failed ? 1 : 0));
