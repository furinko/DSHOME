// dshome-mind-skill-loader — Skill 关键词触发加载 host 插件（方法论卡片注入）。
//
// 职责：对话中检测到 Skill 触发词时，机器自动注入一张「方法论卡片」
//      （frontmatter description + contract.outputs 摘要，~150 token）——
//      让鱼"不靠记得"就知道有对应方法论可用，且知道去哪读全文。
//
// 设计（2026-09-05，主人拍板"方法论卡片"方向）：
//   - Skill 不是记忆/纪律（不常驻），是"遇到那类事才需要的手册"→ 每步检测、中途触发。
//   - 注入「卡片」而非全文：全文几十上百行灌上下文违反系统"少而精"纪律；
//     卡片给"这个方法论解决什么 + 产出什么 + 全文在哪"，鱼需要时自己 read。
//   - 防误伤：同 Skill 同会话只提示一次（injectedSessions 去重）；
//     触发词取 frontmatter contract.triggers 的精确词（非宽泛词）。
//   - fails-open：解析/扫描失败只记日志，绝不阻塞会话。
//
// 与既有插件分工：mind-inject（L0 纪律摘要·首步）· mind-recall（记忆召回·首步）·
//                  mind-guard（护栏·write 前）· 本插件（Skill 卡片·每步检测）。
//
// 三步注册（dshome-plugin-dev §十）：① 本文件 ② package.json exports 补 ./mind-skill-loader
//  ③ cordis.patch.yml 加 dshome-mind-skill-loader 条目 + settings.yaml include 启用。

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Stable Cordis plugin name (cordis.patch.yml: name dshome/mind-skill-loader). */
export const name = 'dshome-mind-skill-loader';

/** Services this row requires before activation. */
export const inject = ['fs'];

/** 心智基座根：env DSH_HOME 优先，否则 dev 上溯到仓库根。 */
function repoRoot() {
  if (process.env.DSH_HOME && existsSync(join(process.env.DSH_HOME, 'mind'))) return process.env.DSH_HOME;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
}

/** 诊断 marker（仅启动确认）。 */
function writeMarker(content) {
  try {
    const root = repoRoot();
    const dir = join(root, 'profiles', 'dshome', '.dsh-market');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mind-skill-loader-marker.txt'), content, 'utf8');
  } catch { /* 诊断标记失败不影响插件 */ }
}

