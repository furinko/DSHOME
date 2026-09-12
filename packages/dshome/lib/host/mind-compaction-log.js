// dshome-mind-compaction-log — 压缩留痕 host 插件（Item 2，2026-09-12 立）
//
// 职责：订阅会话事件流里的 `compaction/*`，把「什么时候压了、哪个会话、成功还是失败、
//   释放了多少 token」写成一行审计记录——把此前**静默发生**的上下文压缩变成可回看的事实。
//   （背景：DSH 侧上下文管理走 `dsh-compaction-basic`（thresholdRatio 0.8 自动摘要）+
//    `/compact` + 工具结果剪枝，全程无留痕；「静默失败」是 Learn 里反复出现的一族。）
//
// 落点：`mind-private/tasks/evolution/compaction-log.md`（**独立文件**）
//   —— 不塞 changelog.md：那个文件有既存正则解析，塞进去会污染（Ritual §四 已记的教训，
//      同 ledger.md 独立文件的理由）。
//
// 口径（实测依据，非推断）：
//   · 事件实参 = `session.append('compaction/end', lifecycle)`，lifecycle = `{ compactionId,
//     sourceCommandId?, turn }`（见 node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js），
//     失败路径再 spread `{ ...lifecycle, error }` ⇒ **事件本身不带「释放了多少 token」**。
//   · 所以释放量用 **前后各 measure 一次取差值**：`compaction/start` 记 before，
//     `compaction/end` 记 after，`释放 = before − after`（正数=腾出，负数=压缩自身开销）。
//   · token-meter 由 `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:317` 挂载（已实测）。
//     ⚠️ 它属**兄弟分支** fiber，不在本插件祖先链上 ⇒ 属性访问 `ctx.tokenMeter` 会抛
//     `cannot get property "tokenMeter" without inject`（cordis 4.0.2 reflect.get；2026-09-12
//     用同版 cordis 对照实验证得——首行「释放 token」曾因此恒为 `unknown`，是真 bug 不是框架缺能力）。
//     故**必须**走 `ctx.get('tokenMeter')`（cordis 明写的「不要求 inject 的读取通道」）。
//   · 也**刻意不**把 tokenMeter 写进 inject：缺该服务的 profile 里本插件仍须激活并把 unknown
//     记下来——审计留痕不能因为计量服务缺失而整体消失（fail-open 的反面是静默失联）。
//   · 取不到 → **记 `unknown`，不省略、不静默跳过**（Invariants #14「缺能力不假装通过」）。
//     ⚠️ 通道真相：cordis exporter 的级别阈值默认 1（info），而 warn=2 → **warn 默认被丢弃**
//     （node_modules/@deepseek-ai/cordis/lib/index.js:474）；DSHOME 全栈无人声明 `levels`，
//     故本插件的 warn 在线上其实**落不到任何 sink**。所以「unknown」这枚**落盘**证据才是主凭据，
//     warn 只算候选通道——不要把「打了 warn」当成「已经响亮」。
//
// 纪律：只追加、不改写；写失败 → logger.warn 留痕（fail-open，绝不阻塞会话）。

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name (packages/dshome/cordis.patch.yml: name dshome/mind-compaction-log). */
export const name = 'dshome-mind-compaction-log';

/** Services this row requires before activation（与 mind-recall 同形）。
 *  刻意**只列 fs**：tokenMeter 走 `ctx.get()` 按需取（见文件头）——若把它列进 inject，
 *  缺该服务的 profile 里本插件将不激活，留痕会**静默消失**（那就把审计卖了换严格）。 */
export const inject = ['fs'];

