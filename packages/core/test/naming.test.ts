import { describe, expect, it } from 'vitest';
import {
  avoidReservedName,
  buildBaseName,
  extForContainer,
  formatDate,
  MAX_TOTAL_LENGTH,
  padIndex,
  renderTemplate,
  resolveOutputPath,
  sanitizeFileName,
  sidecarPath,
} from '../src/index.js';

describe('sanitizeFileName：非法字符与控制字符', () => {
  it('Windows 非法字符全部换成 _', () => {
    expect(sanitizeFileName('a\\b/c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('控制字符换成 _', () => {
    expect(sanitizeFileName('a\u0000b\u0001c\u001fd\u007fe')).toBe('a_b_c_d_e');
  });

  it('连续空白压成单空格并去首尾空格', () => {
    expect(sanitizeFileName('  多个   空格  ')).toBe('多个 空格');
  });

  it('制表/换行属于控制字符，按清洗顺序先变成 _（而非空格）', () => {
    expect(sanitizeFileName('多个\t空格\n换行')).toBe('多个_空格_换行');
  });

  it('全是非法字符时回退到 fallback', () => {
    expect(sanitizeFileName('///', { fallback: 'acfun-267427' })).toBe('acfun-267427');
    expect(sanitizeFileName('   ', { fallback: 'acfun-1' })).toBe('acfun-1');
    expect(sanitizeFileName('', { fallback: 'acfun-1' })).toBe('acfun-1');
  });

  it('emoji 原样保留（不是非法字符）', () => {
    expect(sanitizeFileName('日常穿搭 🎉 分享')).toBe('日常穿搭 🎉 分享');
  });
});

describe('sanitizeFileName：结尾点与空格', () => {
  it('去掉结尾的点与空格', () => {
    expect(sanitizeFileName('标题...')).toBe('标题');
    expect(sanitizeFileName('标题 . . ')).toBe('标题');
    expect(sanitizeFileName('标题. ')).toBe('标题');
  });

  it('中间的点保留', () => {
    expect(sanitizeFileName('v1.2 版本')).toBe('v1.2 版本');
  });
});

describe('sanitizeFileName：长度（含扩展名 ≤ 200）', () => {
  const ext = '.mp4';

  it('恰好 200 全长的名字不动', () => {
    const stem = 'a'.repeat(MAX_TOTAL_LENGTH - ext.length); // 196
    const out = sanitizeFileName(stem, { ext });
    expect(out).toBe(stem);
    expect(out.length + ext.length).toBe(200);
  });

  it('201 全长被截断到 200', () => {
    const stem = 'a'.repeat(MAX_TOTAL_LENGTH - ext.length + 1); // 197
    const out = sanitizeFileName(stem, { ext });
    expect(out.length).toBe(196);
    expect(out.length + ext.length).toBe(200);
  });

  it('超长中文按码点截断，不切坏字符', () => {
    const stem = '中'.repeat(500);
    const out = sanitizeFileName(stem, { ext });
    expect(out.length).toBe(196);
    expect(out).toMatch(/^中+$/);
  });

  it('emoji 按码点截断，不留半个代理对', () => {
    const stem = '🎉'.repeat(300); // 每个 2 个 UTF-16 码元
    const out = sanitizeFileName(stem, { ext });
    expect(Array.from(out).length).toBe(196);
    expect(out).toBe('🎉'.repeat(196));
  });
});

describe('sanitizeFileName：Windows 保留名', () => {
  it('保留名加前缀 _', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('nul')).toBe('_nul');
    expect(sanitizeFileName('COM1')).toBe('_COM1');
    expect(sanitizeFileName('LPT9')).toBe('_LPT9');
  });

  it('带扩展名的保留名也识别', () => {
    expect(avoidReservedName('con.txt')).toBe('_con.txt');
  });

  it('普通名不受影响', () => {
    expect(sanitizeFileName('CONSOLE 日志')).toBe('CONSOLE 日志');
    expect(sanitizeFileName('COM10')).toBe('COM10');
  });
});

describe('模板渲染', () => {
  const vars = {
    title: '日常穿搭分享',
    author: 'UP主A',
    date: '2026-10-18T12:00:00+08:00',
    id: '2164411',
    index: 7,
  };

  it('5 个占位符全部可用', () => {
    expect(renderTemplate('{title} [{author}] {date} {id} {index}', vars)).toBe(
      '日常穿搭分享 [UP主A] 2026-10-18 2164411 007',
    );
  });

  it('{index} 三位补零，从 001 起', () => {
    expect(renderTemplate('{index}', { index: 1 })).toBe('001');
    expect(renderTemplate('{index}', { index: 12 })).toBe('012');
    expect(renderTemplate('{index}', { index: 1234 })).toBe('1234');
    expect(padIndex(5)).toBe('005');
  });

  it('缺字段时不留下空括号', () => {
    expect(renderTemplate('{title} [{author}]', { title: '视频名' })).toBe('视频名');
    expect(renderTemplate('{title}（{author}）', { title: '视频名' })).toBe('视频名');
    expect(renderTemplate('{title} 【{author}】', { title: '视频名' })).toBe('视频名');
    expect(renderTemplate('{title} [{author} - {date}]', { title: '视频名' })).toBe('视频名');
  });

  it('缺字段时也去干净两端的孤立分隔符', () => {
    expect(renderTemplate('{author} - {title}', { title: '视频名' })).toBe('视频名');
    expect(renderTemplate('{title} - {author}', { title: '视频名' })).toBe('视频名');
  });

  it('未知占位符原样保留', () => {
    expect(renderTemplate('{title} {foo}', { title: '视频名' })).toBe('视频名 {foo}');
  });

  it('全部字段都缺时渲染成空串', () => {
    expect(renderTemplate('[{author}]', {})).toBe('');
  });
});

