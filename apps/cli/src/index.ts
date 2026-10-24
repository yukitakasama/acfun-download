#!/usr/bin/env node
import { CORE_VERSION } from '@acfun/core';
import { helpText, parseArgs, resolveOptions, type CliOptions } from './args.js';
import { runParse } from './commands/parse.js';
import { CliLog } from './io.js';

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.version) {
    process.stdout.write(`acfun ${CORE_VERSION}\n`);
    return 0;
  }
  if (parsed.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) process.stderr.write(`错误: ${e}\n`);
    process.stderr.write('用 acfun --help 查看用法。\n');
    return 1;
  }

  const opts: CliOptions = resolveOptions(parsed.options);
  const log = new CliLog({ json: opts.json, verbose: opts.verbose });
  const command = parsed.command ?? (parsed.inputs.length > 0 ? 'dl' : undefined);

  switch (command) {
    case 'parse':
      return runParse(parsed.inputs, opts, log);
    case 'dl':
    case 'batch':
      log.error('下载命令尚未实现（M4/M5 里程碑）。先用 `acfun parse <url>` 验证解析层。');
      return 1;
    default:
      process.stdout.write(`${helpText()}\n`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`未捕获错误: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
