#!/usr/bin/env node
// scripts/read-session.mjs — 读 DSH 会话产物（**拼接式 zstd 帧容器**）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// DSH 的 `session*.jsonl.zstd` 是**多个独立 zstd 帧拼接**的容器（追加写入，
// 第一帧固定是 session header 行）。Node 的 zstd API **只能解第一帧**：
//   · `zlib.zstdDecompressSync(整文件)`     → 只得到开头那一帧；
//   · `zlib.createZstdDecompress()` 流式   → 抛 `ZSTD_error_prefix_unknown`。
//
// 后果极易误判：2026-09-11 实测一个 33 KB 的会话文件**只解出 156 字符**，
// 被当成「会话是空的」，进而误判「定时任务创建了会话却没执行」。**文件很大却只
// 读出极少内容 = 工具不适配的信号，不是内容缺失的证据。**
//
// 本脚本复刻官方 `@deepseek-ai/dsh-session-persistence-jsonl` 内部
// `scanZstdFrames` 的**结构性帧边界扫描**（不解压即可定位每帧边界），再逐帧解压拼接。
// 官方包**未导出**该函数，故在此复刻以保证本脚本不依赖其内部实现。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node scripts/read-session.mjs <会话目录或会话产物文件>       # 摘要（事件类型统计 + 末尾行）
//   node scripts/read-session.mjs <...> --grep <正则>            # 只打印命中行（最多 40 条）
//   node scripts/read-session.mjs <...> --tail <N>               # 打印最后 N 行
//
// 也可被其它脚本 import：
//   import { readSessionText, scanZstdFrames } from './read-session.mjs';
//
// ── 边界（诚实标注）────────────────────────────────────────────────────────
// · 只做「结构性扫描 + 解压」，**不解释事件语义**（那是 `dsh-session-*` 的活）。
// · 末尾有**未写完的帧**（torn frame）时，该帧会被跳过并在摘要里提示；
//   官方实现能恢复其前缀，本脚本不做（诊断场景够用）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Zstandard 帧魔数（小端读出为 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 定位拼接容器里每个**完整帧**的 [start, end)。不解压数据块，只按帧/块头长度前进。
 * @param {Buffer} buffer 会话产物的完整字节
 * @param {number} maxFrames 最多扫多少帧（元信息读取用）
 * @returns {{ frames: {start:number,end:number}[], tornStart?: number }}
 *   `tornStart` 存在 = 末尾有一个未写完的帧（其起始偏移）。
 * @throws 结构损坏（魔数/保留位/保留块类型非法）时抛错——**响亮失败，不静默跳过**。
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize; // RLE 块的负载只有 1 字节
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * 读一个会话产物 → 完整 JSONL 文本（逐帧解压后拼接）。
 * 不可解的帧不会中断整体读取，而是留下可见的占位标记。
 */
export function readSessionText(file) {
  const buffer = fs.readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts = [];
  for (const { start, end } of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch (error) {
      parts.push(`\n<<undecodable frame @${start}..${end}: ${error.message}>>\n`);
    }
  }
  if (tornStart !== undefined) parts.push(`\n<<torn frame at byte ${tornStart} skipped>>\n`);
  return parts.join('');
}

/** 目录 → 其中的会话产物文件（优先 `.jsonl.zstd`）。 */
function resolveArtifact(target) {
  if (!fs.existsSync(target)) throw new Error(`not found: ${target}`);
  if (fs.statSync(target).isFile()) return target;
  const entries = fs.readdirSync(target);
  const found = entries.find((n) => n.endsWith('.jsonl.zstd')) ?? entries.find((n) => n.endsWith('.jsonl'));
  if (!found) throw new Error(`no session artifact in: ${target}`);
  return path.join(target, found);
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (invokedDirectly) {
  const target = process.argv[2];
  if (!target || target === '--help' || target === '-h') {
    console.log('用法: node scripts/read-session.mjs <会话目录或会话产物文件> [--grep <正则>] [--tail <N>]');
    process.exit(target ? 0 : 1);
  }
  const grepAt = process.argv.indexOf('--grep');
  const tailAt = process.argv.indexOf('--tail');

  const file = resolveArtifact(target);
  const text = readSessionText(file);
  const lines = text.split('\n').filter(Boolean);
  console.log(`file: ${file}`);
  console.log(`bytes ${fs.statSync(file).size} -> text ${text.length} chars / ${lines.length} lines`);

  if (grepAt >= 0) {
    const re = new RegExp(process.argv[grepAt + 1], 'i');
    const hits = lines.filter((l) => re.test(l));
    console.log(`\n--grep ${process.argv[grepAt + 1]} -> ${hits.length} hit(s)`);
    hits.slice(0, 40).forEach((l) => console.log('  ' + l.slice(0, 400)));
  } else if (tailAt >= 0) {
    lines.slice(-Number(process.argv[tailAt + 1])).forEach((l) => console.log('  ' + l.slice(0, 400)));
  } else {
    const types = {};
    for (const l of lines) {
      const m = /"type":"([^"]+)"/.exec(l);
      if (m) types[m[1]] = (types[m[1]] || 0) + 1;
    }
    console.log('\nevent types:', JSON.stringify(types, null, 1));
    console.log('\nlast 5 lines:');
    lines.slice(-5).forEach((l) => console.log('  ' + l.slice(0, 300)));
  }
}
