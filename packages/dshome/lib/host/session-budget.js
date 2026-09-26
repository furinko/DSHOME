// dshome-session-budget — 会话预算哨兵 host 插件（2026-09-26 立）
//
// 职责：在**合适的时机**提醒主人换新会话以省钱——会话上下文越长，每次模型请求越贵
//   （本机实测：单次请求成本 21–50 轮会话 0.0171 元 → 400+ 轮 0.0307 元，1.8 倍；
//    主会话平均上下文 34.1 万 token），成本 ≈ 请求次数 × 上下文长度，
//   故「刚交付完就换个新会话」是最有效的省钱动作。
//
// ── 何时才提示（本插件的全部价值都在这一条判据上）────────────────────────────
//   · 只在 `turn/end` 评估——**绝不打断进行中的回合**。
//   · `T1`（remindTokens，默认 15 万）：**只有本回合出现过 `deliverables/presented`**
//     （即刚交付完东西）才提示——没交付就提示＝打断主人干活，等于把人烦走。
//   · `T2`（strongTokens，默认 30 万）：不看是否交付，过了就提示（已在高水位）。
//   · 防烦人：每会话每水位只提示一次；每会话总提示上限 3 次；`session/disposed` 清状态。
//
// ── 两条通道（主人拍板：两条都要）────────────────────────────────────────────
//   ① 系统通知：POST 本机通知端口（照 `notify.js`：DSHOME_NOTIFY_PORT 默认 32123，
//      body `{title, body}`；投递是尽力而为，失败不抛）。
//   ② 对话内提醒：置「待注入」标记，**下一次** `agent/pre-step` 注入一条 user 消息
//      （照 `mind-recall.js` 写法：createUserMessage + insertAfterClaimed，插到 claimed
//      用户消息之后）。注入后立刻清标记 ⇒ 每会话每水位只注入一次。
//
// ── 纪律（照 `mind-compaction-log.js`）────────────────────────────────────────
//   · 规模取 `ctx.get('tokenMeter').measure(session).totalTokens`
//     ⚠️ tokenMeter 属**兄弟分支** fiber，属性访问 `ctx.tokenMeter` 会抛
//     `cannot get property "tokenMeter" without inject`（cordis 4.0.2）——
//     **必须**走 `ctx.get()`；且**刻意不**把它写进 inject（缺该服务的 profile 里本插件
//     仍须激活，只是不提示；把审计/提醒卖给严格没有意义）。
//   · 取不到规模 ⇒ **不提示**，只 warn（不猜、不假装有）；并通过落盘记一条 `unknown`
//     行留痕（每会话最多一条，避免每回合刷屏）。⚠️ 同 compaction-log 已实测的通道真相：
//     cordis exporter 默认级别阈值 1（info），warn=2 **默认被丢弃**（DSHOME 全栈无人声明
//     `levels`）⇒ 「打了 warn」不等于「已经响亮」，落盘那行才是主凭据。
//   · 全部 fail-open：任何异常只 warn，绝不阻塞会话。
//
// ── 落盘 ─────────────────────────────────────────────────────────────────────
//   `mind-private/tasks/evolution/session-budget-log.md`（独立文件，**只追加、不改写**，
//   带表头；不塞 changelog.md——那个文件有既存正则解析，塞进去会污染）。
//   每会话每个水位落**两行**：`turn/end` 的触发行（注入结果记 `pending`＝已置待注入标记）
//   ＋紧随其后 `agent/pre-step` 的注入行（触发水位记 `T1-inject`/`T2-inject`）。
//   —— 因为「注入是否真的落地」在 turn/end 那一刻还不知道，只追加不改写 ⇒ 只能多落一行，
//      不许回头改前一行的 `pending`。
//
// ── 子代理（成员）会话：不打扰、只留痕（Lead 裁断 2026-09-26）────────────────────
//   判据**逐字照 `notify.js:126` / `notify.js:181`**：`session?.header?.origin === 'subagent'`
//   （不另立新判据）。理由：成员会话**不是 live runtime root**——① 给主人弹「该换会话了」是
//   对着主人没在看的会话报水位＝假警报；② 往成员的消息流注入「建议顺带提一句要不要换个新
//   会话」会污染它自己的汇报（同 notify.js 对 `ask_user_question` 过滤 `subagent` 的理由）。
//   但主人正在做省钱决策，「成员会话也在长大」这个观测面不能丢 ⇒ 过水位**照落一行留痕**、
//   绝不打扰：触发水位列写 `T1-subagent` / `T2-subagent`，`通知结果`与`注入结果`两列都写 `-`；
//   同样遵守「每会话每水位一次」（复用 `st.level`），且不占 `MAX_PROMPTS_PER_SESSION` 名额。
//   对应两处实现：① `evaluate()` 的留痕分支；② `agent/pre-step` 的同一道过滤（直接
//   `return decision`，不注入）。
//
// ── 与冻结规格的两处非自由裁量说明（Lead 复核点）──────────────────────────────
//   · 设置命名空间用自己的 `dshome-session-budget`：`dshome` 已被 `notify.js` 注册，
//     dsh-settings 的 `register()` 对重名**硬抛**（`settings namespace "dshome" is already
//     registered`，见 node_modules/@deepseek-ai/dsh-settings/lib/index.js:283），
//     settings.yaml 里 `dshome:` 段也已存在（第 2679 行）⇒ 复用同命名空间＝注册必失败。
//     命名风格与 `plugin-manager.js` 的 `dshome-pluginmanager` 一致。
//   · 通知文案里的「超过 N 万」用**生效阈值**渲染（默认 150000 ⇒ 逐字等于冻结文案
//     「超过 15 万」）；阈值被改小/改大时文案仍为真，不再谎报 15 万。
//
// ── 一处已知边界（记录在案，不改判据）────────────────────────────────────────
//   待注入标记是**单槽**且「高水位覆盖低水位」。若某个 T1 标记还没被消费就跨到了 T2，
//   T1 的注入行不会出现（该水位的落盘只有触发行、`注入结果`停在 `pending`）。
//   此路径在真实循环里**不可达**：`dsh-agent-loop` 的 `turn()` 把 `agent/pre-step` 派发放在
//   `while (true)` 循环内（node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:937），
//   `turn/end` 在循环之后的 `finally`（同文件 :994）⇒ **每个回合结束前至少派发过一次
//   pre-step**，上一回合置的标记必然在下一回合的首步被取走。（隔离 harness 场景 F 真喂了
//   这条不可达路径，实测行为＝通知 2 条、注入 1 条、T1 触发行停在 `pending`。）

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 上游导出经 upstream 层运行时获取（理由见 upstream.js 头注：静态具名导入若在官方新版
// 消失会在模块链接期抛错，apply 的兜底够不着）。
import { createUserMessage, settingsNamespace, schemastery as z } from './upstream.js';
import { insertAfterClaimed } from './mind-insert.js';

