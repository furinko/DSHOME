# 鱼鱼能力积木索引（Ability Index）

> 像 CH4 的 Bricks/index.json——盘点鱼鱼所有可复用能力积木（技能/方法论/工具类）。
> 改/新增技能后**必更新此表**（否则能力沉淀了却找不到）。
> 用法：需要某能力 → 查此表 → 按指定积木的关键词触发加载（加载后即生效，硬约束）。

## 积木清单

| 积木 (id) | 一句话 | 触发 | 输入 → 输出 | 依赖 | 版本 |
|---|---|---|---|---|---|
| `import-artifact` | 导入协议·其他设备/agent 产物即插即用 | 直接丢给你 / 导入 / 蒸馏包 | 路径/粘贴内容/压缩包 → 归类放置 + 索引更新 + 汇报 | L1 Tree/Memory · mind README | 1.0.0 |
| `boot-recall` | 上工自动召回（project.md+L3+Learn+user-rules 装配成注入上下文） | 上工 / 你想不起来 / 有什么待办 | 项目/任务关键词 → 可注入上下文（`--json` 结构化） | scripts/mind-prime.mjs · mind L3/Project · mind-validate | 1.1.0 |
| `dshome-diagnostics` | DSHOME 后端诊断(崩/卡/闪断：先分真假+证据) | 后端重启/卡/exit1/闪断 | 现象→证据→结论 | shell log/进程/隔离复现 | 1.0.0 |
| `dshome-plugin-dev` | DSHOME/DSH 结构与运行时 Cordis 插件开发：写码前先 `cordis_inspect` 读真实接口，纯 JS `code.host`/`code.client`，生命周期/修复/回滚 | 做/改插件 / cordis / slot / `is not declared` / `host.call` 失败 | 目标能力 → 平台归属 + 已读真实接口 + 插件源码 + 修复判断 | cordis-plugin-development (upstream) · mind/L1/Power | 1.0.0 |
| `scar-inference` | 伤疤反推法/咬痕考古法：不蒸整体蒸版本差，不读架构图读咬痕 | 考古 / 蒸 / 版本差 / 反推坑 / 咬痕 / 伤疤 / 为什么在 / 作者画像 / 同源盲区 | 新旧产物 → 咬痕分布图(伤疤→约束) + 同作者不变量 + 跨版本镜像，每证标 A/B/C | mind/L1/Memory · mind/L1/Power | 1.1.0 |
| `landing-audit` | 落地审计三查法：文档说有 ≠ 机制在跑 ≠ 数据达标（定义/接线/数据逐层查） | 落到实处吗 / 落地了吗 / 真的在用吗 / 有效吗 / 审计 / 空壳字段 / 幽灵引用 | 概念名 → 三查证据链 + 分层 verdict + 病灶定位 + 修复优先级 | mind/L1/Design-Philosophy · mind/L1/Memory · mind/L1/Power | 1.0.0 |

## 怎么用（组合约定）

- **找积木**：上表按需求查触发行；命中即加载该技能文件（关键词触发）。
- **组合**：需多个能力时，依次加载对应积木，按顺序执行（每积木的 `inputs` 喂给下一个的 `outputs`）。
- **加积木**：新技能 → `mind\L2\Skill\<id>.md`（frontmatter 含 `contract`）+ 追加本表一行。
- **退役积木**：移 TRASH（不删只移）+ 删本表行 + 更新 `mind\L1\Tree.md`。

## 关联

`mind\L1\Power.md`（Skill/Exp 使用规则）· `mind\L1\Tree.md`（全知识索引）· `mind\L2\Exp\`（工具手册）

---

_版本：1.1 | 2026-09-04 | boot-recall/scar-inference 版本同步 1.1.0（头尾一致修复）；余同 1.0（能力积木化起步）_
