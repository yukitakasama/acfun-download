import { describe, expect, it } from 'vitest';
import {
  dedupeKey,
  extractFromText,
  extractUrls,
  fileLines,
  itemsFromText,
  normalizeInputs,
  trimUrlTail,
  type FetchLike,
} from '../src/index.js';

const mask = 'https://dlc1.8dbtby03.work';

describe('extractUrls', () => {
  it('从纯 URL 里抽出自身', () => {
    expect(extractUrls(`${mask}/play/267427`)).toEqual([`${mask}/play/267427`]);
  });

  it('从分享文本里抽出 URL，且不吃掉中文/表情/全角标点', () => {
    const text = `【日常穿搭分享】快来看这个视频 ${mask}/community/2164411 🎉 真的好棒！！`;
    expect(extractUrls(text)).toEqual([`${mask}/community/2164411`]);
  });

  it('剥掉 URL 尾部的中英文标点', () => {
    expect(extractUrls(`看这里 ${mask}/play/267427。`)).toEqual([`${mask}/play/267427`]);
    expect(extractUrls(`(${mask}/play/267427)`)).toEqual([`${mask}/play/267427`]);
    expect(extractUrls(`<${mask}/splay/123>,`)).toEqual([`${mask}/splay/123`]);
    expect(extractUrls(`"${mask}/videos/play/270411"`)).toEqual([`${mask}/videos/play/270411`]);
  });

  it('保留 URL 里的 query 与合法字符', () => {
    const url = `${mask}/play/267427?from=share&_t=169`; // 含 & 和 =
    expect(extractUrls(`text ${url} end`)).toEqual([url]);
  });

  it('一个文本里多个 URL 全抽出', () => {
    const text = `${mask}/play/1 和 ${mask}/play/2 都可以`;
    expect(extractUrls(text)).toEqual([`${mask}/play/1`, `${mask}/play/2`]);
  });

  it('丢弃非 http(s) 与无点主机名（localhost 例外，供本地调试）', () => {
    expect(extractUrls('ftp://x.com/a http://localhost:8080/x http://foo/bar')).toEqual(['http://localhost:8080/x']);
  });

  it('trimUrlTail 只剥尾部标点', () => {
    expect(trimUrlTail('https://a.com/p?x=1，')).toBe('https://a.com/p?x=1');
    expect(trimUrlTail('https://a.com/p(1)')).toBe('https://a.com/p(1)');
  });
});

describe('extractFromText', () => {
  it('整行就是一个 URL 时标记 wholeLine', () => {
    const [one] = extractFromText(`${mask}/play/267427`);
    expect(one?.wholeLine).toBe(true);
    const [two] = extractFromText(`来看 ${mask}/play/267427 吧`);
    expect(two?.wholeLine).toBe(false);
  });
});

describe('normalizeInputs', () => {
  it('多参数全部保留', async () => {
    const items = await normalizeInputs([`${mask}/play/1`, `${mask}/splay/2`], { followShortLinks: false });
    expect(items.map((i) => i.url)).toEqual([`${mask}/play/1`, `${mask}/splay/2`]);
  });

  it('同一 origin+path 去重（query 不同也算同一条，保留首次）', async () => {
    const items = await normalizeInputs(
      [`${mask}/play/267427?from=a`, `${mask}/play/267427?from=b`, `${mask}/play/267427`],
      { followShortLinks: false },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe(`${mask}/play/267427?from=a`);
  });

  it('分享文本作为输入时也能抽出 URL', async () => {
    const items = await normalizeInputs([`分享给你 ${mask}/community/2164411 🎉`], { followShortLinks: false });
    expect(items.map((i) => i.url)).toEqual([`${mask}/community/2164411`]);
    expect(items[0]?.source).toBe('text');
  });

  it('纯数字 id 需要 --origin', async () => {
    await expect(normalizeInputs(['2164411'], { followShortLinks: false })).rejects.toMatchObject({
      kind: 'BAD_INPUT',
    });
    const items = await normalizeInputs(['2164411'], { origin: mask, followShortLinks: false });
    expect(items[0]?.url).toBe(`${mask}/community/2164411`);
  });

  it('短链 302 跟到目标页', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(input);
      if (input === 'https://t.cn/abc') {
        return new Response('', { status: 302, headers: { location: `${mask}/play/267427?from=short` } });
      }
      return new Response('nope', { status: 404 });
    };
    const items = await normalizeInputs(['https://t.cn/abc'], { fetchImpl });
    expect(items[0]?.url).toBe(`${mask}/play/267427?from=short`);
    expect(calls).toEqual(['https://t.cn/abc']);
  });

  it('短链最多跟 3 跳，且失败不致命', async () => {
    let hits = 0;
    const fetchImpl: FetchLike = async () => {
      hits++;
      return new Response('', { status: 302, headers: { location: `https://s.hop/${hits}` } });
    };
    const items = await normalizeInputs(['https://t.cn/loop'], { fetchImpl });
    expect(hits).toBe(3);
    expect(items[0]?.url).toBe('https://s.hop/3');
  });

  it('目标页不会再发短链请求', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response('', { status: 200 });
    };
    await normalizeInputs([`${mask}/play/267427`], { fetchImpl });
    expect(called).toBe(false);
  });

  it('非法串被忽略，不产生条目', async () => {
    const items = await normalizeInputs(['这不是链接', '', '   '], { followShortLinks: false });
    expect(items).toEqual([]);
  });
});

describe('文件/stdin 输入', () => {
  it('忽略空行与 # // 注释', async () => {
    const content = [`# 注释`, `// 也是注释`, '', `${mask}/play/1`, `  ${mask}/play/2  `].join('\n');
    expect(fileLines(content)).toEqual([`${mask}/play/1`, `${mask}/play/2`]);
    const items = await itemsFromText(content, 'file', { followShortLinks: false });
    expect(items.map((i) => i.line)).toEqual([4, 5]);
    expect(items.every((i) => i.source === 'file')).toBe(true);
  });

  it('行内分享文本也会被提取', async () => {
    const items = await itemsFromText(`1. 复制这条 ${mask}/splay/123 打开`, 'file', { followShortLinks: false });
    expect(items[0]?.url).toBe(`${mask}/splay/123`);
  });
});

describe('dedupeKey', () => {
  it('忽略 query 与末尾斜杠', () => {
    expect(dedupeKey(`${mask}/play/1/?a=1`)).toBe(dedupeKey(`${mask}/play/1`));
    expect(dedupeKey(`${mask}/play/1`)).not.toBe(dedupeKey(`${mask}/play/2`));
  });
});
