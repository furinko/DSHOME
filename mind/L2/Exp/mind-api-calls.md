---
name: mind-api-calls
description: 用脚本直打心智 HTTP API（`/api/mind/*`）的三条硬口径——① 必须带 `Sec-Fetch-Site: same-origin`（否则 403）② body 必须显式 UTF-8 字节（传字符串会把中文**静默**变 `?`，接口仍返 200）③ 写完必须**回读校验**。触发：打API / Invoke-RestMethod / api/mind / 心智API / 中文变问号 / body编码 / 回读校验 / cron任务API / CSRF / 403 forbidden。
version: 1.0.0
author: DSHOME
license: internal
contract:
  id: mind-api-calls
  triggers: [打API, Invoke-RestMethod, api/mind, 心智API, 中文变问号, body编码, 回读校验, cron任务API, CSRF, 403]
  inputs: [目标路由 + JSON body（可能含中文）]
  outputs: [正确调用口径（头 + 编码 + 回读）+ 已实测的路由形状]
  deps: []
metadata:
  tags: [PowerShell, Invoke-RestMethod, UTF-8, 编码, CSRF, curl, 心智API, 回读校验]
  related: [verify-integrity]
---

# mind-api-calls — 用脚本驱动 `/api/mind/*` 的操作口径

## 一、工具定位

**对治的病**：心智 API 从**脚本**里直打时有三个失败面，前两个**不报错**：

| # | 病 | 症状 | 为什么会静默 |
|---|---|---|---|
| ① | 缺 CSRF 头 | `403 forbidden` | 这个**会报**——三个里最"善良"的一个 |
| ② | body 传字符串 | 中文**变成 `?`** 存进去 | 接口**返 200**；`?` 是合法 ASCII，服务端分不出"用户真打了问号"还是"编码坏了" |
| ③ | 不校验 | 以为写对了 | 只有"发出去 → 读回来对照"才能发现上面这两条 |

**实测读数（当场 A/B，零副作用：只 `add`+`GET`+`remove`，没 `run`、没拉会话）**：
- `Invoke-RestMethod -Body '{"prompt":"中文测试A"}'` ⇒ 回读 **`????A:?????`**
- `-Body ([Text.Encoding]::UTF8.GetBytes($json))` ⇒ 回读 **`中文测试B：只回复收到`** ✅

**真实事故链（2026-09-24，本机实测）**：用字符串 body 加了一条自治任务 ⇒ 它的 prompt 落库即乱码 ⇒ `cron/run` 拉起的会话收到 `任务： ????…` ⇒ 那个 agent 为**自救**去翻会话数据（自造脚本解 zstd、dump 会话里的 user 消息）、在共享工作区里跑起来 —— 等于**放了一个满工具的 agent 进去**，而且**停不掉**（插件没暴露"停会话"路由）。⇒ 本口径的价值不在"省一步"，在**掐掉这条链的第一环**。

## 二、部署/接入

无实体脚本——本条目是**操作口径**。可复制的两行封装（PowerShell）：

```powershell
$h = @{ 'Sec-Fetch-Site' = 'same-origin'; 'Content-Type' = 'application/json' }
$body = [Text.Encoding]::UTF8.GetBytes((@{ id='x'; prompt='中文' } | ConvertTo-Json -Compress))
Invoke-RestMethod -Uri 'http://127.0.0.1:3099/api/mind/cron/add' -Headers $h -Method POST -Body $body
```

## 三、核心操作

| 我要做的事 | 走这个 | 别用 |
|---|---|---|
| 打任何 `/api/mind/*` | 带 `Sec-Fetch-Site: same-origin`（或等价 `Origin`，host 必须同源；默认端口 3099） | 裸打（403，且看不出为什么） |
| body 含非 ASCII | **`[Text.Encoding]::UTF8.GetBytes($json)`** | `-Body <字符串>`（默认编码 ⇒ 中文变 `?`） |
| 写完确认 | **回读**（`GET` 回来逐字段对） | 拿 200 当"写对了" |
| 测"接线通不通" | 只走 `add` / `GET` / `remove` 这类**不改行为**的调用 | 拿 `cron/run` 当探针——**它会拉起一个真 agent**（见上） |

**已实测的路由形状**（只列真跑过的）：
- `GET  /api/mind/cron` → `{ok, tasks[]}`（任务含 `lastRunAt` / `lastResult` / `lastAttach`）
- `POST /api/mind/cron/add` → body `{id, cron, prompt, cwd, workspace?, catchUp?, preset?}`
- `POST /api/mind/cron/update` → body `{id, ...patch}`（`workspace:''` = 清空回"按目录自动"；`'@none'` = 明确不登记）
- `POST /api/mind/cron/remove` → body `{id}` → `{ok, removed}`
- `POST /api/mind/cron/run` → body `{id}` → **会 `executeTask`（拉真会话）**，返回 `{status, sessionId, cwd, workspace:{attached, path, workspaceId, attempts, registryWaitedMs, deferred?}}`
- `GET  /api/mind/workspaces` → `{ok, workspaces:[{id,title,path}], diag:{registryRef,count}}`

**反例自检**（证明修法有效、且"乱码 ≠ 输入问题"）：同一条中文 prompt 分两次 `add`——字符串 body 一次、UTF-8 字节一次——各自 `GET` 回读对比。**两次都 200，只有回读能分开**。

### 已知边界（诚实标注）

- **不能靠门禁**：`?` 是合法 ASCII ⇒ 服务端无法判定真伪问号。这一条**只能靠纪律 + 回读**。
- **面板不受影响**：浏览器（GUI）发的是正确 UTF-8；本坑只存在于"**脚本直打**"这一面。
- **`/api/mind/cron/run` 的副作用**：它绕过 `cron.run()`（面板「立即运行」同路径）⇒ **不进 `cron-runs.jsonl` 台账**，且会真拉一个自治会话。要验接线就别碰它。

## 四、关联索引

- `mind/L2/Skill/verify-integrity.md` —— "接口返 200 ≠ 内容是对的"同源：**判据必须落在"结果变没变"，不是"动作做没做"**
- 私有区 Exp「读文本 / 比较文件的操作口径」（**私有区**，按标题引用）—— **读侧**同族：`Get-Content` 默认 ANSI ⇒ 中文乱码 + 私有全文上屏；本条目是它的**写侧姊妹**
- 本机 `Learn.md` 2026-09-11「探针要对被测资产零风险」及其 2026-09-24 补记（**私有区**，按标题引用）—— 上面那条事故链的原始记录与四条动作
- 本机项目档待办「`/api/mind/cron/run` 绕过 `cron.run()`——面板「立即运行」拉起的自治会话不进台账」（**私有区**，按标题引用）
