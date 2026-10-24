import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanPageTitle,
  detectGenerationFromHtml,
  detectSite,
  looksLikeErrorTitle,
  looksLikeTargetUrl,
  pageUrlFromId,
  parsePageUrl,
  type FetchLike,
} from '../src/index.js';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const mask = 'https://dlc1.8dbtby03.work';

describe('parsePageUrl', () => {
  const cases: ReadonlyArray<[string, string, string, string]> = [
    [`${mask}/play/267427`, 'video', '267427', 'unknown'],
    [`${mask}/videos/play/270411`, 'video', '270411', 'unknown'],
    [`${mask}/splay/123`, 'video', '123', 'unknown'],
    [`${mask}/community/2164411`, 'post', '2164411', 'unknown'],
    [`${mask}/play/267427/`, 'video', '267427', 'unknown'],
    [`https://www.acfun.cn/v/ac123`, 'video', '123', 'official'],
    [`https://www.acfun.cn/t/ac456`, 'article', '456', 'official'],
  ];

  it.each(cases)('%s → kind=%s pageId=%s generation=%s', (url, kind, pageId, generation) => {
    const t = parsePageUrl(url);
    expect(t).not.toBeNull();
    expect(t?.kind).toBe(kind);
    expect(t?.pageId).toBe(pageId);
    expect(t?.generation).toBe(generation);
    expect(t?.origin).toBe(new URL(url).origin);
  });

  it('带 query 也能解析（id 只看 path）', () => {
    const t = parsePageUrl(`${mask}/play/267427?from=share&_t=1`);
    expect(t?.pageId).toBe('267427');
    expect(t?.kind).toBe('video');
  });

  it('带 hash 也能解析', () => {
    expect(parsePageUrl(`${mask}/community/2164411#c1`)?.pageId).toBe('2164411');
  });

  it('非目标路径返回 null', () => {
    for (const bad of [`${mask}/`, `${mask}/user/1`, `${mask}/play/`, `not-a-url`, 'ftp://x.com/play/1', '']) {
      expect(parsePageUrl(bad)).toBeNull();
    }
  });

  it('looksLikeTargetUrl 只认页面形态', () => {
    expect(looksLikeTargetUrl(`${mask}/community/2164411`)).toBe(true);
    expect(looksLikeTargetUrl('https://t.cn/abcd')).toBe(false);
  });
});

describe('pageUrlFromId', () => {
  it('post → /community/<id>，video → /play/<id>，并去掉尾部斜杠', () => {
    expect(pageUrlFromId(`${mask}/`, '2164411', 'post')).toBe(`${mask}/community/2164411`);
    expect(pageUrlFromId(mask, '267427', 'video')).toBe(`${mask}/play/267427`);
  });

  it('非数字 id 报 BAD_INPUT', () => {
    expect(() => pageUrlFromId(mask, 'abc')).toThrowError(/纯数字/);
  });
});

describe('detectGenerationFromHtml', () => {
  it('Vite 世代：/assets/index- 命中', () => {
    const r = detectGenerationFromHtml(fixture('vite.html'));
    expect(r.generation).toBe('vite');
    expect(r.evidence).toContain('/assets/index-');
  });

  it('Nuxt 3 世代：/_nuxt/ + acpcssr.*.work 命中', () => {
    const r = detectGenerationFromHtml(fixture('nuxt.html'));
    expect(r.generation).toBe('nuxt');
    expect(r.evidence).toEqual(expect.arrayContaining(['/_nuxt/', 'acpcssr.*.work']));
  });

  it('特征全无 → unknown', () => {
    const r = detectGenerationFromHtml(fixture('plain.html'));
    expect(r.generation).toBe('unknown');
    expect(r.evidence).toEqual([]);
  });

  it('只命中跨域 API 主机也算 Nuxt 世代', () => {
    const r = detectGenerationFromHtml('<script src="https://acpcssr.abc123.work/x.js"></script>');
    expect(r.generation).toBe('nuxt');
  });
});

describe('detectSite', () => {
  const htmlOf = (name: string): FetchLike => async () =>
    new Response(fixture(name), { status: 200, headers: { 'content-type': 'text/html' } });

  it('抓 HTML 判出 Nuxt 世代', async () => {
    const r = await detectSite(`${mask}/community/2164411`, { fetchImpl: htmlOf('nuxt.html') });
    expect(r.target.generation).toBe('nuxt');
    expect(r.target.pageId).toBe('2164411');
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it('抓 HTML 判出 Vite 世代', async () => {
    const r = await detectSite(`${mask}/play/267427`, { fetchImpl: htmlOf('vite.html') });
    expect(r.target.generation).toBe('vite');
  });

  it('官方站不查 HTML，直接 official', async () => {
    let called = false;
    const r = await detectSite('https://www.acfun.cn/v/ac123', {
      fetchImpl: async () => {
        called = true;
        return new Response('', { status: 200 });
      },
    });
    expect(r.target.generation).toBe('official');
    expect(called).toBe(false);
  });

  it('HTML 无特征 → SITE_UNKNOWN（带建议）', async () => {
    await expect(detectSite(`${mask}/play/1`, { fetchImpl: htmlOf('plain.html') })).rejects.toMatchObject({
      kind: 'SITE_UNKNOWN',
    });
  });

  it('HTTP 404 / 403 分别归类', async () => {
    await expect(
      detectSite(`${mask}/play/1`, { fetchImpl: async () => new Response('x', { status: 404 }) }),
    ).rejects.toMatchObject({ kind: 'HTTP_404' });
    await expect(
      detectSite(`${mask}/play/1`, { fetchImpl: async () => new Response('x', { status: 403 }) }),
    ).rejects.toMatchObject({ kind: 'HTTP_403' });
  });

  it('网络异常 → PARSE_FAILED', async () => {
    await expect(
      detectSite(`${mask}/play/1`, {
        fetchImpl: async () => {
          throw new Error('net::ERR_CONNECTION_RESET');
        },
      }),
    ).rejects.toMatchObject({ kind: 'PARSE_FAILED' });
  });

  it('无法识别的链接 → SITE_UNKNOWN', async () => {
    await expect(detectSite('https://example.com/whatever')).rejects.toMatchObject({ kind: 'SITE_UNKNOWN' });
  });
});

describe('标题处理', () => {
  it('错误页标题被识别', () => {
    for (const t of ['502 Bad Gateway', '404 Not Found', '出错啦', '视频不存在', 'Internal Server Error']) {
      expect(looksLikeErrorTitle(t)).toBe(true);
    }
    for (const t of ['日常穿搭分享 4K 60fps', '2164411_社区', '小姐姐跳舞']) {
      expect(looksLikeErrorTitle(t)).toBe(false);
    }
  });

  it('剥离站点标题后缀', () => {
    expect(cleanPageTitle('日常穿搭分享 - 社区动态')).toBe('日常穿搭分享');
    expect(cleanPageTitle('测试视频 - 在线观看 - AcFan')).toBe('测试视频');
    expect(cleanPageTitle('无后缀标题')).toBe('无后缀标题');
  });
});
