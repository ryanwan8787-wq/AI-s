import { describe, it, expect } from 'vitest';
import { AppConfigSchema, DEFAULT_CONFIG, resolveModelProfile, CONFIG_HOT_RELOAD } from '../../src/shared/config/schema';
import { applyConfigPatch, deepMerge, diffPaths, isUnder, loadConfigLenient } from '../../src/shared/config/merge';

describe('AppConfigSchema', () => {
  it('produces a complete config from {}', () => {
    const c = AppConfigSchema.parse({});
    expect(c.llm.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(c.llm.model).toBe('qwen3.8:27b');
    expect(c.stt.mode).toBe('push_to_talk');
    expect(c.stt.whisper).toMatchObject({ modelSize: 'small', device: 'cuda', computeType: 'float16' });
    expect(c.tts.voice).toBe('zh-TW-HsiaoChenNeural');
    expect(c.lipSync).toMatchObject({ attackMs: 40, releaseMs: 100 });
    expect(c.avatar.eyeTracking).toMatchObject({ maxYawDeg: 35, maxPitchDeg: 20 });
    expect(c).toEqual(DEFAULT_CONFIG);
  });

  it('accepts zh-CN-XiaoxiaoNeural and rejects malformed voice names', () => {
    expect(AppConfigSchema.safeParse({ tts: { voice: 'zh-CN-XiaoxiaoNeural' } }).success).toBe(true);
    expect(AppConfigSchema.safeParse({ tts: { voice: 'xiaoxiao' } }).success).toBe(false);
  });

  it.each(['http://localhost:11434', 'http://[::1]:11434', 'http://127.0.0.1:8080'])('accepts loopback %s', (u) => {
    expect(AppConfigSchema.safeParse({ llm: { ollamaBaseUrl: u } }).success).toBe(true);
  });

  it.each(['http://192.168.1.2:11434', 'http://example.com', 'ftp://127.0.0.1', 'not a url'])(
    'rejects non-loopback / invalid url %s',
    (u) => {
      expect(AppConfigSchema.safeParse({ llm: { ollamaBaseUrl: u } }).success).toBe(false);
    },
  );

  it('accepts large-v3-turbo and rejects unknown whisper sizes', () => {
    expect(AppConfigSchema.safeParse({ stt: { whisper: { modelSize: 'large-v3-turbo' } } }).success).toBe(true);
    expect(AppConfigSchema.safeParse({ stt: { whisper: { modelSize: 'huge' } } }).success).toBe(false);
  });

  it('validates outfit ids (LLM-facing) strictly', () => {
    const good = { avatar: { outfits: [{ id: 'casual_01', label: '便服', vrmPath: 'C:/a.vrm' }] } };
    expect(AppConfigSchema.safeParse(good).success).toBe(true);
    const bad = { avatar: { outfits: [{ id: 'Casual Outfit!', label: 'x', vrmPath: 'C:/a.vrm' }] } };
    expect(AppConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('resolveModelProfile fills defaults for unknown models without mutating config', () => {
    const c = AppConfigSchema.parse({ llm: { modelProfiles: { 'qwen3:8b': { numCtx: 4096 } } } });
    expect(resolveModelProfile(c.llm, 'qwen3:8b')).toMatchObject({ numCtx: 4096, temperature: 0.7, sendThinkFalse: true });
    expect(resolveModelProfile(c.llm, 'gemma3:4b').numCtx).toBe(8192);
    expect(Object.keys(c.llm.modelProfiles)).toEqual(['qwen3:8b']);
  });

  it('declares hot-reload policy for every top-level section', () => {
    expect(Object.keys(CONFIG_HOT_RELOAD).sort()).toEqual(Object.keys(AppConfigSchema.shape).sort());
  });
});

describe('deepMerge', () => {
  it('merges nested objects, replaces arrays, ignores undefined, deletes on null', () => {
    const base = { a: { b: 1, c: 2 }, list: [1, 2], keep: 'x', opt: 5 };
    const out = deepMerge(base, { a: { c: 3 }, list: [9], keep: undefined, opt: null });
    expect(out).toEqual({ a: { b: 1, c: 3 }, list: [9], keep: 'x' });
    expect(base).toEqual({ a: { b: 1, c: 2 }, list: [1, 2], keep: 'x', opt: 5 }); // immutable
  });

  it('blocks prototype pollution', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"a":1}') as object;
    const out = deepMerge({}, payload) as Record<string, unknown>;
    expect(out['a']).toBe(1);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, 'constructor')).toBe(false);
  });

  it('does not alias patch objects into the result', () => {
    const patch = { a: { deep: { v: 1 } } };
    const out = deepMerge({}, patch) as typeof patch;
    patch.a.deep.v = 2;
    expect(out.a.deep.v).toBe(1);
  });
});

describe('diffPaths / isUnder', () => {
  it('reports leaf paths, treating arrays as leaves', () => {
    expect(diffPaths({ a: { b: 1, c: [1] } }, { a: { b: 2, c: [1] } })).toEqual(['a.b']);
    expect(diffPaths({ a: [1, 2] }, { a: [1, 3] })).toEqual(['a']);
    expect(diffPaths({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(diffPaths(1, 1)).toEqual([]);
  });

  it('isUnder matches prefixes on segment boundaries only', () => {
    expect(isUnder(['stt.whisper.modelSize'], 'stt.whisper')).toBe(true);
    expect(isUnder(['stt.whisperX'], 'stt.whisper')).toBe(false);
    expect(isUnder(['stt'], 'stt')).toBe(true);
  });
});

describe('applyConfigPatch', () => {
  it('applies a valid patch and lists changed paths', () => {
    const r = applyConfigPatch(DEFAULT_CONFIG, { llm: { model: 'qwen3:8b' }, tts: { voice: 'zh-CN-XiaoxiaoNeural' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.llm.model).toBe('qwen3:8b');
    expect(r.changedPaths.sort()).toEqual(['llm.model', 'tts.voice']);
    expect(DEFAULT_CONFIG.llm.model).toBe('qwen3.8:27b');
  });

  it('rejects an invalid patch without side effects', () => {
    const r = applyConfigPatch(DEFAULT_CONFIG, { performance: { fpsActive: 9999 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/fpsActive/);
  });

  it('restores defaults for a field set to null', () => {
    const cur = applyConfigPatch(DEFAULT_CONFIG, { tts: { rate: '+10%' } });
    if (!cur.ok) throw new Error('setup');
    const r = applyConfigPatch(cur.next, { tts: { rate: null } });
    expect(r.ok && r.next.tts.rate).toBe('+0%');
  });
});

describe('loadConfigLenient', () => {
  it('returns parsed config when valid', () => {
    const r = loadConfigLenient({ llm: { model: 'qwen3:4b' } });
    expect(r.resetSections).toEqual([]);
    expect(r.config.llm.model).toBe('qwen3:4b');
  });

  it('resets only the broken sections and keeps the rest', () => {
    const r = loadConfigLenient({
      llm: { model: 'qwen3:4b' },
      tts: { voice: 123 },
      performance: { fpsActive: -1 },
    });
    expect(r.resetSections.sort()).toEqual(['performance', 'tts']);
    expect(r.config.llm.model).toBe('qwen3:4b');
    expect(r.config.tts.voice).toBe('zh-TW-HsiaoChenNeural');
    expect(r.config.performance.fpsActive).toBe(60);
  });

  it('handles garbage input', () => {
    expect(loadConfigLenient(null).config).toEqual(DEFAULT_CONFIG);
    expect(loadConfigLenient('nope').config).toEqual(DEFAULT_CONFIG);
  });
});
