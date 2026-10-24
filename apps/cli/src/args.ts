/**
 * CLI 参数解析（PLAN §5）。
 *
 * 手写而不引第三方：参数表就是 help 文本的唯一来源，避免 help 与实现漂移。
 */
import type { ContainerFormat, NameMode, OnExist } from '@acfun/core';

export interface CliOptions {
  outDir: string;
  nameMode: NameMode;
  name?: string;
  template?: string;
  onExist: OnExist;
  container: ContainerFormat;
  meta: boolean;
  cover: boolean;
  danmaku: boolean;
  subtitle: boolean;
  concurrency: number;
  retries: number;
  timeoutSec: number;
  intervalMs: number;
  proxy?: string;
  cookie?: string;
  resume: boolean;
  report: 'json' | 'csv';
  json: boolean;
  verbose: boolean;
  file?: string;
  origin?: string;
  config?: string;
  ffmpeg?: string;
  ffprobe?: string;
}

export interface OptionSpec {
  key: keyof CliOptions;
  flags: readonly string[];
  kind: 'string' | 'number' | 'boolean';
  metavar?: string;
  desc: string;
  values?: readonly string[];
  default?: string | number | boolean;
  /** 支持 `--no-xxx` 取反。 */
  negatable?: boolean;
}

export const OPTION_SPECS: readonly OptionSpec[] = [
  { key: 'file', flags: ['-f', '--file'], kind: 'string', metavar: '<path>', desc: '文本清单（按行读取，忽略空行 / # / //）' },
  { key: 'outDir', flags: ['-o', '--out-dir'], kind: 'string', metavar: '<dir>', desc: '输出目录', default: './downloads' },
  {
    key: 'nameMode',
    flags: ['--name-mode'],
    kind: 'string',
    metavar: 'title|custom',
    desc: '命名模式',
    values: ['title', 'custom'],
    default: 'title',
  },
  { key: 'name', flags: ['--name'], kind: 'string', metavar: '<fixed-name>', desc: 'custom 模式的固定名' },
  {
    key: 'template',
    flags: ['--template'],
    kind: 'string',
    metavar: '<tpl>',
    desc: 'custom 模式模板，如 "{title} [{author}] {date} {id}"',
  },
  {
    key: 'onExist',
    flags: ['--on-exist'],
    kind: 'string',
    metavar: 'rename|skip|overwrite',
    desc: '重名处理',
    values: ['rename', 'skip', 'overwrite'],
    default: 'rename',
  },
  {
    key: 'container',
    flags: ['--container'],
    kind: 'string',
    metavar: 'mp4|mkv|ts',
    desc: '容器格式（-c copy 转封装，不重编码）',
    values: ['mp4', 'mkv', 'ts'],
    default: 'mp4',
  },
  { key: 'meta', flags: ['--meta'], kind: 'boolean', desc: '写 .meta.json 元数据 sidecar', default: true, negatable: true },
  { key: 'cover', flags: ['--cover'], kind: 'boolean', desc: '下载封面', default: true, negatable: true },
  { key: 'danmaku', flags: ['--danmaku'], kind: 'boolean', desc: '下载弹幕（实验性）', default: false },
  { key: 'subtitle', flags: ['--subtitle'], kind: 'boolean', desc: '下载字幕（站点有时才下）', default: false },
  {
    key: 'concurrency',
    flags: ['--concurrency'],
    kind: 'number',
    metavar: '<n>',
    desc: '并发度，仅并行 ffmpeg 阶段（浏览器取清单恒串行）',
    default: 1,
  },
  { key: 'retries', flags: ['--retries'], kind: 'number', metavar: '<n>', desc: '整片重取清单轮数', default: 2 },
  { key: 'timeoutSec', flags: ['--timeout'], kind: 'number', metavar: '<sec>', desc: '请求/导航超时', default: 30 },
  { key: 'intervalMs', flags: ['--interval'], kind: 'number', metavar: '<ms>', desc: '任务间隔', default: 1500 },
  { key: 'proxy', flags: ['--proxy'], kind: 'string', metavar: '<url>', desc: '代理（默认关；ego 通道不支持时回落 Chrome）' },
  { key: 'cookie', flags: ['--cookie'], kind: 'string', metavar: '<file>', desc: '仅 Chrome 兜底通道；亦可用 ACFUN_COOKIE' },
  { key: 'resume', flags: ['--resume'], kind: 'boolean', desc: '复用未过期清单恢复未完成任务', default: false },
  {
    key: 'report',
    flags: ['--report'],
    kind: 'string',
    metavar: 'json|csv',
    desc: '汇总报告格式',
    values: ['json', 'csv'],
    default: 'json',
  },
  { key: 'json', flags: ['--json'], kind: 'boolean', desc: '进度与结果以 NDJSON 输出到 stdout', default: false },
  { key: 'verbose', flags: ['-v', '--verbose'], kind: 'boolean', desc: '详细日志', default: false },
  { key: 'origin', flags: ['--origin'], kind: 'string', metavar: '<url>', desc: '纯 id 输入的基准域名' },
  { key: 'config', flags: ['--config'], kind: 'string', metavar: '<path>', desc: '配置文件路径' },
  { key: 'ffmpeg', flags: ['--ffmpeg'], kind: 'string', metavar: '<path>', desc: 'ffmpeg 可执行文件路径' },
  { key: 'ffprobe', flags: ['--ffprobe'], kind: 'string', metavar: '<path>', desc: 'ffprobe 可执行文件路径' },
];

