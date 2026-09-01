// dshome/plugin-store — 插件清单 / 启停共享逻辑（plugin-manager 与 plugin-api 共用）。
// 单一实现：plugin-manager（设置页总线）与 plugin-api（/api/dshome/plugins）读同一份真相。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..'); // packages/dshome/lib/host → 仓库根

// ── 插件中文描述映射（优先；缺失时回退包 package.json 的英文 description）──────
const DESC_CN = {
  // 自制
  'dshome/core': 'DSHOME 扩展点服务（命令 / 面板注册表）',
  'dshome/shell': 'Electron 薄壳：窗口 / 托盘 / 后端守护与自动重启',
  'dshome-theme': 'DSHOME 品牌皮肤与设置 UI（通知开关、插件管理分区）',
  'dshome-palette': 'Ctrl+K 命令面板（会话标题 / 打开 / 收藏）',
  'dshome/notify': '回合级系统通知（可在设置开关）',
  'dshome/plugin-manager': '插件列表与启停（写 profile patch，重启生效）',
  'dshome/desktop': '桌面服务兼容层（接口与 dshmarket 不匹配，已禁用）',
  'dshome-plugin-center': '插件管理中心（本面板）',
  'dshome-plugin-api': '插件管理控制面（/api/dshome/plugins）',
  // 本地预设插件（router-standard 等；moduleName 形如 ./router-bootstrap-v34.mjs?v=N）
  'router-bootstrap': 'router-standard 预设核心：阶段化工具解锁 / 交付门禁',
  'gitbash-executor': 'Git for Windows Bash 私有 shell 服务（win32 真 Git Bash）',
  // 核心 / 官方常用
  'cordis:include': '插件加载入口（Cordis 核心）',
  '@deepseek-ai/dsh-base': 'DSH 基础层：会话 / LLM / 工具等核心行',
  '@deepseek-ai/dsh-web-app': 'Web 浏览器面：官方 UI roster 与 webserver',
  '@deepseek-ai/dsh-session': '事件源会话存储（对话历史的唯一真源）',
  '@deepseek-ai/dsh-session-persistence-jsonl': '会话持久化（JSONL 落盘）',
  '@deepseek-ai/dsh-session-query-sqlite': '历史会话全文检索（SQLite）',
  '@deepseek-ai/dsh-session-title-llm': '会话标题自动生成',
  '@deepseek-ai/dsh-llm': '大模型接入层（provider / model 路由）',
  '@deepseek-ai/dsh-llm-retry': '模型请求失败重试',
  '@deepseek-ai/dsh-llm-deepseek': 'DeepSeek 模型适配',
  '@deepseek-ai/dsh-agent-loop': '代理循环：turn / step 驱动与注入',
  '@deepseek-ai/dsh-agent-instructions': 'AGENTS.md 工作区指令注入',
  '@deepseek-ai/dsh-agent-tool-presentation': '工具呈现层（模型可见的工具清单）',
  '@deepseek-ai/dsh-persona': '部署人格配置',
  '@deepseek-ai/dsh-plan-mode': '计划模式（先规划后执行）',
  '@deepseek-ai/dsh-command-compact': '/compact 会话压缩命令',
  '@deepseek-ai/dsh-compaction-basic': '会话压缩（超窗时精简上下文）',
  '@deepseek-ai/dsh-compaction-tool-result-pruner': '工具结果压缩',
  '@deepseek-ai/dsh-skill': '技能注册表（ctx.skills）',
  '@deepseek-ai/dsh-skill-filesystem': '技能目录发现与热加载（skills/）',
  '@deepseek-ai/dsh-tool-skill': '技能加载工具（skill）',
  '@deepseek-ai/dsh-tool-fs': '文件读写工具（read / write / edit）',
  '@deepseek-ai/dsh-tool-fs-search': '文件搜索工具（grep / glob）',
  '@deepseek-ai/dsh-tool-str-replace-editor': '字符串替换编辑工具',
  '@deepseek-ai/dsh-tool-bash': 'Bash 命令执行工具',
  '@deepseek-ai/dsh-tool-bash-persistent': '持久 Bash 会话',
  '@deepseek-ai/dsh-tool-pwsh': 'PowerShell 命令执行工具',
  '@deepseek-ai/dsh-tool-pwsh-persistent': '持久 PowerShell 会话',
  '@deepseek-ai/dsh-tool-subagent': '子代理工具（后台委托）',
  '@deepseek-ai/dsh-tool-subagent-control': '子代理控制（列表 / 中断）',
  '@deepseek-ai/dsh-tool-subagent-report': '子代理结果汇报',
  '@deepseek-ai/dsh-tool-goal': '跨轮目标工具',
  '@deepseek-ai/dsh-goal': '目标服务（持久目标驱动多轮迭代）',
  '@deepseek-ai/dsh-tool-todo': '任务清单工具',
  '@deepseek-ai/dsh-tool-web': '网页检索工具',
  '@deepseek-ai/dsh-tool-workflow': '工作流编排工具',
  '@deepseek-ai/dsh-tool-jobs': '后台任务工具',
  '@deepseek-ai/dsh-tool-cordis': 'Cordis 服务调用工具',
  '@deepseek-ai/dsh-tool-ralph': 'Ralph 循环工具（新鲜子代理迭代）',
  '@deepseek-ai/dsh-tool-ask-user': '向用户提问工具',
  '@deepseek-ai/dsh-tools': '工具注册表（ctx.tools）',
  '@deepseek-ai/dsh-terminal': '终端服务',
  '@deepseek-ai/dsh-terminal-bash': '终端 Bash 后端',
  '@deepseek-ai/dsh-system-prompt': '系统提示词（persona）',
  '@deepseek-ai/dsh-fs-local': '本地文件系统服务',
  '@deepseek-ai/dsh-fs-sandbox': '沙箱文件系统（权限门控）',
  '@deepseek-ai/dsh-fs-observation-policy': '文件观察策略（读写前必读）',
  '@deepseek-ai/dsh-sandbox': '沙箱策略（bash / 文件统一）',
  '@deepseek-ai/dsh-storage': '存储域服务',
  '@deepseek-ai/dsh-storage-json': 'JSON 存储域（持久化数据）',
  '@deepseek-ai/dsh-storage-domain': '存储域表抽象',
  '@deepseek-ai/dsh-settings': '设置服务（命名空间 + 持久化）',
  '@deepseek-ai/dsh-settings-file': '设置文件持久化（settings.yaml）',
  '@deepseek-ai/dsh-user-questions': '用户提问服务',
  '@deepseek-ai/dsh-user-approval': '用户审批（危险操作确认）',
  '@deepseek-ai/dsh-message-feedback': '消息反馈（赞 / 踩信号）',
  '@deepseek-ai/dsh-jobs': '后台任务服务',
  '@deepseek-ai/dsh-subagent': '子代理服务（隔离会话）',
  '@deepseek-ai/dsh-workflow': '工作流服务',
  '@deepseek-ai/dsh-host-webserver': 'Web 服务器（同源页面与 API）',
  '@deepseek-ai/dsh-host-apiproxy': 'API 代理（平台 RPC 通道）',
  '@deepseek-ai/dsh-web-frontend': '前端静态资源',
  '@deepseek-ai/dsh-web-search-deepseek': 'DeepSeek 网页搜索',
  '@deepseek-ai/dsh-mcp-client': 'MCP 客户端（外部工具桥）',
  '@deepseek-ai/dsh-credentials-local': '本地凭证库（API Key）',
  '@deepseek-ai/dsh-client-runtime': '浏览器端运行时',
  '@deepseek-ai/dsh-client-connection': '浏览器连接服务',
  '@deepseek-ai/dsh-client-modules': '客户端模块系统（roster 组装）',
  '@deepseek-ai/dsh-client-ui-sidebar': '官方侧边栏 UI',
  '@deepseek-ai/dsh-client-ui-settings': '官方设置页 UI',
  '@deepseek-ai/dsh-client-ui-conversation': '官方对话区 UI',
  '@deepseek-ai/dsh-client-ui-renderer': '官方渲染器（slots 渲染）',
  '@deepseek-ai/dsh-client-ui-layout': '官方布局壳',
  '@deepseek-ai/dsh-client-ui-locale': '官方界面语言',
  '@deepseek-ai/dsh-client-ui-slots': 'UI 槽位注册表',
  // 下载
  'dshmarket': '插件市场（浏览 / 安装 / 卸载）',
  'dsh-evolve': '跨会话记忆 + 技能固化（审批门 / 零token召回）',
  'dsh-whale-widget': 'DeepSeek 余额鲸鱼挂件',
  'dsh-better-sidebar': '侧边栏工作台增强（文件 / 终端 / 子代理 tab）',
  '@nanmicoder/dsh-agent-teams': '多agent团队协作（AgentTeams，社区插件）',
  'dsh-status-rotator': '回合状态轮播（"Deep diving…" 换成打字机动画彩虹渐变梗文案，JSON 可配）',
};

