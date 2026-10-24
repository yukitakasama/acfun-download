/**
 * 测试用临时目录：统一前缀 + 自动清理。
 *
 * 不清理会在 %TEMP% 堆一堆 acfun-* 目录（实测跑几轮就上百个），
 * 所以这里在文件级 afterAll 里统一删掉。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const created: string[] = [];

export function tmpDir(prefix = 'acfun-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 被占用就留给系统清理 */
    }
  }
  created.length = 0;
});
