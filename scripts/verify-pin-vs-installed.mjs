#!/usr/bin/env node
/**
 * 校验「清单」与「货架」是否一致：profile 声明的**精确版本 pin** vs node_modules 里实际装着的版本。
 *
 * 为什么需要（2026-09-12 的教训）：
 *   pnpm 的版本面有两处真相——`profiles/dshome/package.json` 的 dependencies 是**清单**（随 git 同步，
 *   `pnpm-lock.yaml` 与之配套），而 `node_modules/<pkg>` 是**货架**（只有跑过 `pnpm install` 才跟上清单）。
 *   只拉 git 不 install 时，清单写着新版本、货架上还是旧包 ⇒ 机器跑的是旧货，而所有人看到的是新清单。
 *   实例：better-sidebar 0.19.0 → 0.19.1，pull 完不 install，症状是「任务管理又开回下栏」而非崩溃——
 *   这种「不崩的落后」最难被察觉，本脚本把它变成机器可见（只读两处 JSON，不下载、不改动）。
 *
 * 判定口径：
 *   - 只对**精确 pin**（形如 `1.2.3` / `1.2.3-rc.4`）做严格相等比较；
 *   - 范围 pin（`^0.43.0` / `~0.2.9`）与本地引用（`workspace:*` / `file:` / `link:`）**跳过**——
 *     它们的解析归 pnpm 语义，本脚本不做半套 semver 判断。
 *   - 货架上缺包 → 计为问题（那正是"忘了 install"的典型形态）。
 *
 * 反例（已实测 2026-09-12，证明本脚本不是恒绿 —— 台账要求）：
 *   把 --root 指向一个「只有 profiles/dshome/package.json、没有 node_modules」的临时目录，
 *   预期**应当变红**：实测 39 个精确 pin 全部 MISSING、exit 1。复跑：
 *     mkdir %TEMP%\pin-neg\profiles\dshome
 *     copy profiles\dshome\package.json %TEMP%\pin-neg\profiles\dshome\
 *     node scripts\verify-pin-vs-installed.mjs --root %TEMP%\pin-neg      (期望 exit 1)
 *   对照正例：--root 指向真实仓库 → 精确 pin 39 个全一致、exit 0。
 *   这正是「只拉 git、不跑 pnpm install」的机器形态：清单在、货架空。
 *
 * 用法：
 *   node scripts/verify-pin-vs-installed.mjs                  # 体检当前仓库
 *   node scripts/verify-pin-vs-installed.mjs --quiet          # 只在有问题时输出
 *   node scripts/verify-pin-vs-installed.mjs --root <dir>     # 体检指定目录（测试/他机诊断用）
 * 退出码：0 = 全部一致（或无可比项）；1 = 有不一致或缺失。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const rootArg = argv.indexOf('--root')
const root = rootArg >= 0 && argv[rootArg + 1] !== undefined
  ? resolve(argv[rootArg + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')

const profilePath = join(root, 'profiles', 'dshome', 'package.json')
/** 精确版本：三段数字 + 可选 prerelease 后缀；凡带范围符/协议前缀一律跳过。 */
const EXACT_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function say(msg) { if (!quiet) console.log(`[pin-check] ${msg}`) }

if (!existsSync(profilePath)) {
  console.error(`[pin-check] FAIL: 找不到 ${profilePath}（--root 指对了吗？）`)
  process.exit(1)
}

let profile
try {
  profile = JSON.parse(readFileSync(profilePath, 'utf8'))
} catch (err) {
  console.error(`[pin-check] FAIL: 解析 profile 失败: ${err.message}`)
  process.exit(1)
}

const deps = profile.dependencies ?? {}
const pinned = Object.entries(deps).filter(([, spec]) => EXACT_PIN.test(String(spec)))
const skipped = Object.entries(deps).length - pinned.length

const mismatched = []
const missing = []
for (const [name, spec] of pinned) {
  const pkgPath = join(root, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(pkgPath)) {
    missing.push({ name, pin: spec })
    continue
  }
  let installed
  try {
    installed = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  } catch {
    mismatched.push({ name, pin: spec, installed: '<unparsable package.json>' })
    continue
  }
  if (installed !== spec) mismatched.push({ name, pin: spec, installed })
}

say(`root=${root}`)
say(`精确 pin ${pinned.length} 个 · 跳过 ${skipped} 个（范围/本地引用）· 货架缺失 ${missing.length} · 版本不符 ${mismatched.length}`)

for (const m of mismatched) console.error(`[pin-check] MISMATCH ${m.name}: 清单=${m.pin} 已装=${m.installed}——跑 pnpm install 同步`)
for (const m of missing) console.error(`[pin-check] MISSING  ${m.name}: 清单=${m.pin} 货架上没有——跑 pnpm install 同步`)

if (mismatched.length > 0 || missing.length > 0) {
  console.error('[pin-check] ❌ 清单与货架不一致（git 已同步 ≠ 依赖已同步）')
  process.exit(1)
}
say('✅ 全部精确 pin 与 node_modules 实体一致')
process.exit(0)
