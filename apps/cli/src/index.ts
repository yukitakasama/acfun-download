#!/usr/bin/env node
import { CORE_VERSION } from '@acfun/core';

// M0 骨架：只有 --version/--help 的最小编译产物，后续里程碑填充真实命令。
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-V')) {
  console.log(`acfun ${CORE_VERSION}`);
  process.exit(0);
}
console.error('acfun: 尚未实现任何命令（M0 骨架）。用 --help 查看计划中的用法。');
process.exit(1);
