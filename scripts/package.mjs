#!/usr/bin/env node
/**
 * package.mjs — 打一个可以直接拖进 chrome://extensions 的 zip
 *
 * 跑法：npm run package
 * 产物：dist/anti-geo-v<version>.zip
 *
 * 只打运行时需要的东西，dev 文件（测试、工具、文档、CI）不收进去。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const OUT_DIR = path.join(ROOT, 'dist');
const ZIP = path.join(OUT_DIR, `anti-geo-v${mf.version}.zip`);

// 只收这些
const INCLUDE = ['manifest.json', 'src', 'assets', '_locales', 'LICENSE', 'README.md', 'PRIVACY.md'];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(ZIP, { force: true });

const missing = INCLUDE.filter((p) => !fs.existsSync(path.join(ROOT, p)));
if (missing.length) {
  console.error('缺少文件:', missing.join(', '));
  process.exit(1);
}

// 用系统 zip（macOS/Linux 都有），-x 排除开发残留
try {
  execFileSync(
    'zip',
    [
      '-r', '-q', ZIP,
      ...INCLUDE,
      '-x', '*/node_modules/*',
      '-x', '*/.DS_Store',
      '-x', '*/snapshots/*',
      '-x', 'src/**/*.map',
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
} catch (e) {
  console.error('打包失败：', e.message);
  console.error('需要系统有 zip 命令');
  process.exit(1);
}

const size = (fs.statSync(ZIP).size / 1024).toFixed(1);
const count = execFileSync('unzip', ['-l', ZIP], { encoding: 'utf8' })
  .split('\n')
  .filter((l) => /\.(js|json|html|css|png|md)$/.test(l)).length;

console.log(`\n✓ ${path.relative(ROOT, ZIP)}`);
console.log(`  ${size} KB · ${count} 个文件 · v${mf.version}`);
console.log(`\n安装：chrome://extensions → 开发者模式 → 加载已解压 → 选解压后的目录`);
console.log(`或直接把 .zip 拖进 chrome://extensions`);
