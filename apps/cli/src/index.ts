#!/usr/bin/env node
import { CORE_VERSION } from '@acfun/core';
import { helpText, parseArgs, resolveOptions, type CliOptions } from './args.js';
import { runDownload } from './commands/dl.js';
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

  // Ctrl+C：第一次中断并保留 .part（exit 130），第二次强制退出。
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = (): void => {
    if (interrupted) {
      process.stderr.write('\n再次中断：强制退出\n');
      process.exit(130);
    }
    interrupted = true;
    process.stderr.write('\n收到中断信号：正在停止（已下载部分保留为 .part，可用 --resume 继续）…\n');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGBREAK', onSignal);

  switch (command) {
    case 'parse':
      return runParse(parsed.inputs, opts, log);
    case 'dl':
    case 'batch':
      return runDownload(parsed.inputs, opts, log, controller.signal);
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
