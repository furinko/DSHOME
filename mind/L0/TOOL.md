# TOOL.md — 工具操作指南

> 版本：1.1 | 2026-09-04 | AGENTS 位置引用校准（根版 E:\DSHOME\AGENTS.md）；余同 1.0（工具总索引 + 使用纪律）
> 渐进披露：阶段未解锁的工具不点名、不可调；tools_catalog/tools_help 可查。

## 一、工具总索引

| 用途 | 工具 | 要点 |
|---|---|---|
| 读文件 | `read` | UTF-8，带行号；大文件用 offset/limit 分批 |
| 找文件 | `glob` | 路径模式（含隐藏/忽略文件）；目录不返回 |
| 搜内容 | `grep` | ripgrep 正则，先搜后写 |
| 写文件 | `write` | 创建/全量覆盖；覆盖前先 read |
| 精准改 | `edit` | 替换唯一 old_string；多次出现用 replace_all 或加上下文 |
| 高级编辑 | `str_replace_editor` | view/create/str_replace/insert |
| 问用户 | `ask_user_question` | 需拍板/澄清时用，带稳定 id |
| 网页搜索 | `web_search` | 1–4 个 query，引用来源 |
| 任务清单 | `todo_write` | 完整列表每次全量提交 |
| 阶段路由 | `phase_advance` / `dev_router_status` | 渐进解锁，按阶段推进 |
| 工具白盒 | `tools_catalog` / `tools_help` | 查工具 schema，调用前先查参数名 |
| 目标追踪 | `create_goal` / `get_goal` / `update_goal` | 长任务完成目标 |
| 交付门禁 | `delivery_check` | 交付前自检（file/encoding/smoke/evidence） |
| 验证工具 | `pwsh` / `read_image` / `jobs` | 验证阶段解锁：跑命令/看截图/后台任务 |

## 二、使用纪律

- 🔴 **先搜后写** — 改任何文件前，先用 grep/glob 搜索相关引用与现有实现；不凭推测写码。
- 🟡 **省 token** — 能 grep 定位不 read 全文；能 read 片段不读整文件；大输出用 offset/limit。
- 🟡 **write 前先 read** — 覆盖已有文件必须 read 过（fs-observation-policy）。
- 🟡 **edit 用唯一锚点** — old_string 精确匹配；失败先 read 上下文再改。
- 🟡 **改动前一句话说明** — 占用时间/产生可见动作的操作，先说明"做什么、为什么、预计多久"。
- 🔴 **隐私** — 私密数据（凭据/隐私内容/敏感业务信息）一律不写入 mind\（出厂区）；只进 mind-private\ 且不推送。
- 🔴 **等放行** — 方案确定 ≠ 获准实施；改文件/构建/提交等用户明确放行（"动手/开工/同意"）。
- 🟡 **收工提醒** — 对话自然结束或完成一轮修改后，主动问一句「需要收工吗？」，触发收工闭环（见 L1/Power.md）。

## 三、与心智系统的关系

- 工具只是操作手段——"怎么用"的规则在根 `E:\DSHOME\AGENTS.md` 与 `mind\L1\Power.md`。
- 产物写入心智：正式结论 → mind-private 对应层；轮级缓冲 → mind-private\tasks\。
- 导入其他设备/agent 产物：走导入协议（import-artifact），见 mind\README.md §五。