/** frontmatter 取值（key: value，去引号）。CRLF 兼容：先归一化 \r\n → \n。 */
function fmValue(content, key) {
  const c = String(content || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---/.exec(c);
  if (!m) return '';
  const r = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*([^\\n]+)').exec(m[1]);
  return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

/** 解析 frontmatter 里的数组字段（triggers/inputs/outputs——YAML 流式数组 `[a, b]` 或多行 `- x`）。CRLF 兼容。 */
function fmArray(content, key) {
  const c = String(content || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---/.exec(c);
  if (!m) return [];
  const body = m[1];
  // 流式 [a, b]
  const flow = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*\\[([^\\]]*)\\]').exec(body);
  if (flow) return flow[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  // 多行 - x（缩进在 key 下）
  const idx = new RegExp('(?:^|\\n)\\s*' + key + ':').exec(body);
  if (idx) {
    const rest = body.slice(idx.index + idx[0].length).split('\n');
    const out = [];
    for (const line of rest) {
      if (!/^\s*-\s+/.test(line)) break;
      out.push(line.trim().replace(/^-\s+/, '').replace(/^['"]|['"]$/g, ''));
    }
    return out;
  }
  return [];
}

/** 加载全部 Skill 的触发索引（读双区：出厂 mind\L2\Skill\ + 私有暂存 mind-private\L2\Skill\，同名私有优先）。
 *  返回 [{ id, full, description, triggers, outputs, zone }]；读不了 frontmatter 的跳过。 */
function loadSkillIndex() {
  const factoryDir = join(repoRoot(), 'mind', 'L2', 'Skill');
  const privateDir = join(repoRoot(), 'mind-private', 'L2', 'Skill');
  const skills = [];
  const byId = new Map(); // 同名去重用（私有覆盖出厂）

  // 先扫出厂，再扫私有（私有同名覆盖）
  for (const [dir, zone, relPrefix] of [
    [factoryDir, 'factory', 'mind/L2/Skill'],
    [privateDir, 'private', 'mind-private/L2/Skill'],
  ]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || name === 'README.md' || name === '_index.md') continue;
      const full = join(dir, name);
      let content = '';
      try { content = readFileSync(full, 'utf8'); } catch { continue; }
      const id = fmValue(content, 'name') || name.replace(/\.md$/, '');
      const description = fmValue(content, 'description');
      const triggers = fmArray(content, 'triggers');
      const outputs = fmArray(content, 'outputs');
      if (id && triggers.length) {
        const entry = { id, full: relPrefix + '/' + name, description, triggers, outputs, zone };
        byId.set(id, entry); // 私有同名覆盖出厂（后扫的 private 胜）
      }
    }
  }
  return [...byId.values()];
}

/** 消息文本抽取（content 可能是 string 或 blocks）。 */
function contentText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('\n');
  return '';
}

/** 宿主插件主体。 */
export function apply(ctx) {
  try {
    // 懒加载 + 目录指纹缓存：apply 不静态持有 skills——
    // 运行中新增私有/出厂 skill 即时生效（目录 mtime/文件集变化才重扫），不用重启。
    let cached = null;   // { skills, fingerprint }
    function dirFingerprint(dir) {
      if (!existsSync(dir)) return '';
      return readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md' && n !== '_index.md')
        .sort().map((n) => n + ':' + statSync(join(dir, n)).mtimeMs).join('|');
    }
    function getSkills() {
      const fp = dirFingerprint(join(repoRoot(), 'mind', 'L2', 'Skill')) + '#' +
                 dirFingerprint(join(repoRoot(), 'mind-private', 'L2', 'Skill'));
      if (cached && cached.fingerprint === fp) return cached.skills;
      const skills = loadSkillIndex();
      cached = { skills, fingerprint: fp };
      return skills;
    }
    // 启动即探一次（marker 记当前数）
    const initial = getSkills();
    if (!initial.length) {
      writeMarker(`apply: no skills parsed @ ${new Date().toISOString()}`);
      return;
    }
    writeMarker(`apply: registered hook (skills=${initial.length}, lazy) @ ${new Date().toISOString()}`);

    // 每会话已提示过的 Skill id（防重复刷屏）
    const hintedBySession = new Map(); // sessionKey -> Set<skillId>

    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      try {
        const key = agent?.session?.header?.id ? `session:${String(agent.session.header.id)}` : null;
        if (!key || decision?.kind !== 'enter') return decision;
        if (!hintedBySession.has(key)) hintedBySession.set(key, new Set());
        const hinted = hintedBySession.get(key);

        // 扫"本会话全部消息"找触发词（简单可靠：命中未提示过的 Skill 就注入卡片）
        const joined = [...(messages || []), ...(decision.messages || [])].map(contentText).join('\n');
        if (!joined) return decision;

        const skills = getSkills(); // 懒加载：目录变了自动重扫（新增私有 skill 即时生效）
        let injected = false;
        for (const skill of skills) {
          if (hinted.has(skill.id)) continue;
          // 触发词命中检测（精确词；避免命中自身文件名/说明里的词导致自触发）
          const hit = skill.triggers.some((t) => t && joined.includes(t));
          if (!hit) continue;

          hinted.add(skill.id);
          const outLine = skill.outputs && skill.outputs.length
            ? '产出：' + skill.outputs.join('；')
            : '';
          const card = [
            '',
            `🧩 命中方法论「${skill.id}」：${skill.description || ''}`,
            outLine,
            `全文 \`${skill.full}\`（命中提示——需要时 read 全文即生效${skill.zone === 'private' ? '；私有区不推送' : ''}）`,
            '',
          ].filter(Boolean).join('\n');

          const cardMessage = createUserMessage({
            content: [{ type: 'text', text: card }],
            source: { kind: 'plugin', plugin: name, form: 'skill-hint' },
          });
          // 追加到消息流末尾（提示性质，不抢占位置）
          decision.messages.push(cardMessage);
          injected = true;
          ctx.logger?.('dshome')?.info?.('dshome-mind-skill-loader: hinted %s (session %s)', skill.id, key);
        }
        if (injected) return decision;
      } catch (error) {
        ctx.logger?.('dshome').warn('dshome-mind-skill-loader: 检测失败 %O', error);
      }
      return decision;
    });
    ctx.logger?.('dshome').info('dshome-mind-skill-loader: Skill 触发加载钩子已挂载 (%d skills)', skills.length);
  } catch (error) {
    ctx.logger?.('dshome').warn('dshome-mind-skill-loader: 初始化失败 %O', error);
  }
}
