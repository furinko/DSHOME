# dsh-evolve 冒烟测试清单（重启后新会话执行）

> 背景：dsh-evolve v0.4.2 已装入 dshome profile（bundles 已配置，重启即生效）。
> `开发启动.cmd` 已修 PATH（System32 前置 → 后端进程 `tar` 命中 bsdtar，备份/回滚/fold 可用）。
> 静态验证已全绿（smoke 17 项 + apply-probe 22 工具注册），本清单验证真实 host 集成。

## 冒烟 1：工具可见性
新会话中确认以下工具出现在工具列表（至少抽查关键几个）：
`memory_remember`、`memory_recall`、`memory_index`、`memory_confirm`、`memory_profile`、
`memory_budget`、`crystallize_skill`、`refine_skill`、`skill_curator`、`archive_skill`、
`restore_skill`、`skill_rollback`、`converge_skill`、`fold_skill`、`skill_style`、`evolve_maintain`

## 冒烟 2：跨会话召回（核心）
1. 会话 A：调用 `memory_remember` 记一条 → 内容："我的猫叫咪咪"（kind=fact，importance=2）
2. 新开会话 B：问"我的猫叫什么名字？"
3. 期望：模型答"咪咪"（从记忆召回，而非上下文）
4. 观察：recall 注入是否出现在提示词（`evolve-protocol` 段 / Related Memories）

> ✅ **2026-08-31 实测通过**：写入"dsh-evolve 安装信息"（pending → 确认）后，新开会话问"最近装了哪个记忆插件"，模型答出 dsh-evolve / bsdtar。
> 关键前提：**pending 记忆不自动注入**（`injectionCount: 0`），必须先确认（`memory_confirm` 或面板）才参与跨会话召回——这是设计行为，不是故障。

## 冒烟 3：技能固化（自进化核心）
1. 在会话 A 里重复 2-3 次相同教训（如"写测试时绝不使用真实生产记录作为样本"）
2. 调用 `crystallize_skill`（指定 tag，如 `warehouse-safety`）
3. 期望：`~/.dsh/skills/`（即 E:\DSHOME\skills\）下生成 SKILL.md
4. 再调用 `refine_skill` 精炼一次 → 验证备份是否生成（`.curator-backups` 目录，验证 bsdtar 修复生效）
5. `skill_rollback` 验证回滚

> ✅ **2026-08-31 实测通过（完整闭环）**：
> - `crystallize_skill(tag=dsh-evolve)` → `dsh-evolve-integration` v1.0.0 写入 `E:\DSHOME\skills\`，**DSH 热加载**（本会话技能目录立即可见、`skill` 工具可加载）；
> - `refine_skill(tag=dsh-evolve)` → v1.1.0，追加 Refinement 段、保留人工编辑；**备份实证**：`.curator-backups\2026-08-31-0520-refine\dsh-evolve-integration.tgz` 由 bsdtar 成功生成（GNU tar 的 Windows 路径缺陷修复生效）。
> - 前置条件：refine 只折叠**已确认**的 lesson/decision 记忆（pending 不算，会返回 "no new confirmed..."）。

## 冒烟 4（进阶，可选）：审批门
1. 记一条高重要性（importance=3）或有冲突的记忆 → 期望进入 pending 待审
2. `memory_confirm` 确认 → 进入活跃记忆

## 注意
- 若冒烟 2 失败：检查 `evolve` 插件是否真的加载（settings → 插件列表应有 dsh-evolve）；
  若没有，检查 profiles/dshome/package.json 的 `dsh.profile.bundles` 是否含 `dsh-evolve`。
- 若 `fold_skill`/`skill_rollback` 报 tar 错误：PATH 修复未生效，确认 开发启动.cmd 的 PATH 行
  是否含 `C:\Windows\System32` 前置（后端进程需由新版 开发启动.cmd 拉起）。
- 记忆数据位置：DSH storage domain（`storages/`），SKILL.md 在 `skills/`。