/** Stable Cordis plugin name (cordis.patch.yml: name dshome/session-budget). */
export const name = 'dshome-session-budget';

/** Services this row requires before activation（与 mind-compaction-log 同形）。
 *  刻意**只列 fs**：tokenMeter 走 `ctx.get()` 按需取（见文件头）——列进 inject 会让
 *  缺该服务的 profile 里本插件整体不激活。 */
export const inject = ['fs'];

/** 设置命名空间（**不能**用 `dshome`：已被 notify.js 注册，重名注册硬抛，见文件头）。 */
export const SETTINGS_NAMESPACE = settingsNamespace ? settingsNamespace('dshome-session-budget') : 'dshome-session-budget';

/** 设置 schema：扁平对象，便于设置面单字段写入（照 notify.js 的三元短路写法——
 *  `z.boolean()` 在实参求值期就先跑，只在函数体里判空拦不住）。 */
export const SessionBudgetSettingsSchema = z ? z.object({
  // 总开关
  enabled: z.boolean().default(true),
  // 低水位（T1）：只有「本回合刚交付过东西」时才提示
  remindTokens: z.number().default(150000),
  // 高水位（T2）：不看交付，过线即提示
  strongTokens: z.number().default(300000),
}) : null;

/** 默认水位（schema 缺失或解析不到时也用这一份）。 */
const DEFAULT_SETTINGS = { enabled: true, remindTokens: 150000, strongTokens: 300000 };

/** 水位标签（落盘「触发水位」列的取值）。 */
const T1 = 'T1';
const T2 = 'T2';

/** 每会话最多提示次数（含 T1/T2 合计）。 */
const MAX_PROMPTS_PER_SESSION = 3;

