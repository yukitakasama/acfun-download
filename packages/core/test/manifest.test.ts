import { describe, expect, it } from 'vitest';
import {
  absolutizeUris,
  authKeyFromUrl,
  earliestExpiry,
  isExpired,
  isHlsManifest,
  parseAuthKeyExpiry,
  parsePlaylist,
  pickVariant,
} from '../src/index.js';

/** 真实形态的 media playlist（88 段太长，取 3 段做样本，末段短）。 */
const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="https://seg.example.com/key/enc.key?auth_key=1759999999-abcdef-10-deadbeef"
#EXTINF:4.000000,
https://seg.example.com/jpd/a/aaa26285.ts?auth_key=1759999999-abcdef-10-deadbeef
#EXTINF:4.000000,
https://seg.example.com/jpd/a/aaa26286.ts?auth_key=1759999999-abcdef-10-deadbeef
#EXTINF:0.833333,
https://seg.example.com/jpd/a/aaa26287.ts?auth_key=1759999999-abcdef-10-deadbeef
#EXT-X-ENDLIST
`;

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2400000,RESOLUTION=1920x1080
high/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1200000
mid/index.m3u8
`;

describe('parsePlaylist', () => {
  it('分片数按 #EXTINF 计数，不按末段序号算', () => {
    const p = parsePlaylist(MEDIA);
    expect(p.segments).toBe(3); // 末段叫 aaa26287 但不是 287 段
    expect(p.segmentUrls).toHaveLength(3);
    expect(p.hasEndlist).toBe(true);
    expect(p.isMaster).toBe(false);
  });

  it('#EXTINF 累加成时长', () => {
    const p = parsePlaylist(MEDIA);
    expect(p.durationSec).toBeCloseTo(8.833333, 6);
    expect(p.targetDuration).toBe(4);
  });

  it('取到 AES-128 的 key URI 与 auth_key', () => {
    const p = parsePlaylist(MEDIA);
    expect(p.keyUris[0]).toContain('/key/enc.key');
    expect(p.authKeys.length).toBeGreaterThan(0);
  });

  it('master playlist 识别多码率并按 bandwidth 选最高', () => {
    const p = parsePlaylist(MASTER, { baseUrl: 'https://cdn.example.com/a/b/index.m3u8' });
    expect(p.isMaster).toBe(true);
    expect(p.variants).toHaveLength(3);
    const best = pickVariant(p.variants);
    expect(best?.bandwidth).toBe(2_400_000);
    expect(best?.resolution).toBe('1920x1080');
    expect(best?.url).toBe('https://cdn.example.com/a/b/high/index.m3u8');
  });

  it('无 ENDLIST 时 hasEndlist=false（预览/未完结）', () => {
    expect(parsePlaylist(MEDIA.replace('#EXT-X-ENDLIST', '')).hasEndlist).toBe(false);
  });

  it('空/乱文本不抛异常', () => {
    const p = parsePlaylist('随便什么东西');
    expect(p.segments).toBe(0);
    expect(p.durationSec).toBe(0);
    expect(p.isMaster).toBe(false);
  });
});

describe('absolutizeUris', () => {
  it('相对分片与相对 key URI 都转绝对（ffmpeg 读本地 m3u8 必须绝对）', () => {
    const text = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key/enc.key"
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
https://other.example.com/seg1.ts
`;
    const out = absolutizeUris(text, 'https://cdn.example.com/a/b/index.m3u8');
    expect(out).toContain('URI="https://cdn.example.com/a/b/key/enc.key"');
    expect(out).toContain('https://cdn.example.com/a/b/seg0.ts');
    expect(out).toContain('https://other.example.com/seg1.ts');
  });

  it('已是绝对地址的不动', () => {
    const text = '#EXTINF:4.0,\nhttps://x.com/a.ts\n';
    expect(absolutizeUris(text, 'https://cdn.example.com/x.m3u8')).toContain('https://x.com/a.ts');
  });
});

describe('auth_key 过期判断', () => {
  it('10 位 unix 秒 → epoch 毫秒', () => {
    expect(parseAuthKeyExpiry('1759999999-abcdef-10-deadbeef')).toBe(1_759_999_999_000);
  });

  it('13 位毫秒直接用', () => {
    expect(parseAuthKeyExpiry('1759999999123-abcdef-10-deadbeef')).toBe(1_759_999_999_123);
  });

  it('格式不符 / 空值 → undefined', () => {
    for (const bad of ['', 'abc', 'not-a-key', undefined, null]) {
      expect(parseAuthKeyExpiry(bad)).toBeUndefined();
    }
  });

  it('URL 编码的 auth_key 也能解', () => {
    expect(parseAuthKeyExpiry(encodeURIComponent('1759999999-abcdef-10-deadbeef'))).toBe(1_759_999_999_000);
  });

  it('isExpired 带 30s 提前量', () => {
    const now = 1_000_000;
    expect(isExpired(now + 10_000, now)).toBe(true); // 10s 后过期 → 已算过期
    expect(isExpired(now + 60_000, now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false); // 取不到过期时间 → 不当作过期
  });

  it('authKeyFromUrl / earliestExpiry 取最早过期时间', () => {
    expect(authKeyFromUrl('https://x.com/a.m3u8?auth_key=1759999999-ab-10-cd')).toBe('1759999999-ab-10-cd');
    const p = parsePlaylist(MEDIA);
    const exp = earliestExpiry(p, 'https://x.com/a.m3u8?auth_key=1759999000-ab-10-cd');
    expect(exp).toBe(1_759_999_000_000);
  });
});

describe('isHlsManifest', () => {
  it('必须含 #EXTM3U', () => {
    expect(isHlsManifest(MEDIA)).toBe(true);
    expect(isHlsManifest('<html>需要登录</html>')).toBe(false);
    expect(isHlsManifest('')).toBe(false);
  });
});
