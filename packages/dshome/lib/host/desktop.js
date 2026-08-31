// dshome/desktop — DSHOME 自供「桌面服务」host 插件。
//
// 目的：让社区市场插件的「安装 / 卸载」脱离 DSH Desktop 也能工作。
//   DSH Desktop 在 profile 里注册了 cordis 服务 desktopProfiles / desktopPnpm /
//   desktopPlugins / desktopActions；dsh-community-market 只在这四个服务
//   存在时才实例化 MarketInstallService（否则装/卸接口 503「desktop only」）。
//
// 本插件为 DSHOME（纯 dsh CLI + 官方运行时包）提供等价实现：
//   - desktopProfiles.current  → { name, dir }（活动 profile 的信息）
//   - desktopPnpm.run(args)     → 在 profile 目录跑 pnpm，返回 {stdout,stderr,done,cancel}
//   - desktopPlugins.list()     → 已装 bundle 清单（无重复、字段满足 market 契约）
//   - desktopActions            → openTerminal() / requestRestart()（DSHOME 不真重启，
//                                 后者只发信号，重启由用户/壳手动完成）
//
// 护栏（设计见历史文档，已归档）：全程 try/catch，只记日志、绝不 rethrow，
// 避免阻断 profile 启动。若宿主（DSH Desktop）已提供同名服务，则不覆盖。

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Stable Cordis plugin name (row: `name: dshome/desktop`). */
export const name = 'dshome-desktop';

/** Services this row requires before activation. */
export const inject = [];

// 与 dshome/plugin-manager 同款定位：DSH_HOME/profiles/<DSH_PROFILE || 'dshome'>
function profileDir() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return join(home, 'profiles', process.env.DSH_PROFILE || 'dshome');
}

function profileName() {
  return process.env.DSH_PROFILE || 'dshome';
}

// 核心/本体 bundle：不卸载、不可变。
function isCore(bundle) {
  return bundle.startsWith('@deepseek-ai/') || bundle === 'dshome';
}
// 市场明确禁止管理/卸载的产品包。
const BLOCKED_PACKAGES = new Set(['dsh-plugin-desktop', 'dsh-community-market']);

function readProfileManifest() {
  return JSON.parse(readFileSync(join(profileDir(), 'package.json'), 'utf8'));
}

function bundlesOf(manifest) {
  const profile = manifest?.dsh?.profile;
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return [];
  const bundles = profile.bundles;
  return Array.isArray(bundles) && bundles.every((v) => typeof v === 'string') ? bundles : [];
}

// 读取 profile 的 package.json 返回已装 bundle 清单，字段满足 market 契约：
//   { bundleId, packageName, status, mutable, uninstallable } 且无重复、字段精确。
// 必须是**同步返回数组**（market 用 desktopPlugins.list().find() / reconcileInstallations()）。
function listDesktopPlugins() {
  const manifest = readProfileManifest();
  const seen = new Set();
  const result = [];
  for (const bundle of bundlesOf(manifest)) {
    if (seen.has(bundle)) continue; // 防重复（market 会校验无重复）
    seen.add(bundle);
    const core = isCore(bundle);
    const blocked = BLOCKED_PACKAGES.has(bundle);
    result.push({
      bundleId: bundle,
      packageName: bundle,
      status: 'active',
      mutable: !core,
      uninstallable: !core && !blocked,
    });
  }
  return result;
}

// 在 profile 目录跑 pnpm，满足 market 对 handle 的契约：
//   { stdout, stderr, done, cancel }
//   - stdout/stderr：可读流（market 用 .on('data') + .resume()）
//   - done：Promise<{ exitCode, signal }>
//   - cancel()：终止进程
function runPnpm(args, signal) {
  const cwd = profileDir();
  // Windows 下 pnpm 是 .cmd，需要 shell:true（或用 cmd.exe 包裹）。
  const child = spawn('pnpm', args, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, // 避免被误当作 node 模式
  });
  const done = new Promise((resolve, reject) => {
    child.on('close', (code, sig) => resolve({ exitCode: code, signal: sig }));
    child.on('error', (err) => reject(err));
  });
  const cancel = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  return { stdout: child.stdout, stderr: child.stderr, done, cancel };
}

function log(ctx, level, message) {
  try {
    const logger = ctx.logger?.(name) ?? ctx.logger;
    logger?.[level]?.(message);
  } catch { /* logging must never break the plugin */ }
}

// 只发信号：记录日志 + 尽力投递壳通知（DSHOME_NOTIFY_PORT），不真正重启。
function requestRestartSignal(ctx) {
  log(ctx, 'warn', 'dshome/desktop: DESKTOP RESTART REQUESTED — restart the dshome profile manually to apply the change.');
  const port = Number(process.env.DSHOME_NOTIFY_PORT || 0);
  if (!port) return;
  try {
    fetch(`http://127.0.0.1:${port}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'DSHOME', body: '插件变更已就绪 — 请重启 DSHOME 生效' }),
    }).catch(() => {});
  } catch { /* best effort */ }
}

function provideIfAbsent(ctx, key, value) {
  // 直接 ctx.provide（core.js 同款）。不先调 ctx.get：对未提供服务调用 ctx.get
  // 会在 cordis 反射层抛 "cannot get required service"，且可能把 fiber 置入异常态，
  // 触发 include-loader 级联失败。若宿主已提供同名服务，ctx.provide 会抛错，这里捕获即可。
  try {
    ctx.provide(key, value);
    return true;
  } catch (error) {
    log(ctx, 'warn', `dshome/desktop: could not provide ${key}: ${String(error)}`);
    return false;
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - host context */
export function apply(ctx) {
  try {
    const dir = profileDir();
    if (!isAbsolute(dir)) {
      log(ctx, 'warn', 'dshome/desktop: profile dir is not absolute; disabling');
      return;
    }
    provideIfAbsent(ctx, 'desktopProfiles', {
      get current() {
        return { name: profileName(), dir: profileDir() };
      },
    });
    provideIfAbsent(ctx, 'desktopPnpm', { run: runPnpm });
    provideIfAbsent(ctx, 'desktopPlugins', {
      list: () => listDesktopPlugins(),
    });
    provideIfAbsent(ctx, 'desktopActions', {
      openTerminal() {
        log(ctx, 'warn', 'dshome/desktop: openTerminal is not supported in standalone mode');
      },
      requestRestart() {
        requestRestartSignal(ctx);
      },
    });
    log(ctx, 'info', 'dshome-desktop ready: desktopProfiles/desktopPnpm/desktopPlugins/desktopActions services live');
  } catch (error) {
    log(ctx, 'warn', `dshome/desktop disabled itself: %O`, error);
  }
}
