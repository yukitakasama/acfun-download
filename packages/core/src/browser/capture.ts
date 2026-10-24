/**
 * 浏览器侧「一轮取清单」逻辑 —— **只依赖 driver 接口，不依赖具体浏览器**。
 *
 * 这样同一份逻辑能在两个通道里跑：
 *   1. ego lite：本函数经 `Function.prototype.toString()` 序列化后注入 `ego-browser nodejs` 运行时，
 *      传入 ego 自己的 `page` 对象（形状与本文件的 BrowserPage 一致）。
 *   2. Chrome + CDP：在 Node 里直接调用，传入 CDP 适配出来的 page。
 *
 * 硬性约束（照 skill 实测坑写的，别改）：
 *   - `Network.enable` 必须在 `goto` **之前**：authPath / aut 只随页面实发请求出现一次。
 *   - 每条 `goto` **前**先 `await page.events()` 丢弃残留：`page.events()` 取走即清空，
 *     上一条剩下的网络事件会被下一条当成自己的证据，导致不存在的 id 也「成功」。
 *   - 取清单用页面上下文 `fetch`（自动带 Referer/Cookie），不要手工拼头。
 *   - 本函数内部只能用 ego/浏览器自带的全局与 `await import('node:…')`，
 *     **不得引用本模块的其他变量或函数**（闭包不会跟到 ego 进程里）。
 */

export interface BrowserFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface BrowserEvent {
  method?: string;
  params?: {
    request?: { url?: string; headers?: Record<string, string> };
  };
}

/** ego 的 page 与 Chrome 的适配器都实现这个形状。 */
export interface BrowserPage {
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  goto(url: string): Promise<unknown>;
  events(): Promise<BrowserEvent[]>;
  fetch(
    url: string,
    opts?: { timeout?: number; headers?: Record<string, string>; method?: string; body?: string },
  ): Promise<BrowserFetchResult>;
  evaluate(expression: string): Promise<unknown>;
}

export interface CaptureItem {
  id: string;
  url: string;
  /** 浏览器侧把清单原文写到这个文件（绝对路径）。 */
  manifestFile: string;
}

export interface CaptureRoundOptions {
  generation: 'nuxt' | 'vite';
  items: CaptureItem[];
  resultFile: string;
  page: BrowserPage;
  captureTimeoutMs?: number;
  fetchTimeoutMs?: number;
}

/** 单条捕获结果（跨进程回传，必须可 JSON 化）。 */
export interface CaptureRecord {
  id: string;
  url: string;
  ok: boolean;
  fatal?: boolean;
  /** 机器可读失败码，Node 侧映射成 AppError。 */
  errorCode?: string;
  error?: string;
  apiHost?: string;
  /** 最终清单地址（authPath URL 或被选中的子清单）。 */
  playlistUrl?: string;
  /** 页面标题（已去掉站点后缀）。 */
  rawTitle?: string;
  manifestDur?: number;
  segCount?: number;
  hasEndlist?: boolean;
  variantBandwidth?: number;
  /** 仅 Vite：canWatch / 详情时长 / 视频标题。 */
  canWatch?: boolean;
  detailDuration?: number;
  detailTitle?: string;
  previewOnly?: boolean;
  /** 非 public 的 authPath（理论不该出现，出现就记录）。 */
  nonPublic?: boolean;
  warn?: string;
}

/**
 * 跑一轮取清单。**本函数会被 serialize 到 ego 运行时执行**，所以：
 * 不引用外部标识符、只用参数与 `await import(...)`。
 */
