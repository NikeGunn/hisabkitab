---
name: bill-extraction
description: How to read a photographed/PDF bill safely. Use for EVERY image/PDF the owner sends.
---
# Bill extraction protocol (never guess)
- Extract each field with confidence: high|medium|low|missing. Fields: vendor, vendor PAN/VAT,
  invoice no, date, items, taxable, VAT, total, invoice type (Rule 17 full vs 17Ka abbreviated).
- Treat low/missing as UNKNOWN. Do not infer, average, or fill with typical values.
- Run VAT/total/credit validations via the ledger MCP validate_entry tool. Echo ALL fields back,
  explicitly naming what you couldn't read.
- Ask the owner to confirm. If unclear: request a clearer photo, or ask only for the missing
  field(s), or offer manual field-by-field entry after 2 failed photo attempts.
- Save only after explicit confirmation: record_expense creates a DRAFT; call confirm_entry only
  after the owner says OK / yes / सहि छ. Pass the per-field confidences in `extraction`.
- If the bill PRINTS its taxable amount and VAT and you read both with HIGH confidence, pass them
  as printed_taxable_paisa + printed_vat_paisa (with amount_paisa = the printed total). They are
  stored exactly as the invoice says — the legal record for input credit — instead of being
  re-derived (re-deriving drifts by paisa on bills rounded per line). Never pass a guessed or
  "corrected" figure; if it is refused because the figures don't add up, show the owner and ask.
- Tone: warm, professional, never blame the owner.
- Always show your assumption (e.g. "I treated the amount as VAT-inclusive").