/** 本地文件插件归一化：`./router-bootstrap-v34.mjs?v=88` → `router-bootstrap`
 * （去缓存戳 / 路径前缀 / 扩展名 / 版本别名；对 sync-preset --bump 免疫）。 */
function normalizePluginId(moduleName) {
  let n = String(moduleName || '').replace(/\?v=\d+$/, '');
  n = n.startsWith('./') ? n.slice(2) : n;
  n = n.replace(/\.mjs$/, '');
  return n.replace(/-v\d+$/, '');
}

/** 展示名（本地预设插件）：插件 id + 中文语义后缀；无映射时保持 moduleName（UI 兜底）。 */
const DISPLAY_CN = {
  'router-bootstrap': 'router-bootstrap（渐进式工具解锁路由）',
  'gitbash-executor': 'gitbash-executor（Git Bash 执行器）',
};

/** 插件展示名（供插件管理 UI；悬停提示仍可看真实模块路径）。 */
function displayName(moduleName) {
  return DISPLAY_CN[normalizePluginId(moduleName)] ?? undefined;
}

/** 读取包 package.json 的 description（英文兜底；找不到返回空）。 */
function pkgDescription(moduleName) {
  if (moduleName === 'cordis:include' || moduleName.startsWith('cordis:')) return '';
  const bare = moduleName.startsWith('@')
    ? moduleName.split('/').slice(0, 2).join('/')
    : moduleName.split('/')[0];
  if (!bare) return '';
  const roots = [
    join(REPO_ROOT, 'profiles', 'dshome', 'node_modules'),
    join(REPO_ROOT, 'profiles', 'node_modules'),
    join(REPO_ROOT, 'node_modules'),
  ];
  for (const root of roots) {
    const pj = join(root, bare, 'package.json');
    if (existsSync(pj)) {
      try {
        const j = JSON.parse(readFileSync(pj, 'utf8'));
        if (typeof j.description === 'string' && j.description) return j.description;
      } catch { /* keep trying */ }
    }
  }
  return '';
}

