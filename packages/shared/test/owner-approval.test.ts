import { describe, expect, it } from 'vitest';
import { classifyOwnerApproval, isOwnerApproval } from '../src/approval/owner-approval.js';

describe('isOwnerApproval — explicit yes in English / Nepali / Romanized', () => {
  it.each([
    'yes',
    'Yes please save it',
    'ok',
    'OK 👍',
    '✅',
    'confirm',
    'go ahead',
    'looks good, save',
    'ho',
    'hajur, thik cha',
    'sahi cha',
    'save garnus',
    'हो',
    'ठिक छ, राख्नुस्',
    'हुन्छ',
    'la thik cha',
  ])('approves %j', (t) => {
    expect(isOwnerApproval(t)).toBe(true);
  });
});

describe('isOwnerApproval — adversarial probes (must NOT approve)', () => {
  it.each([
    ['', 'empty'],
    ['no', 'negation'],
    ['ok wait', 'negation'],
    ['hoina', 'negation'],
    ['yes but change the amount', 'conditional'],
    ['ok tara vendor arko ho', 'conditional'],
    ['yes 5000', 'contains_figure'],
    ['ho?', 'question'],
    ['is it saved?', 'question'],
    ["don't save it", 'negation'],
    ['नगर्नुस्', 'negation'],
    ['ठिक छैन', 'negation'],
    ['hello', 'no_affirmative'],
    [
      'this bill is for my shop, the vendor is Sharma Traders and it was paid in cash yesterday ok',
      'too_long',
    ],
    ['यो ७००० हो', 'contains_figure'],
  ])('refuses %j (%s)', (t, reason) => {
    const v = classifyOwnerApproval(t);
    expect(v.approved).toBe(false);
    if (!v.approved) expect(v.reason).toBe(reason);
  });

  it('a lone "k" (Romanized "what") is not a yes', () => {
    expect(isOwnerApproval('k')).toBe(false);
  });
});

describe('fuzz: no generated message with a figure, question or negation is ever an approval', () => {
  const AFF = ['yes', 'ok', 'ho', 'हो', '✅', 'save it', 'thik cha', 'go ahead', 'confirm'];
  const POISON = [
    '5000',
    'Rs 1,130',
    '?',
    'no',
    'not',
    'hoina',
    'but',
    'change',
    'tara',
    'wait',
    'cancel',
    'नगर्नुस्',
    '७००',
  ];
  const FILL = ['please', 'it', 'the', 'bill', 'sir', 'hajur', 'dai', '🙏', 'jii', 'now'];
  // deterministic LCG so the fuzz is reproducible
  let seed = 42;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  it('2,000 adversarial combinations', () => {
    for (let i = 0; i < 2000; i += 1) {
      const words = [AFF[rnd(AFF.length)]!, POISON[rnd(POISON.length)]!];
      for (let k = rnd(4); k > 0; k -= 1)
        words.splice(rnd(words.length + 1), 0, FILL[rnd(FILL.length)]!);
      const text = words.join(' ');
      expect(isOwnerApproval(text), text).toBe(false);
    }
  });
  it('zero-width / homoglyph tricks do not turn into a yes', () => {
    expect(isOwnerApproval('y​es')).toBe(false);
    expect(isOwnerApproval('yеs')).toBe(false); // Cyrillic е
    expect(isOwnerApproval('ye5')).toBe(false);
  });
});