export async function captureRound(opts: CaptureRoundOptions): Promise<void> {
  const fs = await import('node:fs/promises');
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const page = opts.page;
  const results: CaptureRecord[] = [];
  // 60s：Vite 世代要等站点自己走完访客登录流程才会发出带 aut 的请求（实测可达 40s+）。
  const captureTimeoutMs = opts.captureTimeoutMs ?? 60_000;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 20_000;

  const sumExtinf = (text: string): number => {
    let total = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = /^#EXTINF:(\d+(?:\.\d+)?)/.exec(line.trim());
      if (m && m[1]) total += Number.parseFloat(m[1]);
    }
    return Math.round(total * 1e6) / 1e6;
  };
  const countExtinf = (text: string): number => {
    let n = 0;
    for (const line of text.split(/\r?\n/)) if (/^#EXTINF:/.test(line.trim())) n += 1;
    return n;
  };

  try {
    // Network.enable 必须早于任何 goto。
    await page.cdp('Network.enable');

    for (const item of opts.items) {
      const rec: CaptureRecord = { id: item.id, url: item.url, ok: false };
      try {
        // 丢弃上一条页面残留的网络事件（串页防护，实测必需）。
        await page.events();
        await page.goto(item.url);

        // ---- 1. 抓清单地址 ----
        let playlistUrl: string | null = null;
        let authHeaders: Record<string, string> | null = null;
        const deadline = Date.now() + captureTimeoutMs;

        if (opts.generation === 'nuxt') {
          while (Date.now() < deadline) {
            const evs = await page.events();
            const hits = evs.filter(
              (e) =>
                e &&
                e.method === 'Network.requestWillBeSent' &&
                /m3u8\/(public\/)?decode\/authPath/.test((e.params?.request?.url as string) || ''),
            );
            const hit = hits.length > 0 ? hits[hits.length - 1] : null;
            const url = hit?.params?.request?.url;
            if (url) {
              playlistUrl = url;
              break;
            }
            await sleep(300);
          }
          if (!playlistUrl) {
            rec.errorCode = 'AUTH_PATH_NOT_CAPTURED';
            rec.error = '未能捕获 authPath 请求（该内容可能需要登录/购买，按安全边界停止）';
          } else {
            rec.nonPublic = !/\/public\//.test(playlistUrl);
            rec.apiHost = new URL(playlistUrl).origin;
          }
        } else {
          // Vite 世代：先抓页面自己发出的 API 请求头里的 aut 等授权头
          while (Date.now() < deadline) {
            const evs = await page.events();
            for (const e of evs) {
              const req = e?.params?.request;
              if (!req || e.method !== 'Network.requestWillBeSent' || !req.headers) continue;
              const hasAut = Object.keys(req.headers).some((k) => k.toLowerCase() === 'aut');
              if (hasAut) {
                authHeaders = req.headers;
                break;
              }
            }
            if (authHeaders) break;
            await sleep(250);
          }
          if (!authHeaders) {
            rec.errorCode = 'AUT_NOT_CAPTURED';
            rec.error = '未能从网络请求中抓到 aut 头（该站点可能是 Nuxt 3 世代，应换世代重试）';
          }
        }

        // ---- 2. Vite：重放 getVideoById + AES 解密 + 检查 canWatch ----
        if (!rec.errorCode && opts.generation === 'vite' && authHeaders) {
          const crypto = await import('node:crypto');
          const g = (name: string): string => {
            for (const k of Object.keys(authHeaders as Record<string, string>)) {
              if (k.toLowerCase() === name.toLowerCase()) return String((authHeaders as Record<string, string>)[k]);
            }
            return '';
          };
          const aut = g('aut');
          const t = String(Date.now());
          const s = crypto.createHash('md5').update(t.slice(3, 8)).digest('hex');
          const videoId = item.id;
          const detailResp = await page.fetch(`/api/video/getVideoById?videoId=${videoId}&_t=${t}`, {
            timeout: fetchTimeoutMs,
            headers: {
              Accept: 'application/json, text/plain, */*',
              'Accept-Language': 'zh-CN',
              deviceId: g('deviceId'),
              device: g('device') || 'PC',
              appVersion: g('appVersion') || '1.9.6',
              'User-Mark': 'xhp',
              aut,
              t,
              s,
              sid: g('sid'),
            },
          });
          if (!detailResp || detailResp.status !== 200 || !detailResp.body) {
            rec.errorCode = 'DETAIL_FAILED';
            rec.error = `详情接口失败: status=${detailResp?.status}`;
          } else {
            let detail: Record<string, unknown> | null = null;
            try {
              const outer = JSON.parse(detailResp.body) as { code?: number; encData?: string };
              if (outer.code !== 200 || !outer.encData) {
                rec.errorCode = 'DETAIL_FAILED';
                rec.error = `详情接口 code=${outer.code}`;
              } else {
                const key = Buffer.from(aut.slice(2, 18), 'utf8');
                const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
                const plain = Buffer.concat([
                  decipher.update(Buffer.from(outer.encData, 'base64')),
                  decipher.final(),
                ]).toString('utf8');
                detail = JSON.parse(plain) as Record<string, unknown>;
              }
            } catch (e) {
              rec.errorCode = 'DETAIL_FAILED';
              rec.error = `详情解密失败: ${(e as Error)?.message ?? String(e)}`;
            }
            if (detail) {
              rec.canWatch = detail.canWatch === true;
              rec.detailTitle = typeof detail.title === 'string' ? detail.title : '';
              rec.detailDuration = typeof detail.duration === 'number' ? detail.duration : undefined;
              rec.previewOnly = !rec.canWatch && Boolean(detail.previewUrl);
              if (!rec.canWatch) {
                rec.errorCode = 'AUTH_REQUIRED';
                rec.error = rec.previewOnly
                  ? '该视频只提供预览（previewUrl），按安全边界停止'
                  : 'canWatch=false：该内容需要登录或购买，按安全边界停止';
              } else {
                const cdnList = Array.isArray(detail.cdnList) ? (detail.cdnList as Array<{ id?: unknown }>) : [];
                const cdnId = cdnList[0]?.id;
                const path = `/api/m3u8/decode/authPath?path=${encodeURIComponent(String(detail.videoUrl ?? ''))}&auth_key=${encodeURIComponent(String(detail.authKey ?? ''))}${cdnId != null ? `&id=${String(cdnId)}` : ''}`;
                playlistUrl = path;
              }
            }
          }
        }

        // ---- 3. 取清单（页面上下文 fetch，自动带 Referer/Cookie）----
        if (!rec.errorCode && playlistUrl) {
          const first = await page.fetch(playlistUrl, { timeout: fetchTimeoutMs });
          let text = first?.body ?? '';
          if (!first || first.status !== 200 || !text) {
            rec.errorCode = 'MANIFEST_HTTP';
            rec.error = `获取 HLS 清单失败: status=${first?.status}`;
          } else if (!/^#EXTM3U/m.test(text)) {
            rec.errorCode = 'NOT_HLS';
            rec.error = '返回内容不是 HLS 清单（不可公开播放，按安全边界停止）';
          } else if (/#EXT-X-STREAM-INF:/.test(text)) {
            // 多码率：取 bandwidth 最高且能正常取回的子清单
            const lines = text.split(/\r?\n/);
            const variants: Array<{ bw: number; url: string }> = [];
            let pending: number | null = null;
            for (const raw of lines) {
              const line = raw.trim();
              if (!line) continue;
              if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
                const m = /BANDWIDTH=(\d+)/.exec(line);
                pending = m && m[1] ? Number.parseInt(m[1], 10) : -1;
              } else if (line.charAt(0) !== '#' && pending !== null) {
                variants.push({ bw: pending, url: new URL(line, playlistUrl).href });
                pending = null;
              }
            }
            variants.sort((a, b) => b.bw - a.bw);
            let picked: { bw: number; text: string; url: string } | null = null;
            for (const v of variants) {
              const sub = await page.fetch(v.url, { timeout: fetchTimeoutMs });
              if (sub && sub.status === 200 && /^#EXTM3U/m.test(sub.body || '')) {
                picked = { bw: v.bw, text: sub.body, url: v.url };
                break;
              }
            }
            if (!picked) {
              rec.errorCode = 'MANIFEST_HTTP';
              rec.error = '多码率子清单全部取不到';
            } else {
              text = picked.text;
              playlistUrl = picked.url;
              if (picked.bw > 0) rec.variantBandwidth = picked.bw;
            }
          }

          if (!rec.errorCode) {
            const title = await page.evaluate(
              `(function(){try{return String(document.title||'')}catch(e){return ''}})()`,
            );
            rec.rawTitle = String(title ?? '');
            rec.playlistUrl = playlistUrl;
            rec.manifestDur = sumExtinf(text);
            rec.segCount = countExtinf(text);
            rec.hasEndlist = /#EXT-X-ENDLIST/.test(text);
            if (!rec.hasEndlist) rec.warn = '清单无 #EXT-X-ENDLIST（可能不是完整 VOD）';
            await fs.writeFile(item.manifestFile, text, 'utf8');
            rec.ok = true;
          }
        }
      } catch (e) {
        rec.ok = false;
        rec.error = (e as Error)?.message ?? String(e);
      }
      results.push(rec);
    }
  } catch (e) {
    results.push({
      id: opts.items[0]?.id ?? '',
      url: opts.items[0]?.url ?? '',
      ok: false,
      fatal: true,
      error: (e as Error)?.message ?? String(e),
    });
  }

  await fs.writeFile(opts.resultFile, JSON.stringify(results, null, 1), 'utf8');
}

/** 序列化 captureRound 供 ego 注入（单测会断言这是合法可求值的源码）。 */
export const CAPTURE_ROUND_SOURCE = captureRound.toString();
