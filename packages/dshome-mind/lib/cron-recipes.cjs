// dshome-mind/lib/cron-recipes.cjs — 出厂自治「处方」（2026-09-14 建）
//
// ── 定位：出厂 ↔ 私有 怎么切（2026-09-14 定案）───────────────────────────────
//   · **能力出厂**：`cron.cjs`（到点拉起会话 + 面板可管）
//   · **处方出厂**：本文件——只有"任务该长什么样"（id / 建议周期 / prompt 骨架 / 占位符）
//   · **实例私有**：`mind-private/tasks/cron.json`（启用状态 / 周期 / 本机路径）
//   · **默认关**：出厂**不含任何任务实例**；只有使用者在面板点「建默认自治任务」时，
//     才由 `POST /api/mind/cron/seed` 把处方 seed 成实例（**点击＝同意**：自治会花 token、
//     并会改使用者自己的 `mind-private`）。
//
// ── 为什么这么切（判据 = "装机版能不能遵循"）───────────────────────────────
//   能被任何装机版遵循的 → 机制（出厂）；要先在本机建实例才成立的 → 实践/实例（私有）。
//   把清单留在出厂区却不带"怎么开起来"的处方，就变成一条**没人消费的空头义务**
//   （2026-09-14 主人当场指出「出厂写了有、实际是开发私有」的矛盾链）。
//
// ── 🔴 硬要求（Invariants #13 出厂卫生）────────────────────────────────────
//   本文件**不得**出现本机路径 / 项目名 / 凭据。一切本机读数走占位符：
//     `{{cwd}}`（当前工作区）· `{{projectKey}}`（工作区目录名 = 记忆区的项目 key）
//   由 seed 时按**当前工作区**填；出厂模板本身必须能对任何使用者成立。
'use strict';

