import { describe, it, expect } from 'vitest';
import {
  createAIResponseJsonSchema,
  createAIResponseSchema,
  parseAIResponse,
  REPLY_MAX_CHARS,
} from '../../src/shared/ai/AIResponse';

describe('AIResponse JSON Schema (Ollama format)', () => {
  it('keeps property order emotion → action → outfitId → reply', () => {
    const s = createAIResponseJsonSchema(['casual', 'school']);
    expect(Object.keys(s['properties'] as object)).toEqual(['emotion', 'action', 'outfitId', 'reply']);
    expect(s['required']).toEqual(['emotion', 'reply']);
    expect(s['additionalProperties']).toBe(false);
    expect(s).not.toHaveProperty('$schema');
  });

  it('injects outfit ids as enum, deduplicated', () => {
    const s = createAIResponseJsonSchema(['a', 'b', 'a']);
    const props = s['properties'] as Record<string, { enum?: string[] }>;
    expect(props['outfitId']?.enum).toEqual(['a', 'b']);
  });

  it('omits outfitId entirely when there are no outfits', () => {
    const s = createAIResponseJsonSchema([]);
    expect(Object.keys(s['properties'] as object)).toEqual(['emotion', 'action', 'reply']);
  });

  it('lists all emotions and actions from the spec', () => {
    const props = createAIResponseJsonSchema()['properties'] as Record<string, { enum?: string[] }>;
    expect(props['emotion']?.enum).toEqual(['idle', 'happy', 'shy', 'caring', 'annoyed', 'surprised']);
    expect(props['action']?.enum).toEqual(['nod', 'head_pat_react', 'wave', 'stretch', 'leave', 'return']);
  });
});

describe('parseAIResponse', () => {
  const outfits = ['casual', 'pajama'];

  it('accepts a fully valid response', () => {
    const r = parseAIResponse('{"emotion":"happy","action":"wave","outfitId":"casual","reply":"嗨！"}', outfits);
    expect(r).toEqual({
      response: { emotion: 'happy', action: 'wave', outfitId: 'casual', reply: '嗨！' },
      degraded: false,
      dropped: [],
    });
  });

  it('degrades plain text to idle + raw reply', () => {
    const r = parseAIResponse('  今天天氣不錯耶  ');
    expect(r.response).toEqual({ emotion: 'idle', reply: '今天天氣不錯耶' });
    expect(r.degraded).toBe(true);
  });

  it('degrades truncated JSON to idle + raw text', () => {
    const raw = '{"emotion":"happy","reply":"說到一半';
    const r = parseAIResponse(raw);
    expect(r.response.emotion).toBe('idle');
    expect(r.response.reply).toBe(raw);
    expect(r.degraded).toBe(true);
  });

  it('degrades non-object JSON (array / string / null)', () => {
    for (const raw of ['[1,2]', '"hi"', 'null']) {
      const r = parseAIResponse(raw);
      expect(r.degraded).toBe(true);
      expect(r.response.emotion).toBe('idle');
    }
  });

  it('always ignores illegal outfitId but keeps the rest', () => {
    const r = parseAIResponse('{"emotion":"shy","outfitId":"bikini","reply":"嗯…"}', outfits);
    expect(r.response).toEqual({ emotion: 'shy', reply: '嗯…' });
    expect(r.degraded).toBe(false);
    expect(r.dropped).toEqual([{ field: 'outfitId', value: 'bikini', reason: 'not in allowed outfit list' }]);
  });

  it('ignores outfitId when no outfit list is provided', () => {
    const r = parseAIResponse('{"emotion":"idle","outfitId":"casual","reply":"好"}', []);
    expect(r.response).not.toHaveProperty('outfitId');
  });

  it('repairs invalid emotion to idle and drops invalid action', () => {
    const r = parseAIResponse('{"emotion":"ecstatic","action":"backflip","reply":"哈"}');
    expect(r.response).toEqual({ emotion: 'idle', reply: '哈' });
    expect(r.degraded).toBe(true);
    expect(r.dropped.map((d) => d.field).sort()).toEqual(['action', 'emotion']);
  });

  it('falls back to raw text when reply is missing or not a string', () => {
    const raw = '{"emotion":"happy","reply":42}';
    const r = parseAIResponse(raw);
    expect(r.response.reply).toBe(raw);
    expect(r.response.emotion).toBe('happy');
    expect(r.degraded).toBe(true);
  });

  it('strips extra keys', () => {
    const r = parseAIResponse('{"emotion":"caring","reply":"早點睡","thinking":"..."}');
    expect(r.response).toEqual({ emotion: 'caring', reply: '早點睡' });
  });

  it('tolerates ```json code fences', () => {
    const r = parseAIResponse('```json\n{"emotion":"surprised","reply":"欸？"}\n```');
    expect(r.response).toEqual({ emotion: 'surprised', reply: '欸？' });
    expect(r.degraded).toBe(false);
  });

  it('clamps overly long replies', () => {
    const long = 'あ'.repeat(REPLY_MAX_CHARS + 50);
    const r = parseAIResponse(JSON.stringify({ emotion: 'idle', reply: long }));
    expect(r.response.reply.length).toBe(REPLY_MAX_CHARS);
    expect(r.dropped.some((d) => d.field === 'reply')).toBe(true);
  });

  it('never throws on arbitrary input', () => {
    const inputs = ['', '{', '}', '{"a":', '\u0000', '{"emotion":null}', 'undefined', '{"reply":"x","emotion":{}}'];
    for (const s of inputs) expect(() => parseAIResponse(s)).not.toThrow();
  });

  it('zod schema rejects unknown keys (strict) for the happy path', () => {
    expect(createAIResponseSchema().safeParse({ emotion: 'idle', reply: 'x', extra: 1 }).success).toBe(false);
  });
});
