#!/usr/bin/env node
/**
 * fix-ps-encoding.mjs —— 给 Windows 脚本补齐 UTF-8 BOM 与 CRLF。
 *
 * 为什么必须有这个脚本：
 *   Windows PowerShell 5.1（即 powershell.exe，非 pwsh）**只在文件带 BOM 时才按 UTF-8 解码**。
 *   若 .ps1 是「UTF-8 无 BOM」，PS 5.1 会按系统 ANSI 代码页（中文系统为 GBK/936）解码，
 *   于是文件里所有中文注释与中文字符串全部乱码，且 GBK 字节序列会吞掉紧随的字符，
 *   导致词法分析器 token 流错位，报出与真实位置无关的假错误，例如：
 *       line 125  表达式或语句中包含意外的标记"}"。
 *       line 196  字符串缺少终止符: '。
 *   这类报错极具误导性——问题不在第 125/196 行，而在「整个文件被错误解码」。
 *   修复方式不是改代码，而是让文件带上 BOM。
 *
 * 同理 .bat 也应为 ANSI/GBK 或带 chcp 65001；本脚本统一给 .bat 补 BOM 并转 CRLF，
 * 配合脚本内的 `chcp 65001` 可正确显示中文。
 *
 * 用法：node scripts/fix-ps-encoding.mjs [--check]
 *   --check  只检查不写入，若发现缺 BOM 或缺 CRLF 则以退出码 1 失败（供 CI / check 链使用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const BOM = '\uFEFF';

/** 需要强制 BOM + CRLF 的文件（Windows 脚本）。位置参数可临时传入其他文件。 */
const DEFAULT_TARGETS = [
  'assets-templates/启动.ps1',
  'assets-templates/启动.bat',
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const explicit = args.filter((a) => !a.startsWith('--'));
// 显式传入的路径按原样使用；未传则走默认的 ROOT 相对路径。
const TARGETS = explicit.length ? explicit.map((p) => path.resolve(p)) : DEFAULT_TARGETS;
const problems = [];
const fixed = [];

for (const abs of TARGETS) {
  const display = path.relative(ROOT, abs) || abs;
  let raw;
  try {
    raw = readFileSync(abs);
  } catch {
    console.log(`[skip] ${display} 不存在`);
    continue;
  }

  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  // 解码（若已有 BOM 先剥掉，避免重复）
  let text = raw.toString('utf8');
  if (hasBom) text = text.slice(1);

  const hasCrlf = /\r\n/.test(text);
  const hasBareLf = /\n/.test(text.replace(/\r\n/g, ''));

  const needBom = !hasBom;
  const needCrlf = !hasCrlf || hasBareLf;

  if (!needBom && !needCrlf) {
    console.log(`[ok]   ${display}`);
    continue;
  }

  if (checkOnly) {
    problems.push(`${display}: ${needBom ? '缺少 UTF-8 BOM' : ''}${needBom && needCrlf ? ' + ' : ''}${needCrlf ? '换行符非 CRLF' : ''}`);
    console.log(`[FAIL] ${display}: 缺少 UTF-8 BOM=${needBom}, 需转 CRLF=${needCrlf}`);
    continue;
  }

  // 归一化换行：先统一成 \n 再全部转 \r\n
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  writeFileSync(abs, BOM + text, 'utf8');
  fixed.push(display);
  console.log(`[fix]  ${display}: 已补 BOM${needCrlf ? ' 并转 CRLF' : ''}`);
}

if (checkOnly) {
  if (problems.length) {
    console.error(`\n发现 ${problems.length} 个 Windows 脚本编码问题：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\n运行  node scripts/fix-ps-encoding.mjs  自动修复。');
    process.exit(1);
  }
  console.log('\n所有 Windows 脚本编码正常（UTF-8 BOM + CRLF）。');
} else if (fixed.length) {
  console.log(`\n已修复 ${fixed.length} 个文件。`);
} else {
  console.log('\n无需修改。');
}