describe('日期格式', () => {
  it('ISO 字符串 → YYYY-MM-DD', () => {
    expect(formatDate('2026-10-18T12:00:00+08:00')).toBe('2026-10-18');
    expect(formatDate('2026-10-18 12:00:00')).toBe('2026-10-18');
    expect(formatDate('2026-10-18')).toBe('2026-10-18');
  });

  it('epoch 秒 / 毫秒', () => {
    const ms = Date.UTC(2026, 9, 18); // 2026-10-18 UTC
    expect(formatDate(ms)).toMatch(/^2026-10-1[78]$/);
    expect(formatDate(Math.floor(ms / 1000))).toMatch(/^2026-10-1[78]$/);
  });

  it('非法日期返回空串', () => {
    for (const bad of ['', 'not-a-date', '2026-13-45', undefined, null as unknown as string]) {
      expect(formatDate(bad)).toBe('');
    }
  });
});

describe('buildBaseName', () => {
  const meta = { videoId: '2164411', title: '日常/穿搭 分享', author: 'UP主A', publishTime: '2026-10-18' };

  it('title 模式用清洗后的标题', () => {
    expect(buildBaseName({ mode: 'title', ext: '.mp4', index: 1, meta })).toBe('日常_穿搭 分享');
  });

  it('custom 固定名', () => {
    expect(buildBaseName({ mode: 'custom', name: '我的视频', ext: '.mp4', index: 1, meta })).toBe('我的视频');
  });

  it('custom 模板', () => {
    const out = buildBaseName({
      mode: 'custom',
      template: '{index}-{title} [{author}] {date}',
      ext: '.mp4',
      index: 3,
      meta,
    });
    expect(out).toBe('003-日常_穿搭 分享 [UP主A] 2026-10-18');
  });

  it('标题为空时回退 acfun-<id>', () => {
    expect(buildBaseName({ mode: 'title', ext: '.mp4', index: 1, meta: { ...meta, title: '' } })).toBe(
      'acfun-2164411',
    );
  });

  it('扩展名参与长度预算', () => {
    const long = '项'.repeat(400);
    const out = buildBaseName({ mode: 'title', ext: '.mkv', index: 1, meta: { ...meta, title: long } });
    expect(out.length + '.mkv'.length).toBe(200);
  });
});

describe('重名策略', () => {
  const dir = 'D:/out';
  const existsOf = (taken: string[]): ((p: string) => boolean) => (p) => taken.includes(p);

  it('无冲突直接写', () => {
    const r = resolveOutputPath({ dir, baseName: '视频名', ext: '.mp4', onExist: 'rename', exists: existsOf([]) });
    expect(r).toEqual({ path: 'D:/out/视频名.mp4', action: 'write' });
  });

  it('rename：依次尝试 -1 / -2', () => {
    const exists = existsOf(['D:/out/视频名.mp4', 'D:/out/视频名-1.mp4']);
    const r = resolveOutputPath({ dir, baseName: '视频名', ext: '.mp4', onExist: 'rename', exists });
    expect(r).toEqual({ path: 'D:/out/视频名-2.mp4', action: 'write' });
  });

  it('skip：已存在则跳过', () => {
    const exists = existsOf(['D:/out/视频名.mp4']);
    expect(resolveOutputPath({ dir, baseName: '视频名', ext: '.mp4', onExist: 'skip', exists })).toEqual({
      path: 'D:/out/视频名.mp4',
      action: 'skip',
    });
  });

  it('overwrite：显式指定才覆盖', () => {
    const exists = existsOf(['D:/out/视频名.mp4']);
    expect(resolveOutputPath({ dir, baseName: '视频名', ext: '.mp4', onExist: 'overwrite', exists })).toEqual({
      path: 'D:/out/视频名.mp4',
      action: 'overwrite',
    });
  });

  it('目录尾部有斜杠也不会拼出双斜杠', () => {
    const r = resolveOutputPath({ dir: 'D:/out/', baseName: 'a', ext: '.mp4', onExist: 'rename', exists: () => false });
    expect(r.path).toBe('D:/out/a.mp4');
  });
});

describe('杂项', () => {
  it('容器 → 扩展名', () => {
    expect(extForContainer('mp4')).toBe('.mp4');
    expect(extForContainer('mkv')).toBe('.mkv');
    expect(extForContainer('ts')).toBe('.ts');
  });

  it('sidecar 路径', () => {
    expect(sidecarPath('D:/out/', '视频名', '.meta.json')).toBe('D:/out/视频名.meta.json');
    expect(sidecarPath('D:/out', '视频名', '.jpg')).toBe('D:/out/视频名.jpg');
  });
});
