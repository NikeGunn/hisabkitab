/**
 * Did the agent's message ask the owner for something (a question, or a request to
 * confirm)? ONE definition, used by the simulated owner (to decide whether to answer)
 * and by the judge (to decide whether the agent clarified before drafting).
 *
 * Owners write English, Nepali and Romanized Nepali, and so does the agent: "Shall I
 * save it?", "Kripaya confirm garnuhos", "हो भन्नुहोस्". A question mark alone misses
 * the last two — the first live baseline proved that (env-2 → env-3).
 */
const ASKS = [
  /[?？]/,
  /\b(confirm|shall i|should i|do you want|can you (confirm|tell)|please (reply|tell|let me know|check))\b/i,
  /\b(garnuhos|garnus|bhannuhos|bhannus)\b/i,
  /(गर्नुहोस्|गर्नुस्|भन्नुहोस्|भन्नुस्|पुष्टि)/,
];

export const asksOwner = (text: string): boolean => ASKS.some((re) => re.test(text));
