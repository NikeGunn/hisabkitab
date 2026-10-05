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

/**
 * The Nepal company that builds HisabKitab and collects subscription payments in
 * Nepal (the Khalti merchant of record). Must match the Certificate of
 * Incorporation (Office of the Company Registrar, Reg. No. 354368/81/82) and the
 * IRD PAN certificate character for character: payment-gateway KYC compares them.
 */
export const NEPAL_COMPANY = {
  name: 'Kritrim Baudhikata Anusandhan Kendra Nepal Pvt. Ltd.',
  nameNe: 'कृत्रिम बौद्धिकता अनुसन्धान केन्द्र नेपाल प्रा. लि.',
  registrationNo: '354368/81/82',
  registrar: 'Office of the Company Registrar, Government of Nepal',
  incorporated: '27 October 2024',
  pan: '621236859',
  city: 'Kathmandu, Nepal',
  phone: '+977-9705651002',
  phoneHref: 'tel:+9779705651002',
  email: 'hello@hisabkitab.pro',
} as const;
