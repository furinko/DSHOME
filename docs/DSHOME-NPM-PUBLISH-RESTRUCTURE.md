# DSHOME 方案①：私有 verdaccio 发布 + 版本号依赖（根治 pnpm churn / 市场安装）

> ⚠️ 历史方案文档：内含当时本机绝对路径（E:\DSH、C:\Users\kuro 等），仅作方案参考，路径已过时。
> 目标：让 `dshome` / `dshome-theme` / `dshome-palette` 从「`file:` + 快捷方式」变成「普通版本号包」，
> 从而 **pnpm 市场安装不再破坏它们 / 不再 ENOENT**。
> ⚠️ **这是结构性改动，强烈建议先在一个备份/克隆的 profile 上演练通过，再动现在的 profile。**
> 涉及动作：发布 3 个包 + 改 profile 依赖 + 删 junction + 重装。

---

## 0. 备份（务必先做）
```
copy C:\Users\kuro\.dsh\profiles\dshome\package.json  C:\Users\kuro\.dsh\profiles\dshome\package.json.bak-publish
copy C:\Users\kuro\.dsh\profiles\dshome\      ...    E:\DSH\build-stage\dshome-node-snapshot\   （已有快照）
# 源码备份：E:\DSH\dshome、E:\DSH\packages\dshome-theme、E:\DSH\packages\dshome-palette 的可恢复副本
```

## 1. 起私有 registry（verdaccio，带 npmjs 上游）
```
npm install -g verdaccio
verdaccio                     # 默认监听 http://localhost:4873
```
verdaccio 默认对 `registry.npmjs.org` 有 **uplink（上游代理）**（看 `~/.config/verdaccio/config.yaml` 的 `uplinks`/`packages` 配置）。它会：
- 本地已发布的 `dshome*` → 直接给；
- `@deepseek-ai/*` 等 → 通过上游代理到 npmjs。

## 2. 把三个包改成"可发布"
每个包 `package.json`：
- 把 `"private": true` **去掉**（否则不能 publish）。
- 加：
  ```json
  "publishConfig": { "registry": "http://localhost:4873", "access": "public" }
  ```
- **`dshome` 特殊**：依赖 `"dshome-theme": "file:E:/DSH/packages/dshome-theme"` 改成 **`"dshome-theme": "0.1.0"`**（否则它被装时又会 file: 到本地，问题没根治）。`dshome-theme` 须比 `dshome` **先发布**。
- `dshome-theme`、`dshome-palette` 无跨包 file: 依赖，只去 private + 加 publishConfig。

## 3. 发布（顺序：先 dshome-palette / dshome-theme，再 dshome）
```
cd E:\DSH\packages\dshome-palette && npm publish --registry http://localhost:4873
cd E:\DSH\packages\dshome-theme   && npm publish --registry http://localhost:4873
cd E:\DSH\dshome                  && npm publish --registry http://localhost:4873
```
- 如果提示版本已存在：先 `npm version patch`（或 `patch --allow-same-version`）递增，再 publish。verdaccio 默认**不允许覆盖相同版本**。
- 发布后 `npm view dshome@0.1.0 version --registry http://localhost:4873` 能查到即为成功。

## 4. 改 profile 依赖（version 化）
`C:\Users\kuro\.dsh\profiles\dshome\package.json`：
```json
"dependencies": {
  "@deepseek-ai/dsh-base": "0.1.1-rc.2",
  "@deepseek-ai/dsh-web-app": "0.1.1-rc.2",
  "dshome": "0.1.0"          // ← 把 "file:E:/DSH/dshome" 换成 "0.1.0"
}
```
- `dshome-theme` / `dshome-palette` 作为 **dshome 的传递依赖** 会被装好（它们已在 dshome 的依赖里，dshome 发布后即带上）；bundles/patch 仍按 `name: dshome-theme` 解析，能命中 node_modules。
- 写 JSON **用 Node 或 utf8NoBOM**（别用 PowerShell `Set-Content -Encoding utf8`，会加 BOM 崩 `JSON.parse`）。

## 5. profile 指向 verdaccio
`C:\Users\kuro\.dsh\profiles\dshome\.npmrc`：
```
registry=http://localhost:4873
```
（这样 `dshome*` 从 verdaccio 拿，`@deepseek-ai/*` 经 verdaccio 上游代理到 npmjs。）

## 6. 移除快捷方式（关键 + 风险步骤）
把 profile `node_modules` 里的三个**快捷方式(junction)**删掉，让 pnpm 装成常规包：
- `node_modules\dshome`、`node_modules\dshome-theme`、`node_modules\dshome-palette`。
- **安全删法**：`Remove-Item <path> -Force`（**不带 -Recurse**）。**千万别用 `cmd /c rmdir /s /q`**（会顺着 junction 删光 `E:\DSH\packages\dshome-theme` 的真实内容）。
- 源码（`E:\DSH\dshome`、`E:\DSH\packages\...`）**不要动**，只删 profile node_modules 里的链接。

## 7. 重装
在 profile 目录：
```
pnpm install
```
现在 `dshome*` 都从 verdaccio 装成普通包、`@deepseek-ai/*` 从上游来，**不再碰 file:+junction**。

## 8. 验证
1. `dsh --profile dshome --no-open --port 3081` 启动 + `/api/community-market/state` 200。
2. 市场 安装 preview + execute（`@yolk_vat-y/dsh-project-memory`）→ 应**正常返回 200**，不再 502/ENOENT。
3. `packages\dshome-theme` 真实源码**完好**（没被删空）。

## 9. 坑与铁律
- **必须删完 junction 再 install**，否则 pnpm 又会碰旧链接。
- **verdaccio 必须持续运行**（本地 registry 一停，install/工作流就 404）。可 `verdaccio` 挂后台，或配置成服务。
- **版本号管理**：改 `dshome` 等源码 → `npm version patch` 新版本 → 重新 publish → profile 升版本号再 install。
- 官方 `@deepseek-ai/*` 仍走 npmjs；profile `.npmrc` 只把默认 registry 指 verdaccio（verdaccio 会代理官方源）。若只想本地包走 verdaccio、官方走 npmjs，可不用 `registry=` 全局指，但**未 scoped 的 `dshome*` 没法走 `@scope:registry`**，所以要么全局指 verdaccio（+上游），要么接受默认 registry=npmjs、发布用 `--registry` 指定（但那样 pnpm install 版本号依赖要从 npmjs 找 `dshome` → 404，不行）。**结论：全局指 verdaccio。**

## 10. 回退
若中途失败：用第 0 步备份还原 profile `package.json` + 快照里的 junction 结构重建（`junctions.txt` 有写法），把三个 junction 恢复。
