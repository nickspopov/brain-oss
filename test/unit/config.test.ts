import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

describe('config', () => {
  it('defaults in dev mode', () => {
    const c = loadConfig({ BRAIN_DEV: '1' });
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(7460);
    expect(c.tenant).toBe('default');
    expect(c.limits.maxDocBytes).toBe(512 * 1024);
    expect(c.limits.maxFileBytes).toBe(20 * 1024 * 1024);
    expect(c.limits.maxRequestBytes).toBe(2 * 1024 * 1024);
    expect(c.limits.ratePerMinute).toEqual({ write: 30, read: 300, search: 60 });
    expect(c.tokenDays).toBe(90);
  });

  it('refuses a non-https origin without BRAIN_DEV', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(loadConfig({ BRAIN_ORIGIN: 'https://brain.example' }).origin).toBe('https://brain.example');
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ BRAIN_DEV: '1', BRAIN_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ BRAIN_DEV: '1', BRAIN_TENANT: 'Bad Slug' })).toThrow(ConfigError);
  });
});
