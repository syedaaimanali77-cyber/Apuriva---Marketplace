/** Spec 034 §3.3 "Reply envelope" — parsing the `conversation` task's output (AC-13). */
import { describe, expect, it } from 'vitest';
import { parseReplyEnvelope } from './reply-envelope';

describe('parseReplyEnvelope', () => {
  it('treats a non-JSON output entirely as the reply — the sandbox placeholder proposes nothing', () => {
    // Spec 033's sandbox placeholder shape (lib/ai/provider is off-limits outside lib/ai).
    const placeholder = '[sandbox-ai: no model configured] task=conversation';
    expect(parseReplyEnvelope(placeholder)).toEqual({ reply: placeholder, memoryProposal: null });
    expect(parseReplyEnvelope('Hello there')).toEqual({ reply: 'Hello there', memoryProposal: null });
  });

  it('treats JSON that is not an envelope entirely as the reply', () => {
    for (const output of ['[1,2]', '"text"', '42', '{"answer":"x"}', '{"reply":7}']) {
      expect(parseReplyEnvelope(output)).toEqual({ reply: output, memoryProposal: null });
    }
  });

  it('extracts the reply and a valid proposal', () => {
    const output = JSON.stringify({ reply: 'Noted.', memoryProposal: { key: 'language', value: { language: 'ur-Latn' } } });
    expect(parseReplyEnvelope(output)).toEqual({
      reply: 'Noted.',
      memoryProposal: { key: 'language', value: { language: 'ur-Latn' } },
    });
  });

  it('an unknown key or invalid value is dropped, and the reply is still returned', () => {
    for (const memoryProposal of [
      { key: 'communication_preferences', value: { channel: 'sms' } },
      { key: 'preferred_provider_characteristics', value: { gender: 'female' } },
      { key: 'preferred_area', value: { city: 'Lahore', street: '12 Main Blvd' } },
      { key: 'language', value: { language: 'fr' } },
      'remember everything',
      null,
    ]) {
      expect(parseReplyEnvelope(JSON.stringify({ reply: 'OK', memoryProposal }))).toEqual({ reply: 'OK', memoryProposal: null });
    }
  });

  it('a reply with no proposal has none', () => {
    expect(parseReplyEnvelope(JSON.stringify({ reply: 'Hi' }))).toEqual({ reply: 'Hi', memoryProposal: null });
  });
});
