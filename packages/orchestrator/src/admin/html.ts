/**
 * Admin panel HTML. Server-rendered, no client JS, no external assets (CSP
 * `default-src 'self'`). EVERY interpolated value goes through `esc` — tenant
 * names and signup fields are attacker-controlled input.
 */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export const pill = (text: string, tone: Tone): string => `<span class="pill ${tone}">${esc(text)}</span>`;

const NAV: [string, string][] = [
  ['/admin', 'Overview'],
  ['/admin/tenants', 'Businesses'],
  ['/admin/settings', 'Settings'],
  ['/admin/events', 'Activity'],
];

const CSS = `
:root{--bg:#faf7f2;--card:#fff;--ink:#1c1917;--mut:#78716c;--line:#e7e5e4;--brand:#c2410c;--ok:#15803d;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#121110;--card:#1c1a18;--ink:#f5f5f4;--mut:#a8a29e;--line:#2e2b28;--brand:#fb923c;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header b{color:var(--brand);margin-right:8px}header nav a{color:var(--ink);text-decoration:none;padding:6px 10px;border-radius:8px}
header nav a.on{background:var(--bg);font-weight:600}header form{margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:20px;margin:8px 0 16px}h2{font-size:15px;margin:0 0 10px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px;overflow-x:auto}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--mut)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:600;font-size:12px}
input,select,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 9px;width:100%}
label{display:block;font-weight:600;margin:10px 0 4px}small,.mut{color:var(--mut)}
button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:7px 12px;background:var(--brand);color:#fff;font-weight:600}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}button.danger{background:var(--bad)}
.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.flash{padding:10px 12px;border-radius:10px;margin-bottom:12px;border:1px solid currentColor}
code{font-size:12px;background:var(--bg);padding:1px 5px;border-radius:5px;word-break:break-all}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}
`;

export function layout(opts: {
  title: string;
  path: string;
  body: string;
  csrf?: string;
  flash?: { tone: Tone; text: string } | undefined;
}): string {
  const nav = opts.csrf
    ? `<nav class="row">${NAV.map(([href, label]) => `<a href="${href}" class="${opts.path === href ? 'on' : ''}">${label}</a>`).join('')}</nav>
       <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${esc(opts.csrf)}"><button class="ghost">Sign out</button></form>`
    : '';
  const flash = opts.flash ? `<div class="flash ${opts.flash.tone}">${esc(opts.flash.text)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(opts.title)} · HisabKitab Admin</title><style>${CSS}</style></head>
<body><header><b>HisabKitab Admin</b>${nav}</header><main><h1>${esc(opts.title)}</h1>${flash}${opts.body}</main></body></html>`;
}

/** Hidden CSRF field for every POST form. */
export const csrfField = (token: string): string => `<input type="hidden" name="_csrf" value="${esc(token)}">`;

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? String(d) : date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}