/** 心智基座根：env DSH_HOME 优先，否则 dev 上溯到仓库根（与 mind-recall 同源）。 */
function repoRoot() {
  if (process.env.DSH_HOME && existsSync(join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
}

const HEADER = [
  '# 压缩留痕（compaction-log）',
  '',
  '> 由 host 插件 `dshome/mind-compaction-log` 机器追加；**只追加、不改写**。',
  '> 口径：`释放` = `compaction/start` 时 `ctx.get("tokenMeter").measure().totalTokens` −',
  '> `compaction/end` 时同值（正数=腾出，负数=压缩自身开销）；取不到记 `unknown`（Invariants #14）。',
  '> 事件字段只有 `{ compactionId, sourceCommandId?, turn }`（+失败时 `error`）——段信息不在事件里。',
  '> `turn`：`null` = 手动压缩（无 turn 宿主，该字段恒存在）→ 记 `manual`；字段缺失才记 `unknown`。',
  '',
  '| 时间 | 会话 | 事件 | compactionId | turn | 释放 token | 结果 |',
  '|---|---|---|---|---|---|---|',
  '',
].join('\n');

/** 表格一行（列数不匹配属编码错误，故固定拼装，不做动态列）。 */
function row(cells) {
  return `| ${cells.join(' | ')} |`;
}

/** 字段取值：空/未定义一律 `unknown`（#14：不假装有）。 */
function field(value) {
  return value === undefined || value === null || value === '' ? 'unknown' : String(value);
}

/** 本地时间戳（人类可读；审计不需 ISO 精度）。 */
function stamp() {
  return new Date().toLocaleString('sv-SE').replace('T', ' ');
}

/** 单元格内不允许出现裸 `|`（会破表）。 */
function cell(value) {
  return field(value).replace(/\|/g, '/');
}

/** turn 专列：`null` = 手动压缩（lifecycle 里该字段恒存在，值为 null）；缺失/空 才 `unknown`。 */
function turnCell(value) {
  return value === null ? 'manual' : cell(value);
}

/** 宿主插件主体。 */
export function apply(ctx) {
  try {
    const logPath = join(repoRoot(), 'mind-private', 'tasks', 'evolution', 'compaction-log.md');
    /** sessionId -> { before: number|null }（start 时的计量快照） */
    const pending = new Map();
    let writeFailures = 0;

    function append(line) {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        if (!existsSync(logPath)) writeFileSync(logPath, HEADER, 'utf8');
        appendFileSync(logPath, line + '\n', 'utf8');
        return true;
      } catch (error) {
        writeFailures += 1;
        ctx.logger?.('dshome').warn('dshome-mind-compaction-log: 写入失败（第 %d 次）%O', writeFailures, error);
        return false;
      }
    }

    /** 计量：不可得返回 null（调用方据此写 unknown，并留告警）。 */
    function measureTokens(session) {
      try {
        // ctx.get() = cordis 免 inject 读取通道；属性访问 ctx.tokenMeter 在兄弟分支下会抛（见文件头）。
        const meter = typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined;
        const measured = meter?.measure?.(session);
        if (measured && Number.isFinite(measured.totalTokens)) return measured.totalTokens;
      } catch (error) {
        ctx.logger?.('dshome').warn('dshome-mind-compaction-log: tokenMeter.measure 抛错 %O', error);
      }
      return null;
    }

    const sidOf = (session) => (session && session.id ? String(session.id) : 'unknown');

    ctx.on('session/event', (session, event) => {
      try {
        const type = event && event.type;
        if (typeof type !== 'string' || !type.startsWith('compaction/')) return;
        const data = (event && event.data) || {};
        const sid = sidOf(session);

        if (type === 'compaction/start') {
          // 只记快照，不落行（结果在 end 落，含成败）。
          pending.set(sid, { before: measureTokens(session) });
          return;
        }

        if (type === 'compaction/summary') return; // 中间事件：不入审计行（避免三条一行一事）

        if (type === 'compaction/end') {
          const snapshot = pending.get(sid);
          pending.delete(sid);
          const after = measureTokens(session);
          const before = snapshot ? snapshot.before : null;
          const freed = Number.isFinite(before) && Number.isFinite(after) ? before - after : null;
          append(row([
            stamp(),
            sid,
            'compaction/end',
            cell(data.compactionId),
            turnCell(data.turn),
            freed === null ? 'unknown' : String(freed),
            data.error ? `失败：${cell(data.error).slice(0, 120)}` : '成功',
          ]));
          if (freed === null) {
            // 审计行已记 unknown；这里再留一条告警——「能力缺失」必须响亮，不能只留个 unknown 就算完。
            ctx.logger?.('dshome').warn('dshome-mind-compaction-log: 释放量不可得（tokenMeter 未解析或 measure 未给出 totalTokens），已记 unknown');
          }
          return;
        }

        if (type === 'compaction/prune') {
          append(row([
            stamp(),
            sid,
            'compaction/prune',
            cell(data.compactionId),
            turnCell(data.turn),
            'unknown', // 剪枝不参与差值口径（同一事务内先后顺序不保证）
            '工具结果剪枝',
          ]));
        }
      } catch (error) {
        // 单条事件处理失败不拖垮插件（fail-open）。
        ctx.logger?.('dshome').warn('dshome-mind-compaction-log: 事件处理失败 %O', error);
      }
    });

    // 会话销毁 → 清残留快照，避免内存泄漏（与 whale widget 的 session/disposed 同理）。
    ctx.on('session/disposed', (session) => {
      if (session && session.id) pending.delete(String(session.id));
    });

    ctx.logger?.('dshome').info('dshome-mind-compaction-log: 压缩留痕钩子已挂载 → %s', logPath);
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-compaction-log: 初始化失败 %O', error);
  }
}
