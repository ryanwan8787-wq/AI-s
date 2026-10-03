import { describe, it, expect } from 'vitest';
import { AppError, ERROR_CODES, ERROR_DEFAULTS, err, isAppErrorInfo, makeError, ok, toAppError } from '../../src/shared/types/errors';
import { VISEMES, VRM0_TO_VRM1_PRESET, VRM_EXPRESSION_PRESETS } from '../../src/shared/types/domain';

describe('errors', () => {
  it('every error code has defaults', () => {
    expect(Object.keys(ERROR_DEFAULTS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('makeError applies defaults and allows overrides', () => {
    expect(makeError('TTS_NETWORK', 'offline')).toEqual({ code: 'TTS_NETWORK', message: 'offline', severity: 'warning', retryable: true });
    const e = makeError('INTERNAL', 'x', { severity: 'info', retryable: true, detail: { a: 1 } });
    expect(e).toMatchObject({ severity: 'info', retryable: true, detail: { a: 1 } });
  });

  it('toAppError normalizes anything', () => {
    const info = makeError('VRM_LOAD_FAILED', 'bad');
    expect(toAppError(info)).toBe(info);
    expect(toAppError(new AppError(info))).toBe(info);
    expect(toAppError(new TypeError('t'), 'LLM_BAD_OUTPUT')).toMatchObject({ code: 'LLM_BAD_OUTPUT', message: 't', detail: { name: 'TypeError' } });
    expect(toAppError('str').message).toBe('str');
    expect(toAppError(42).message).toBe('Unknown error');
  });

  it('AppErrorInfo survives structuredClone (IPC) and is recognized', () => {
    const cloned = structuredClone(makeError('OLLAMA_UNREACHABLE', 'down', { detail: { url: 'http://127.0.0.1:11434' } }));
    expect(isAppErrorInfo(cloned)).toBe(true);
    expect(isAppErrorInfo({ code: 'NOPE', message: '', severity: 'error', retryable: true })).toBe(false);
    expect(isAppErrorInfo(null)).toBe(false);
  });

  it('AppError.of carries code', () => {
    const e = AppError.of('LLM_MODEL_NOT_FOUND', 'missing', { model: 'x' });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('LLM_MODEL_NOT_FOUND');
    expect(e.info.detail).toEqual({ model: 'x' });
  });

  it('Result helpers', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('e')).toEqual({ ok: false, error: 'e' });
  });
});

describe('VRM expression mapping', () => {
  it('maps every VRM 0.x preset to a valid VRM 1.0 preset', () => {
    for (const v1 of Object.values(VRM0_TO_VRM1_PRESET)) expect(VRM_EXPRESSION_PRESETS).toContain(v1);
  });

  it('maps 0.x vowels a/i/u/e/o onto the 1.0 visemes', () => {
    expect(['a', 'i', 'u', 'e', 'o'].map((k) => VRM0_TO_VRM1_PRESET[k])).toEqual([...VISEMES]);
  });
});