const RECIPES = [
  {
    id: 'self-clean',
    title: '自主维护 · 每日（维护 + 巡检）',
    cron: '0 0 * * *',
    why: 'Ritual §二/§四：定期清自己弄脏的 + 主动巡检找隐患；🔴 只碰自己产生的，不碰用户的东西',
    prompt:
`【自主维护 · 每日】依据唯一 = mind\\L1\\Ritual.md（本 prompt 只是执行清单；与规则冲突时以规则为准——动手前先读 Ritual §二/§三/§四、Memory §十一）。

A 维护（Ritual §二 清单 · 🔴 只碰「自己弄脏的」）：① 清自己产生的中间物（临时/中介/日志/缓存）② 轮级缓冲（mind-private\\tasks\\pending\\ 待放行 + mind-private\\L1\\Dream.md）蒸馏或清空 ③ pending 超 7 天 → 列出提醒，不擅毁 ④ 记忆层裁剪按 Memory §十一 范围表（快照按时间窗；Learn/L3 归并退役走 trash 不直接删）⑤ 机器判「无效/恶化」的进化只列待人拍、不自动回滚。仓库内清理一律走 node scripts/evolve-log.mjs trash（不删只移 + 留痕）；构建/删除类等放行。
B 进化体检（Ritual §三 + §一 step8）：跑 node scripts/evolve-log.mjs health，按自主信号处置——① 判效空转/覆盖不足 → 补绑主信号 ② 未回填 ≥5 → effect auto 机器判 ③ 未裁决「无效/恶化」≥2 → 列人拍 ④ 记录 ≥8 且 repeat-mistakes ≥2 → 审视进化。人拍后用 decide 记账（消费端，§四）。⚠️ 判据/输入缺失不得判「通过」（Invariants #14）。
C 巡检（Ritual §四「主动找隐患」）：① 记忆健康（Tree↔_index↔实体一致 + 死链/孤儿引用）② 规则冲突（L0/L1 自相矛盾/过时引用）③ 行为信号（Learn 💢/🤗 与 metrics 口径是否还自洽）④ 系统积压（cron 任务状态/pending/curate 候选/.curate-jobs.json）⑤ 能力缺口（Power §三：该收录未收录的 Skill/Exp）⑥ 出厂卫生（mind-validate --strict + verify-payload）⑦ 脚本面全量冒烟（node scripts/verify-scripts-run.mjs --all：补「真跑冒烟在 hook 里只跑暂存脚本」的盲区——依赖侧改动弄坏测试时链上看不见；一条命令覆盖白名单内全部脚本）。
D 处置口径（Ritual §四）：**能处理的就处理掉；需要决策的进待办；不要在任务中留未决项**——① 能处理＝不需用户取向/放行的（低危、可逆、本轮有验证手段）⇒ 本轮做完 + 给证据，不许只写进报告或待办；② 需决策＝需用户取向或放行的 ⇒ 追加 mind-private\\L3\\projects\\{{projectKey}}\\project.md，一条一句取向问题并提示；③ 不留未决项＝禁止“待查/待定/待实测”悬空：要么本轮实测钉死（给判据+读数），要么明写“已登记待办第 N 条、等用户一句”。
🔴 边界（Ritual §二）：不删/归档用户记忆内容、不动用户路径与配置（settings/凭证）；用户内容只列不擅动。
汇报：洗了啥 + 发现哪些隐患 + 建议。`,
  },
  {
    id: 'self-feed',
    title: '自主内化 · 每周（把存货变成能力）',
    cron: '0 22 * * 0',
    why: 'Power §三/§四 + Ritual §一 step4 + Dream §三：定期把轮级缓冲/未固化教训按判据沉淀成能力',
    prompt:
`【自主内化 · 每周】依据唯一 = mind\\L1\\Power.md §三/§四 + Ritual.md §一 step4/§四 + Dream.md §三（本 prompt 只是执行清单；与规则冲突时以规则为准）。
⚠️ 周期「每周」是**本机默认取值**（省 token）——规则里蒸馏由「重要任务收尾/收工」触发，此处只作兜底。

1 先盘存货：无货 → 30 秒内结束并报告「无存货」。存货 = 轮级缓冲（mind-private\\tasks\\pending\\ + mind-private\\L1\\Dream.md）/ Learn 未固化条目 / 未蒸馏的踩坑与产物。
2 有货（≥3 条可内化）→ 逐条过 Power §四 蒸馏三问（跨项目可复用 / 有验证过的逻辑 / 以后还会遇到；≥2 条才沉淀）；不过的留缓冲或不记，别瞎吃。
3 按落点入库：方法论/流程 → mind\\L2\\Skill\\<id>.md（frontmatter 含 contract）+ _index + Tree；工具手册 → mind-private\\L2\\Exp\\<id>.md + 该目录 README 表；教训 → L3\\common\\lessons（+_index）；偏好 → L3\\common\\user-rules；项目决策/事件 → L3\\projects\\<项目>\\知识（项目专属工具不收录，记 project.md）。
4 灵感池整理（Dream §三：池中 ≥3 条 → 主动提醒用户；该蒸馏的蒸馏、该落待办的落待办、该作废的作废）。
5 索引与账：Skill → _index+Tree；记忆 → 对应 _index；改「自我类」→ node scripts/evolve-log.mjs snapshot + log（一进化一主信号）。
6 处置口径（Ritual §四，同 self-clean）：**能处理的就处理掉；需要决策的进待办；不要在任务中留未决项**——① 能处理＝不需用户取向/放行的（低危、可逆、本轮有验证手段）⇒ 本轮做完 + 给证据，不许只写进报告或待办；② 需决策＝需用户取向或放行的 ⇒ 追加 mind-private\\L3\\projects\\{{projectKey}}\\project.md，一条一句取向问题并提示；③ 不留未决项＝禁止“待查/待定/待实测”悬空：要么本轮实测钉死（给判据+读数），要么明写“已登记待办第 N 条、等用户一句”。
🔴 刹闸（Power §三）：L0/L1 规则、护栏/插件代码、运行时注册、git 提交仍等放行；L2 生长区免放行但要汇报。
汇报：吃了啥 + 改了哪些索引。`,
  },
];

/** 占位符渲染：`{{key}}` → vars[key]（缺失则原样保留，便于自证"没填"）。 */
function render(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const v = vars ? vars[k] : undefined;
    return v === undefined || v === null ? m : String(v);
  });
}

/** 工作区目录名 = 项目 key（与记忆落点 `L3\projects\<key>\` 的口径一致）。 */
function projectKeyOf(cwd) {
  const norm = String(cwd || '').replace(/[\\/]+$/, '');
  const base = norm.split(/[\\/]/).filter(Boolean).pop() || '';
  return base;
}

/** 按变量解析出可直接 add 的处方（不落盘、不建实例——建实例只发生在 seed 路由）。 */
function resolveRecipes(vars) {
  return RECIPES.map((r) => ({ ...r, prompt: render(r.prompt, vars) }));
}

module.exports = { RECIPES, render, projectKeyOf, resolveRecipes };
