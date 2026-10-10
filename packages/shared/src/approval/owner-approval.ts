/**
 * Is this inbound owner message an explicit "yes, save it"?
 *
 * The server-side half of confirm-before-save. The orchestrator runs this on the
 * owner's VERIFIED WhatsApp text (never on model output) and, on `approved`, writes
 * an owner_approvals row; the ledger's confirm tools refuse unless such a row
 * exists AFTER the draft was created. The model can't forge it.
 *
 * Deliberately conservative: a false "no" costs one extra "please reply YES"
 * round-trip; a false "yes" saves something the owner did not approve. So:
 *   - any negation / hold word            → not an approval ("no", "hoina", "wait")
 *   - any change / condition word         → not an approval ("yes but change…", "tara")
 *   - any digit                           → not an approval (a new figure = a correction)
 *   - a question mark                     → not an approval ("ho?" = "is it?")
 *   - long messages (> 12 tokens)         → not an approval (that's content, not a yes)
 * and at least one affirmative token/phrase must be present.
 *
 * Owners write English, Nepali and Romanized Nepali (same reason as asks-owner.ts).
 */

export type ApprovalVerdict =
  | { approved: true; matched: string }
  | {
      approved: false;
      reason:
        | 'empty'
        | 'question'
        | 'contains_figure'
        | 'too_long'
        | 'negation'
        | 'conditional'
        | 'no_affirmative';
    };

const MAX_TOKENS = 12;

// Whole tokens (after lower-casing + punctuation strip).
const NEGATION = new Set([
  'no',
  'nope',
  'nah',
  'not',
  'dont',
  "don't",
  'never',
  'wait',
  'stop',
  'cancel',
  'wrong',
  'later',
  'hold',
  'na',
  'nai',
  'nahi',
  'nehi',
  'hoina',
  'hoin',
  'haina',
  'hoena',
  'chaina',
  'chhaina',
  'chhain',
  'chain',
  'nagara',
  'nagar',
  'nagarnus',
  'nagarnuhos',
  'galat',
  'pachi',
  'paxi',
  'parkha',
  'parkhanus',
  'roka',
  'rok',
  'होइन',
  'हैन',
  'छैन',
  'नगर',
  'नगर्नु',
  'नगर्नुस्',
  'नगर्नुहोस्',
  'गलत',
  'पछि',
  'पर्ख',
  'पर्खनुस्',
  'रोक',
  'नाइँ',
  'हुँदैन',
  '❌',
  '👎',
  '✋',
]);

const CONDITIONAL = new Set([
  'but',
  'change',
  'changed',
  'instead',
  'actually',
  'except',
  'however',
  'edit',
  'fix',
  'update',
  'different',
  'rather',
  'only',
  'if',
  'unless',
  'correction',
  'modify',
  'replace',
  'remove',
  'delete',
  'tara',
  'tr',
  'badal',
  'badla',
  'badlau',
  'badalnus',
  'sachyau',
  'sachyaunus',
  'feri',
  'arko',
  'yadi',
  'तर',
  'बदल',
  'बदल्नु',
  'बदल्नुस्',
  'परिवर्तन',
  'सच्याउ',
  'सच्याउनुस्',
  'फेरि',
  'अर्को',
  'यदि',
]);

const AFFIRM_TOKENS = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'yess',
  'ya',
  'ok',
  'okay',
  'okk',
  'oky',
  'okey',
  'confirm',
  'confirmed',
  'approve',
  'approved',
  'correct',
  'right',
  'sure',
  'done',
  'save',
  'proceed',
  'fine',
  'good',
  'perfect',
  'agreed',
  'sahi',
  'sahee',
  'thik',
  'theek',
  'thikcha',
  'thikchha',
  'thikxa',
  'ho',
  'hajur',
  'hunchha',
  'huncha',
  'hunxa',
  'garnus',
  'garnuhos',
  'gara',
  'garidinus',
  'rakha',
  'rakhnus',
  'rakhidinus',
  'la',
  'hus',
  'huss',
  'hawas',
  'हो',
  'हजुर',
  'हुन्छ',
  'ठिक',
  'ठीक',
  'सहि',
  'सही',
  'गर्नुस्',
  'गर्नुहोस्',
  'गर',
  'राख',
  'राख्नुस्',
  'हस्',
  'हवस्',
  'ल',
  '✅',
  '👍',
  '👌',
  '✔',
  '✔️',
  '☑',
  '☑️',
]);

const AFFIRM_PHRASES = [
  'go ahead',
  'save it',
  'looks good',
  'all good',
  'sahi cha',
  'thik cha',
  'save garnus',
];

const tokenize = (text: string): string[] =>
  text
    .normalize('NFC')
    .toLowerCase()
    // keep letters (any script incl. Devanagari marks), apostrophes and emoji; split the rest
    .replace(/[.,!;:()"“”\-_/\\]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

export function classifyOwnerApproval(text: string): ApprovalVerdict {
  const trimmed = text.trim();
  if (!trimmed) return { approved: false, reason: 'empty' };
  if (/[?？]/.test(trimmed)) return { approved: false, reason: 'question' };
  if (/[0-9०-९]/.test(trimmed)) return { approved: false, reason: 'contains_figure' };
  const tokens = tokenize(trimmed);
  if (tokens.length > MAX_TOKENS) return { approved: false, reason: 'too_long' };
  if (tokens.some((t) => NEGATION.has(t))) return { approved: false, reason: 'negation' };
  if (tokens.some((t) => CONDITIONAL.has(t))) return { approved: false, reason: 'conditional' };
  const joined = ` ${tokens.join(' ')} `;
  const phrase = AFFIRM_PHRASES.find((p) => joined.includes(` ${p} `));
  if (phrase) return { approved: true, matched: phrase };
  const token = tokens.find((t) => AFFIRM_TOKENS.has(t));
  if (token) return { approved: true, matched: token };
  return { approved: false, reason: 'no_affirmative' };
}

export const isOwnerApproval = (text: string): boolean => classifyOwnerApproval(text).approved;

/** How long an owner's "yes" can authorize a confirm (ledger enforces the same number). */
export const OWNER_APPROVAL_WINDOW_MINUTES = 30;
