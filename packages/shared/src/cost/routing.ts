/**
 * Model routing & trivial-turn short-circuit (PRD v2.0 §7 — "Cost is a feature").
 * PURE, no IO.
 *
 * The single biggest cost saver is NOT running an agent turn at all when the
 * message is trivial ("ok", "thanks", a bare 👍). Those get a canned local reply
 * — zero tokens, zero model call. Everything else routes to the full agent, and
 * `pickModel` documents the cheap-vs-money model split for substantive turns.
 *
 * SAFETY (the probe that matters): this classifier is DELIBERATELY conservative.
 * It must NEVER misroute a real bookkeeping message ("paid 5000 to ram", "vat?")
 * to the trivial path — a false "trivial" would silently swallow a money entry.
 * So: a message is trivial ONLY if, after stripping a small acknowledgement
 * vocabulary + punctuation/emoji, NOTHING substantive remains. Any digit, any
 * currency hint, any unknown word ⇒ substantive. When in doubt, run the agent.
 */

export type TurnIntent =
  | 'trivial' // ack/greeting/thanks — answer locally, no model call
  | 'substantive'; // anything that may carry bookkeeping meaning — run the agent

/** Models the orchestrator can route a turn to (the agent definition pins one;
 *  this documents the intended split for when per-turn routing is wired). */
export type RouteModel = 'cheap' | 'money';

export interface RouteDecision {
  intent: TurnIntent;
  /** Which model tier a substantive turn should use (advisory). */
  model: RouteModel;
  /** A ready-to-send reply for a trivial turn; undefined for substantive. */
  cannedReply?: string;
}

/**
 * Acknowledgement / greeting vocabulary (English + romanized + Devanagari Nepali).
 * Kept SMALL on purpose: an unknown word is treated as substantive, so we never
 * have to enumerate "all real messages" — only the safe-to-ignore pleasantries.
 */
const TRIVIAL_WORDS = new Set<string>([
  // english acks
  'ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'thankyou', 'thx', 'ty', 'tysm',
  'great', 'good', 'nice', 'cool', 'fine', 'sure', 'yes', 'yep', 'yeah', 'yup',
  'no', 'nope', 'hi', 'hello', 'hey', 'hii', 'hiii', 'namaste', 'namaskar',
  'bye', 'goodbye', 'welcome', 'perfect', 'awesome', 'understood', 'got', 'it',
  'done', 'noted', 'alright', 'right', 'sorry', 'please', 'pls', 'plz',
  'morning', 'afternoon', 'evening', 'night', 'you', 'u', 'very', 'much', 'so',
  // romanized nepali acks
  'dhanyabad', 'dhanyavad', 'huncha', 'hunchha', 'hajur', 'thik', 'thikcha',
  'thikchha', 'cha', 'chha', 'ramro', 'la', 'lai', 'hola', 'ho', 'hoina',
  // devanagari nepali acks
  'धन्यवाद', 'नमस्ते', 'नमस्कार', 'हुन्छ', 'हजुर', 'ठिक', 'ठीक', 'राम्रो',
  'हो', 'होइन', 'ल', 'सुभप्रभात', 'छ', 'छैन', 'धेरै',
]);

/** Strip emoji, punctuation, and symbols, leaving words + digits + spaces. */
function stripDecoration(text: string): string {
  // Keep letters (\p{L}), combining marks (\p{M} — Devanagari matras, or words like
  // धन्यवाद shatter at every vowel sign), and numbers (\p{N}); everything else → space.
  return text.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
}

/** A token that signals real bookkeeping content ⇒ NEVER trivial. */
function looksSubstantive(token: string): boolean {
  // any digit anywhere is a hard substantive signal (amounts, dates, quantities)
  if (/\p{N}/u.test(token)) return true;
  return !TRIVIAL_WORDS.has(token);
}

/**
 * Classify a turn. `text` is the owner's message (caption excluded media is
 * handled by the caller — any attached media is ALWAYS substantive).
 */
export function classifyTurn(text: string | undefined): TurnIntent {
  const raw = (text ?? '').trim();
  if (!raw) return 'substantive'; // empty/odd → let the agent handle it safely

  const cleaned = stripDecoration(raw).toLowerCase().trim();
  if (!cleaned) {
    // Pure emoji/punctuation (e.g. a lone 👍). Treat as a trivial ack.
    return 'trivial';
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  // A long message is almost certainly a real request even if every word is an
  // ack-like token — cap trivial at a short utterance.
  if (tokens.length > 4) return 'substantive';

  for (const tok of tokens) {
    if (looksSubstantive(tok)) return 'substantive';
  }
  return 'trivial';
}

/** Pick the model tier for an intent (trivial never reaches a model; defensive). */
export function pickModel(intent: TurnIntent): RouteModel {
  return intent === 'trivial' ? 'cheap' : 'money';
}

/** Friendly canned reply for a trivial turn (no model call). */
export const TRIVIAL_REPLY = 'You are welcome! 🙏 Send me a bill photo or tell me a sale/expense whenever you are ready.';

/**
 * One-shot router: returns the intent, the advisory model tier, and (for trivial)
 * a ready-to-send reply so the caller can answer without starting an agent turn.
 * `hasMedia` forces substantive — an attached bill must always reach the agent.
 */
export function routeTurn(text: string | undefined, hasMedia = false): RouteDecision {
  const intent = hasMedia ? 'substantive' : classifyTurn(text);
  if (intent === 'trivial') {
    return { intent, model: 'cheap', cannedReply: TRIVIAL_REPLY };
  }
  return { intent, model: pickModel(intent) };
}