/** 心智基座根：env DSH_HOME 优先，否则 dev 上溯到仓库根（与 mind-recall 同源）。 */
function repoRoot() {
  if (process.env.DSH_HOME && existsSync(join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
}

const HEADER = [
  '# 会话预算哨兵留痕（session-budget-log）',
  '',
  '> 由 host 插件 `dshome/session-budget` 机器追加；**只追加、不改写**。',
  '> 口径：只在 `turn/end` 评估（绝不打断进行中的回合）；`T1` = 本回合出现过 `deliverables/presented`',
  '> 且 `totalTokens ≥ remindTokens`（默认 15 万）；`T2` = `totalTokens ≥ strongTokens`（默认 30 万，不看是否交付）。',
  '> 同一会话同一水位只提示一次，每会话上限 3 次；`session/disposed` 清状态。',
  '> 每会话每个水位两行：`turn/end` 的**触发行**（注入结果记 `pending`＝已置待注入标记）',
  '> ＋紧随其后 `agent/pre-step` 的**注入行**（触发水位记 `T1-inject`/`T2-inject`，通知结果记 `-`）。',
  '> 触发水位 `T1-subagent`/`T2-subagent` = **子代理（成员）会话**过水位：不通知、不注入，只留痕，',
  '> 两列记 `-`（判据逐字照 notify.js:126/:181 的 `session.header.origin === "subagent"`；同样每水位一次）。',
  '> 注：待注入标记单槽、高水位覆盖低水位；若某水位的 `pending` 未及消费就被更高水位覆盖，',
  '> 它就只有触发行、没有注入行。真实循环不可达（每回合结束前至少派发一次 agent/pre-step）。',
  '> 上下文 token 取 `ctx.get("tokenMeter").measure(session).totalTokens`；取不到 → 不提示，',
  '> 并记一条 `unknown` 行（每会话最多一条）——warn 通道默认被丢弃（见插件头注），落盘才是主凭据。',
  '',
  '| 时间 | 会话 | 触发水位 | 上下文token | 本回合是否交付过 | 通知结果 | 注入结果 |',
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

/** 单元格内不允许出现裸 `|`（会破表）。 */
function cell(value) {
  return field(value).replace(/\|/g, '/');
}

/** 压成一行并截断（错误信息入表）。 */
function oneLine(value, max = 80) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 本地时间戳（人类可读；审计不需 ISO 精度）。 */
function stamp() {
  return new Date().toLocaleString('sv-SE').replace('T', ' ');
}

/** `{N}` 口径：万，**保留 1 位小数**。 */
function wan1(tokens) {
  return (Number(tokens) / 10000).toFixed(1);
}

/** 水位口径：万，整数不带小数尾巴（150000 → `15`；1000 → `0.1`）。 */
function wanWatermark(tokens) {
  return wan1(tokens).replace(/\.0$/, '');
}

/** 正有限数兜底（设置项被写成 0/NaN/负数时退回默认，不让判据变成瞎猜）。 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 设置快照归一（不信任外部对象形状）。 */
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    remindTokens: positiveNumber(src.remindTokens, DEFAULT_SETTINGS.remindTokens),
    strongTokens: positiveNumber(src.strongTokens, DEFAULT_SETTINGS.strongTokens),
  };
}

/** 系统通知文案（T1/T2）。 */
function notifyCopy(level, tokens, cfg) {
  if (level === T2) {
    return {
      title: '强烈建议换会话',
      body: `本会话上下文 ${wan1(tokens)} 万 token（已过高水位）。继续滚下去每轮都在为这段历史重复付费。`,
    };
  }
  return {
    title: '该换会话了',
    body: `本会话上下文 ${wan1(tokens)} 万 token —— 超过 ${wanWatermark(cfg.remindTokens)} 万后每次请求比短会话贵约 1.8 倍，趁刚交付完换个新会话最划算。`,
  };
}

/** 对话内注入文案（下一次 agent/pre-step 用）。 */
function injectText(level, tokens, cfg) {
  const watermark = level === T2 ? cfg.strongTokens : cfg.remindTokens;
  return `〔会话预算哨兵〕本会话上下文已达 ${wan1(tokens)} 万 token（≥${wanWatermark(watermark)} 万）。若主人手上这件事已收尾，建议顺带提一句"要不要换个新会话"；若任务没完就忽略这句，不要打断主人。`;
}

/** 会话 id（Session 实例的 `id`；退一步读 header.id）。取不到返回 ''（该事件不参与判据）。 */
function sidOf(session) {
  if (session && typeof session.id === 'string' && session.id) return session.id;
  const header = session && session.header;
  if (header && typeof header.id === 'string' && header.id) return header.id;
  return '';
}

/** 通知端口（照 notify.js 默认 32123；每次读 env，隔离测试可现场指定）。 */
function notifyPort() {
  const port = Number(process.env.DSHOME_NOTIFY_PORT || 32123);
  return Number.isFinite(port) && port > 0 ? port : 0;
}

/** 宿主插件主体。 */
export function apply(ctx) {
  try {
    const logPath = join(repoRoot(), 'mind-private', 'tasks', 'evolution', 'session-budget-log.md');
    /** sid -> { level, prompts, delivered, pending, unknownLogged } */
    const states = new Map();
    let settings = DEFAULT_SETTINGS;
    let writeFailures = 0;

    function append(line) {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        if (!existsSync(logPath)) writeFileSync(logPath, HEADER, 'utf8');
        appendFileSync(logPath, line + '\n', 'utf8');
        return true;
      } catch (error) {
        writeFailures += 1;
        ctx.logger?.('dshome').warn('dshome-session-budget: 写入失败（第 %d 次）%O', writeFailures, error);
        return false;
      }
    }

    function warn(...args) {
      ctx.logger?.('dshome').warn(...args);
    }

    /** 取该会话状态（无则建）。 */
    function ensure(sid) {
      let st = states.get(sid);
      if (st === undefined) {
        st = { level: 0, prompts: 0, delivered: false, pending: null, unknownLogged: false };
        states.set(sid, st);
      }
      return st;
    }

    /** 规模：不可得返回 null（调用方据此**不提示**并留告警）。 */
    function measureTokens(session) {
      try {
        // ctx.get() = cordis 免 inject 读取通道；属性访问 ctx.tokenMeter 在兄弟分支下会抛（见文件头）。
        const meter = typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined;
        const measured = meter?.measure?.(session);
        if (measured && Number.isFinite(measured.totalTokens)) return measured.totalTokens;
      } catch (error) {
        warn('dshome-session-budget: tokenMeter.measure 抛错 %O', error);
      }
      return null;
    }

    /** 投递系统通知；返回可入台账的结果串（投递本身尽力而为，绝不抛）。 */
    async function deliverNotification(title, body) {
      const port = notifyPort();
      if (!port) return 'skip: 端口未配置';
      try {
        const response = await fetch(`http://127.0.0.1:${port}/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, body }),
        });
        return response && response.ok ? 'ok' : `fail: http ${response ? response.status : 'no-response'}`;
      } catch (error) {
        // 壳未起 / 端口未监听：只记结果，绝不阻塞。
        return `fail: ${oneLine(error?.message ?? error)}`;
      }
    }

    /** `turn/end` 判据 + 两条通道。 */
    function evaluate(session, sid) {
      const st = ensure(sid);
      // 回合已结束：本回合的「交付过」标记在此消费掉（下一回合由 turn/start 重新置否）。
      const deliveredThisTurn = st.delivered;
      st.delivered = false;

      if (!settings.enabled) return;
      if (st.prompts >= MAX_PROMPTS_PER_SESSION) return;

      const tokens = measureTokens(session);
      if (tokens === null) {
        // 不猜、不假装有：不提示，只告警；并留一条 unknown 落盘证据（每会话最多一条）。
        warn('dshome-session-budget: 上下文规模不可得（tokenMeter 未解析或 measure 未给出 totalTokens），本回合不提示');
        if (!st.unknownLogged) {
          st.unknownLogged = true;
          append(row([stamp(), sid, 'unknown', 'unknown', deliveredThisTurn ? '是' : '否', '-', '-']));
        }
        return;
      }

      const cfg = { remindTokens: settings.remindTokens, strongTokens: settings.strongTokens };
      let level = null;
      if (tokens >= cfg.strongTokens) level = T2; // 高水位：不看是否交付
      else if (deliveredThisTurn && tokens >= cfg.remindTokens) level = T1; // 低水位：只有刚交付过才提示
      if (level === null) return; // 静默：没到水位，或没交付且未过高水位

      const reached = level === T2 ? 2 : 1;
      if (st.level >= reached) return; // 每会话每水位只提示一次
      st.level = reached;

      // 子代理（成员）会话：不通知、不注入，只落一行留痕（判据逐字照 notify.js:126 / :181）。
      if (session?.header?.origin === 'subagent') {
        append(row([stamp(), sid, `${level}-subagent`, String(tokens), deliveredThisTurn ? '是' : '否', '-', '-']));
        return;
      }

      st.prompts += 1;
      st.pending = { level, tokens, text: injectText(level, tokens, cfg) };

      const copy = notifyCopy(level, tokens, cfg);
      void deliverNotification(copy.title, copy.body).then((notifyResult) => {
        append(row([stamp(), sid, level, String(tokens), deliveredThisTurn ? '是' : '否', notifyResult, 'pending']));
      }, (error) => {
        append(row([stamp(), sid, level, String(tokens), deliveredThisTurn ? '是' : '否', `fail: ${oneLine(error?.message ?? error)}`, 'pending']));
      });
    }

    // ① 会话事件流：`turn/start` 重置交付标记；`deliverables/presented` 只记标记；
    //    `turn/end` 才评估（绝不打断进行中的回合）。
    ctx.on('session/event', (session, event) => {
      try {
        const type = event && event.type;
        if (typeof type !== 'string') return;
        const sid = sidOf(session);
        if (!sid) return;
        if (type === 'turn/start') {
          ensure(sid).delivered = false;
          return;
        }
        if (type === 'deliverables/presented') {
          ensure(sid).delivered = true;
          return;
        }
        if (type !== 'turn/end') return;
        evaluate(session, sid);
      } catch (error) {
        // 单条事件处理失败不拖垮插件（fail-open）。
        warn('dshome-session-budget: 事件处理失败 %O', error);
      }
    });

    // ② 对话内提醒：修完下一个决策点的消息流（照 mind-recall：先 await next()，再插入）。
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next();
      try {
        if (!createUserMessage) return decision; // 上游导出缺失 → 静默跳过（apply 期已有告警面）
        // 子代理（成员）会话：直接跳过注入（判据逐字照 notify.js:126 / :181）。成员不是 live
        // runtime root，那句「建议顺带提一句」会污染它的汇报；规模观测归 evaluate 的留痕分支。
        if (agent?.session?.header?.origin === 'subagent') return decision;
        const sid = sidOf(agent && agent.session);
        if (!sid) return decision;
        const st = states.get(sid);
        const pending = st ? st.pending : null;
        if (!pending) return decision;
        st.pending = null; // 先清标记：无论成败都只尝试一次（每会话每水位只注入一次）
        const message = createUserMessage({
          content: [{ type: 'text', text: pending.text }],
          source: { kind: 'plugin', plugin: name, form: 'budget' },
        });
        const result = insertAfterClaimed(decision, messages, message);
        const landed = Array.isArray(result && result.messages) && result.messages.includes(message);
        append(row([
          stamp(),
          sid,
          `${pending.level}-inject`,
          String(pending.tokens),
          '-',
          '-',
          landed ? 'ok' : 'skip: 无 decision.messages 通道',
        ]));
        return result;
      } catch (error) {
        // 注入失败只记日志，绝不阻断。
        warn('dshome-session-budget: 注入失败 %O', error);
      }
      return decision;
    });

    // ③ 会话销毁 → 清状态（避免内存随会话数长存）。
    ctx.on('session/disposed', (session) => {
      try {
        const sid = sidOf(session);
        if (sid) states.delete(sid);
      } catch (error) {
        warn('dshome-session-budget: 清理失败 %O', error);
      }
    });

    // ④ 设置面：注册命名空间并持续跟踪其值。
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        if (!SessionBudgetSettingsSchema) {
          warn('dshome-session-budget: schemastery 缺失 → 设置面停用（按默认水位工作）');
          return;
        }
        settingsCtx.effect(() => {
          const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, SessionBudgetSettingsSchema, { applies: 'live' });
          settings = normalizeSettings(scope.get());
          const stopWatching = scope.watch((next) => {
            settings = normalizeSettings(next);
          });
          return () => {
            stopWatching();
            settings = DEFAULT_SETTINGS;
          };
        }, 'dshome-session-budget: settings namespace');
      });
    } catch (error) {
      warn('dshome-session-budget: 设置面注册失败 %O', error);
    }

    ctx.logger?.('dshome').info('dshome-session-budget: 会话预算哨兵已挂载 → %s', logPath);
  } catch (error) {
    // 注意：此处不能调 try 块内定义的 warn（块级作用域）——直接走 ctx.logger。
    ctx.logger?.('dshome').warn('dshome-session-budget: 初始化失败 %O', error);
  }
}
