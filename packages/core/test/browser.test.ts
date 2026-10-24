import { createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import {
  buildEgoScript,
  captureRound,
  type BrowserEvent,
  type BrowserFetchResult,
  type BrowserPage,
  type CaptureRecord,
} from '../src/index.js';

const MEDIA = `#EXTM3U
#EXTINF:4.0,
https://cdn.example.com/a/0.ts
#EXTINF:4.0,
https://cdn.example.com/a/1.ts
#EXT-X-ENDLIST
`;

const tmp = (): string => tmpDir();

interface FakePageOptions {
  /** 每次 goto 时页面会发出的 authPath URL（null 表示不发）。 */
  authPathFor?: (url: string) => string | null;
  manifestText?: string;
  title?: string;
  /** 页面发出的 API 请求头（Vite 世代）。 */
  apiHeaders?: Record<string, string>;
  fetchImpl?: (url: string) => BrowserFetchResult;
  /** goto 之后再塞一条残留事件（模拟「上一条剩下的事件」）。 */
  leftoverEvents?: BrowserEvent[][];
}

/** 假页面 driver：形状与 ego/Chrome 一致，用来回归「事件缓冲串页」这个坑。 */
function fakePage(opts: FakePageOptions = {}): BrowserPage & { gotoCount: number } {
  let buffer: BrowserEvent[] = [];
  const leftover = [...(opts.leftoverEvents ?? [])];
  const page = {
    gotoCount: 0,
    async cdp(): Promise<unknown> {
      return {};
    },
    async goto(url: string): Promise<unknown> {
      page.gotoCount += 1;
      const extra = leftover.shift();
      if (extra) buffer.push(...extra);
      const authUrl = opts.authPathFor?.(url) ?? null;
      if (authUrl) {
        buffer.push({ method: 'Network.requestWillBeSent', params: { request: { url: authUrl } } });
      }
      if (opts.apiHeaders) {
        buffer.push({ method: 'Network.requestWillBeSent', params: { request: { url: '/api/x', headers: opts.apiHeaders } } });
      }
      return undefined;
    },
    async events(): Promise<BrowserEvent[]> {
      const out = buffer;
      buffer = [];
      return out;
    },
    async fetch(url: string): Promise<BrowserFetchResult> {
      if (opts.fetchImpl) return opts.fetchImpl(url);
      return { ok: true, status: 200, body: opts.manifestText ?? MEDIA };
    },
    async evaluate(): Promise<unknown> {
      return opts.title ?? '日常穿搭分享 - 社区动态';
    },
  };
  return page;
}

const runRound = async (
  page: BrowserPage,
  items: Array<{ id: string; url: string; manifestFile: string }>,
  generation: 'nuxt' | 'vite' = 'nuxt',
): Promise<CaptureRecord[]> => {
  const resultFile = join(tmp(), 'result.json');
  await captureRound({ generation, items, resultFile, page, captureTimeoutMs: 300, fetchTimeoutMs: 500 });
  return JSON.parse(readFileSync(resultFile, 'utf8')) as CaptureRecord[];
};

describe('captureRound（Nuxt 世代）', () => {
  it('抓到 authPath 后取清单并落盘', async () => {
    const manifestFile = join(tmp(), 'm.m3u8');
    const page = fakePage({ authPathFor: () => 'https://acpcssr.x.work/api/m3u8/public/decode/authPath?path=a' });
    const [rec] = await runRound(page, [{ id: '2164411', url: 'https://d.work/community/2164411', manifestFile }]);
    expect(rec?.ok).toBe(true);
    expect(rec?.segCount).toBe(2);
    expect(rec?.manifestDur).toBe(8);
    expect(rec?.hasEndlist).toBe(true);
    expect(rec?.apiHost).toBe('https://acpcssr.x.work');
    expect(rec?.rawTitle).toBe('日常穿搭分享 - 社区动态');
    expect(readFileSync(manifestFile, 'utf8')).toContain('#EXTM3U');
  });

  it('抓不到 authPath → AUTH_PATH_NOT_CAPTURED（安全边界，不产出文件）', async () => {
    const manifestFile = join(tmp(), 'm.m3u8');
    const page = fakePage({ authPathFor: () => null });
    const [rec] = await runRound(page, [{ id: '1', url: 'https://d.work/community/1', manifestFile }]);
    expect(rec?.ok).toBe(false);
    expect(rec?.errorCode).toBe('AUTH_PATH_NOT_CAPTURED');
    expect(() => readFileSync(manifestFile, 'utf8')).toThrow();
  });

  it('返回非 HLS → NOT_HLS', async () => {
    const page = fakePage({
      authPathFor: () => 'https://acpcssr.x.work/api/m3u8/public/decode/authPath?path=a',
      fetchImpl: () => ({ ok: true, status: 200, body: '<html>请先登录</html>' }),
    });
    const [rec] = await runRound(page, [{ id: '1', url: 'https://d.work/community/1', manifestFile: join(tmp(), 'm.m3u8') }]);
    expect(rec?.errorCode).toBe('NOT_HLS');
  });

  it('多码率时选 bandwidth 最高的子清单', async () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000
high.m3u8
`;
    const page = fakePage({
      authPathFor: () => 'https://acpcssr.x.work/api/m3u8/public/decode/authPath?path=a',
      fetchImpl: (url) => {
        if (url.includes('high.m3u8')) return { ok: true, status: 200, body: MEDIA };
        if (url.includes('low.m3u8')) return { ok: true, status: 200, body: MEDIA.replace('4.0', '2.0') };
        return { ok: true, status: 200, body: master };
      },
    });
    const [rec] = await runRound(page, [{ id: '1', url: 'https://d.work/play/1', manifestFile: join(tmp(), 'm.m3u8') }]);
    expect(rec?.ok).toBe(true);
    expect(rec?.variantBandwidth).toBe(2_400_000);
    expect(rec?.manifestDur).toBe(8);
  });

  it('回归：上一条剩余的网络事件不能被下一条当成证据（串页防护）', async () => {
    // 第 1 条：页面发出 authPath，捕获后 break，缓冲里还剩一条（模拟同一页面发多次 authPath）
    // 第 2 条：页面根本不发 authPath，若不清缓冲就会被上一条的残留"救活"，变成假成功
    const page = fakePage({
      authPathFor: (url) =>
        url.includes('/community/111')
          ? 'https://acpcssr.x.work/api/m3u8/public/decode/authPath?path=a'
          : null,
      leftoverEvents: [
        [
          {
            method: 'Network.requestWillBeSent',
            params: { request: { url: 'https://acpcssr.x.work/api/m3u8/public/decode/authPath?path=leftover' } },
          },
        ],
      ],
    });
    const recs = await runRound(page, [
      { id: '111', url: 'https://d.work/community/111', manifestFile: join(tmp(), 'a.m3u8') },
      { id: '999', url: 'https://d.work/community/999', manifestFile: join(tmp(), 'b.m3u8') },
    ]);
    expect(recs[0]?.ok).toBe(true);
    expect(recs[1]?.ok).toBe(false);
    expect(recs[1]?.errorCode).toBe('AUTH_PATH_NOT_CAPTURED');
  });
});

describe('captureRound（Vite 世代）', () => {
  const aut = 'xxTHIS_IS_A_TEST_JWT_VALUE';
  const encrypt = (plain: string): string => {
    const key = Buffer.from(aut.slice(2, 18), 'utf8');
    const cipher = createCipheriv('aes-128-cbc', key, key);
    return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
  };
  const detail = (obj: Record<string, unknown>): BrowserFetchResult => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ code: 200, msg: 'success', encData: encrypt(JSON.stringify(obj)) }),
  });
  const apiHeaders = { aut, sid: 'sid123', deviceId: 'h5_x', device: 'PC', appVersion: '1.9.6' };

  it('抓 aut 头 → 详情解密 → canWatch=true → 取清单成功', async () => {
    const page = fakePage({
      apiHeaders,
      fetchImpl: (url) => {
        if (url.includes('getVideoById')) {
          return detail({
            title: '测试视频',
            duration: 626,
            canWatch: true,
            videoUrl: 'jpd/a/b.m3u8',
            authKey: '1759999999-aa-1-bb',
            cdnList: [{ id: 7 }],
          });
        }
        return { ok: true, status: 200, body: MEDIA };
      },
    });
    const [rec] = await runRound(page, [{ id: '267427', url: 'https://d.work/play/267427', manifestFile: join(tmp(), 'm.m3u8') }], 'vite');
    expect(rec?.ok).toBe(true);
    expect(rec?.canWatch).toBe(true);
    expect(rec?.detailTitle).toBe('测试视频');
    expect(rec?.detailDuration).toBe(626);
    expect(rec?.segCount).toBe(2);
  });

  it('canWatch=false 且只有 previewUrl → AUTH_REQUIRED / previewOnly', async () => {
    const page = fakePage({
      apiHeaders,
      fetchImpl: (url) =>
        url.includes('getVideoById')
          ? detail({ title: '预览', canWatch: false, previewUrl: 'https://x/preview.m3u8' })
          : { ok: true, status: 200, body: MEDIA },
    });
    const [rec] = await runRound(page, [{ id: '1', url: 'https://d.work/play/1', manifestFile: join(tmp(), 'm.m3u8') }], 'vite');
    expect(rec?.ok).toBe(false);
    expect(rec?.errorCode).toBe('AUTH_REQUIRED');
    expect(rec?.previewOnly).toBe(true);
  });

  it('抓不到 aut 头 → AUT_NOT_CAPTURED（世代可能判错）', async () => {
    const page = fakePage({});
    const [rec] = await runRound(page, [{ id: '1', url: 'https://d.work/play/1', manifestFile: join(tmp(), 'm.m3u8') }], 'vite');
    expect(rec?.errorCode).toBe('AUT_NOT_CAPTURED');
  });
});

describe('buildEgoScript（ego 注入源码）', () => {
  it('产物是自包含、可求值的脚本（含 captureRound 与任务空间收尾）', () => {
    const script = buildEgoScript({
      generation: 'nuxt',
      items: [{ id: '1', url: 'https://d.work/play/1', manifestFile: 'C:/tmp/m.m3u8' }],
      resultFile: 'C:/tmp/result.json',
      spaceName: 'acfun-test',
    });
    expect(script).toContain('captureRound');
    expect(script).toContain('taskSpace');
    expect(script).toContain('task.finish({ keep: [] })');
    // 能当作 async 函数体解析（顶层 await 需要 AsyncFunction 构造器）
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (src: string) => unknown;
    expect(() => new AsyncFunction(script)).not.toThrow();
  });

  it('参数以字面量注入（ego 不继承 argv/环境变量）', () => {
    const script = buildEgoScript({
      generation: 'vite',
      items: [{ id: '267427', url: 'https://d.work/play/267427', manifestFile: 'C:/tmp/m.m3u8' }],
      resultFile: 'C:/tmp/result.json',
      spaceName: 'acfun-test-2',
    });
    expect(script).toContain('"generation": "vite"');
    expect(script).toContain('https://d.work/play/267427');
    expect(script).not.toContain('"spaceName"'); // spaceName 单独拼，不重复塞进 opts
  });
});
