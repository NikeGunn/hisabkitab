/** Pure unit tests for model routing / trivial-turn short-circuit (PRD v2.0 §7). */
import { describe, expect, it } from 'vitest';
import { classifyTurn, pickModel, routeTurn, TRIVIAL_REPLY } from '../src/index.js';

describe('classifyTurn — trivial acks', () => {
  it('classes short acknowledgements as trivial (no agent needed)', () => {
    for (const t of ['ok', 'okay', 'thanks', 'thank you', 'thx', 'great', 'cool', 'done', 'yes', 'no']) {
      expect(classifyTurn(t)).toBe('trivial');
    }
  });

  it('handles romanized + Devanagari Nepali acks', () => {
    for (const t of ['dhanyabad', 'thik cha', 'huncha', 'धन्यवाद', 'नमस्ते', 'हुन्छ', 'ठिक छ']) {
      expect(classifyTurn(t)).toBe('trivial');
    }
  });

  it('a lone emoji / punctuation is trivial', () => {
    expect(classifyTurn('👍')).toBe('trivial');
    expect(classifyTurn('🙏🙏')).toBe('trivial');
    expect(classifyTurn('...')).toBe('trivial');
    expect(classifyTurn('ok 👍')).toBe('trivial');
  });
});

describe('classifyTurn — substantive (the safety-critical direction)', () => {
  it('PROBE: a money message is NEVER trivial (false-trivial would swallow an entry)', () => {
    for (const t of [
      'paid 5000 to ram',
      'sold goods 12000',
      'expense 450',
      'vat?',
      'how much do I owe',
      'send me the receivables report',
      'add 98XXXXXXXX as accountant',
      'thanks, also I sold 3 items for 900', // ack PREFIX must not win
    ]) {
      expect(classifyTurn(t)).toBe('substantive');
    }
  });

  it('PROBE: any digit anywhere forces substantive', () => {
    expect(classifyTurn('ok 100')).toBe('substantive');
    expect(classifyTurn('done 2')).toBe('substantive');
  });

  it('PROBE: an unknown word forces substantive (deny-by-default for trivial)', () => {
    expect(classifyTurn('reconcile')).toBe('substantive');
    expect(classifyTurn('khate')).toBe('substantive');
  });

  it('PROBE: a long utterance is substantive even if every word is ack-like', () => {
    expect(classifyTurn('ok ok ok thanks thanks great')).toBe('substantive');
  });

  it('empty / whitespace is substantive (let the agent handle it safely)', () => {
    expect(classifyTurn('')).toBe('substantive');
    expect(classifyTurn('   ')).toBe('substantive');
    expect(classifyTurn(undefined)).toBe('substantive');
  });
});

describe('pickModel & routeTurn', () => {
  it('pickModel maps trivial→cheap, substantive→money', () => {
    expect(pickModel('trivial')).toBe('cheap');
    expect(pickModel('substantive')).toBe('money');
  });

  it('routeTurn returns a canned reply for trivial and none for substantive', () => {
    const trivial = routeTurn('thanks');
    expect(trivial.intent).toBe('trivial');
    expect(trivial.cannedReply).toBe(TRIVIAL_REPLY);

    const real = routeTurn('paid 500 to ram');
    expect(real.intent).toBe('substantive');
    expect(real.cannedReply).toBeUndefined();
    expect(real.model).toBe('money');
  });

  it('PROBE: attached media is ALWAYS substantive, even with a trivial caption', () => {
    const d = routeTurn('thanks', /* hasMedia */ true);
    expect(d.intent).toBe('substantive');
    expect(d.cannedReply).toBeUndefined();
  });
});
