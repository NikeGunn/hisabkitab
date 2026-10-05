/**
 * The registered legal entity that operates HisabKitab. Single source of truth for
 * every place the site names the company (footer, legal pages, JSON-LD). Must match
 * the Certificate of Incorporation character for character: Meta Business
 * Verification compares the website against the registration documents.
 */
export const LEGAL_ENTITY = {
  name: 'Kritrim Baudhikata Anusandhan Kendra Nepal Pvt. Ltd.',
  registrationNo: '354368/81/82',
  registrar: 'Office of the Company Registrar, Government of Nepal',
  address: 'Kirtipur Municipality, Ward No. 7, Kathmandu, Nepal',
  locality: 'Kirtipur',
  region: 'Kathmandu',
  phone: '+977-9705651002',
  phoneHref: 'tel:+9779705651002',
  email: 'hello@hisabkitab.pro',
} as const;

export const PARTNER_COMPANY = {
  name: 'Atomberg Technologies Private',
  address: '3rd Floor, Tower B, 247 Embassy Park, Lbs Marg, Vikhroli West, Mumbai, Maharashtra, India, 400083',
  phone: '+917740573268',
  phoneHref: 'tel:+917740573268',
} as const;
