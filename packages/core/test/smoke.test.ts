import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from '../src/index.js';

describe('core skeleton', () => {
  it('exports a version string', () => {
    expect(typeof CORE_VERSION).toBe('string');
  });
});