export const COMMANDS = ['dl', 'parse', 'batch'] as const;
export type Command = (typeof COMMANDS)[number];

export interface ParsedArgs {
  command?: Command;
  inputs: string[];
  options: Partial<CliOptions>;
  /** 参数层面的错误（未知参数、枚举值非法、缺值…）。 */
  errors: string[];
  help: boolean;
  version: boolean;
}

function lookupFlag(flag: string): { spec: OptionSpec; negated: boolean } | null {
  for (const spec of OPTION_SPECS) {
    if (spec.flags.includes(flag)) return { spec, negated: false };
    if (spec.negatable && flag.startsWith('--no-') && spec.flags.includes(`--${flag.slice(5)}`)) {
      return { spec, negated: true };
    }
  }
  return null;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const inputs: string[] = [];
  const options: Record<string, unknown> = {};
  const errors: string[] = [];
  let command: Command | undefined;
  let help = false;
  let version = false;
  let sawTerminator = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (sawTerminator) {
      inputs.push(arg);
      continue;
    }
    if (arg === '--') {
      sawTerminator = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-V' || arg === '--version') {
      version = true;
      continue;
    }
    // 单横线是 stdin 输入标记，不是 flag。
    if (arg === '-') {
      inputs.push(arg);
      continue;
    }

    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length === 2)) {
      const eq = arg.indexOf('=');
      const flag = eq >= 0 ? arg.slice(0, eq) : arg;
      const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
      const found = lookupFlag(flag);
      if (!found) {
        errors.push(`未知参数: ${flag}`);
        continue;
      }
      const { spec, negated } = found;
      if (spec.kind === 'boolean') {
        options[spec.key] = negated ? false : inlineValue === undefined ? true : inlineValue !== 'false';
        continue;
      }
      if (negated) {
        errors.push(`参数 ${flag} 不支持取反`);
        continue;
      }
      const value = inlineValue ?? argv[++i];
      if (value === undefined || (value.startsWith('-') && value !== '-' && !/^-\d/.test(value))) {
        errors.push(`参数 ${flag} 需要一个值`);
        continue;
      }
      if (spec.kind === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          errors.push(`参数 ${flag} 需要非负数字，收到「${value}」`);
          continue;
        }
        options[spec.key] = n;
      } else {
        if (spec.values && !spec.values.includes(value)) {
          errors.push(`参数 ${flag} 只接受 ${spec.values.join('|')}，收到「${value}」`);
          continue;
        }
        options[spec.key] = value;
      }
      continue;
    }

    if (!command && (COMMANDS as readonly string[]).includes(arg)) {
      command = arg as Command;
      continue;
    }
    if (!command && (arg === 'help')) {
      help = true;
      continue;
    }
    inputs.push(arg);
  }

  return { command, inputs, options: options as Partial<CliOptions>, errors, help, version };
}

/** 把 spec 的默认值 + 用户值合并成完整选项。 */
export function resolveOptions(partial: Partial<CliOptions>, env: NodeJS.ProcessEnv = process.env): CliOptions {
  const out: Record<string, unknown> = {};
  for (const spec of OPTION_SPECS) {
    if (spec.default !== undefined) out[spec.key as string] = spec.default;
  }
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) out[k] = v;
  }
  if (!out.ffmpeg) out.ffmpeg = env.FFMPEG_PATH || 'ffmpeg';
  if (!out.ffprobe) out.ffprobe = env.FFPROBE_PATH || 'ffprobe';
  if (out.cookie === undefined && env.ACFUN_COOKIE && env.ACFUN_COOKIE.trim()) out.cookie = env.ACFUN_COOKIE;
  return out as unknown as CliOptions;
}

export function helpText(): string {
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));
  const lines: string[] = [];
  lines.push('用法: acfun <command> [inputs...] [options]');
  lines.push('');
  lines.push('命令');
  lines.push('  dl      <input...>   下载（支持 URL / 分享文本 / 多个）');
  lines.push('  parse   <input...>   只解析，输出 JSON（不下载）——自测与调试用');
  lines.push('  batch   -f <file>    批量（等价 dl -f，语义更明确）');
  lines.push('');
  lines.push('输入');
  lines.push('  <url|分享文本|id>    位置参数，可多个');
  lines.push('  -                    从 stdin 读取');
  lines.push('');
  lines.push('选项');
  for (const spec of OPTION_SPECS) {
    const flagText = spec.flags.join(', ') + (spec.kind === 'boolean' ? '' : ` ${spec.metavar ?? ''}`).trimEnd();
    lines.push(`  ${pad(flagText, 34)}${spec.desc}${spec.default !== undefined ? `（默认 ${String(spec.default)}）` : ''}`);
  }
  lines.push('');
  lines.push('注意: --concurrency > 1 只并行 ffmpeg 下载/核验阶段；浏览器取清单阶段恒为串行');
  lines.push('      （ego lite 是单实例 + 用户真实 profile，并行会互抢且更易触发风控）。');
  lines.push('');
  lines.push('退出码: 0 全部成功 | 1 参数/环境错误 | 3 部分或全部失败 | 130 用户中断');
  return lines.join('\n');
}