/** 插件一句话说明：中文映射（含本地文件插件的归一化 id）→ 包英文 description → 空。 */
function describe(moduleName) {
  const cn = DESC_CN[moduleName] ?? DESC_CN[normalizePluginId(moduleName)];
  if (cn) return cn;
  return pkgDescription(moduleName);
}

// 核心 / 必备插件：这些是 DSHOME 本体或应用骨架，禁止停用（停用会破坏 DSHOME）。
const PROTECTED_MODULES = new Set([
  'dshome/core', 'dshome/shell', 'dshome-theme', 'dshome-palette', 'dshome/notify', 'dshome/plugin-manager',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-cordis-client-runner', '@deepseek-ai/dsh-host-apiproxy', '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-locale',
  'cordis:include',
]);

export function isProtected(moduleName) {
  return moduleName.startsWith('dshome') || moduleName.startsWith('cordis:include') || PROTECTED_MODULES.has(moduleName);
}

export function classify(m) {
  if (m.startsWith('dshome')) return '自制';
  if (m.startsWith('@deepseek-ai/') || m.startsWith('cordis:')) return '内置';
  if (m.startsWith('./')) return '自制'; // 本地预设文件插件（router-standard 等）
  return '下载';
}

export function profileDir() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return path.join(home, 'profiles', process.env.DSH_PROFILE || 'dshome');
}

/**
 * 行级最小修改：只动目标 `- id: X` 行的 disabled，绝不重建文件
 * （重建会丢失同条目的 config/注释——如 llm-deepseek 的 apiKeyEnv）。
 */
export async function writeToggle(id, enabled) {
  const file = path.join(profileDir(), 'cordis.patch.yml');
  const raw = await readFile(file, 'utf8').catch(() => '[]');
  // 载荷里的 entryId 形如 `include:dshome-core`；patch 行的 id 是 `dshome-core`。
  const coreId = String(id).replace(/^include:/, '');
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const out = [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = /^- id: (\S+)/.exec(line);
    if (idMatch && idMatch[1] === coreId) {
      found = true;
      const next = lines[i + 1] ?? '';
      if (enabled) {
        // 启用：跳过紧跟的 `  disabled: true` 行（若存在）
        if (/^\s+disabled:\s*true\b/.test(next)) i++;
        out.push(line);
      } else {
        // 停用：保留原行；若下一行已是 disabled 则不重复
        out.push(line);
        if (!/^\s+disabled:/.test(next)) out.push('  disabled: true');
      }
      continue;
    }
    out.push(line);
  }
  if (!found) {
    if (enabled) return { ok: true, message: '已启用（重启生效）' };
    const tail = raw.trim();
    const base = (tail === '[]' || tail === '') ? '' : raw.replace(/\s+$/, '') + nl;
    await writeFile(file, `${base}- id: ${coreId}${nl}  disabled: true`, 'utf8');
    return { ok: true, message: '已停用（重启生效）' };
  }
  await writeFile(file, out.join(nl) + nl, 'utf8');
  return { ok: true, message: enabled ? '已启用（重启生效）' : '已停用（重启生效）' };
}

/** Loader 树快照：entryId / moduleName / enabled / category / phase / protected。 */
export function snapshot(ctx) {
  const set = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' };
  const entries = [];
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    entries.push({
      entryId: entry.id,
      moduleName: entry.options.name,
      displayName: displayName(entry.options.name),
      description: describe(entry.options.name),
      enabled: !entry.disabled,
      category: classify(entry.options.name),
      phase: entry.fiber?.state === void 0 ? null : (set[entry.fiber.state] ?? null),
      protected: isProtected(entry.options.name),
    });
  }
  return entries;
}
