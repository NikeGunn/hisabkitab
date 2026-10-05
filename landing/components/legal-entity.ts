/**
 * The registered legal entity that operates HisabKitab. Single source of truth for
 * every place the site names the company (footer, legal pages, JSON-LD). Must match
 * the Certificate of Incorporation character for character: Meta Business
 * Verification compares the website against the registration documents.
 */
export const LEGAL_ENTITY = {
  name: 'Atomberg Technologies Private',
  address: '3rd Floor, Tower B, 247 Embassy Park, Lbs Marg, Vikhroli West, Mumbai, Maharashtra, India, 400083',
  streetAddress: '3rd Floor, Tower B, 247 Embassy Park, Lbs Marg, Vikhroli West',
  locality: 'Mumbai',
  region: 'Maharashtra',
  country: 'IN',
  postalCode: '400083',
  phone: '+917740573268',
  phoneHref: 'tel:+917740573268',
  email: 'hello@hisabkitab.pro',
} as const;
