// Renders the dependency dashboard (one GitHub issue) from:
//   argv[2] root `pnpm outdated -r --format json`
//   argv[3] landing `pnpm outdated --format json`
//   argv[4] OSV-Scanner `--format json` output (may be missing/empty if the scan failed)
// Prints markdown to stdout; writes `vulns=<n>` and `majors=<n>` to $GITHUB_OUTPUT.
// Dependabot ignores npm MAJOR bumps (they are planned migrations, not bot PRs), and
// `ignore` also suppresses security updates, so this report is the safety net that
// surfaces both available majors and any vulnerability already on main.
import { readFileSync, appendFileSync } from 'node:fs';

const readJson = (path) => {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const major = (v) => {
  const [maj, min] = String(v)
    .replace(/^[^\d]*/, '')
    .split('.')
    .map(Number);
  // 0.x: a "minor" is breaking under semver, so treat 0.MINOR as the major line.
  return maj === 0 ? `0.${min}` : String(maj);
};

const majorsOf = (outdated, where) =>
  Object.entries(outdated ?? {})
    .filter(([, d]) => d.current && d.latest && major(d.current) !== major(d.latest))
    .map(([name, d]) => ({
      name,
      where,
      current: d.current,
      latest: d.latest,
      type: d.dependencyType,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

const majors = [
  ...majorsOf(readJson(process.argv[2]), 'root'),
  ...majorsOf(readJson(process.argv[3]), 'landing'),
];

const osv = readJson(process.argv[4]);
const vulns = [];
for (const result of osv?.results ?? []) {
  for (const pkg of result.packages ?? []) {
    for (const v of pkg.vulnerabilities ?? []) {
      vulns.push({
        id: v.id,
        name: pkg.package?.name,
        version: pkg.package?.version,
        file: (result.source?.path ?? '').split(/[\\/]/).slice(-2).join('/'),
        summary: (v.summary ?? '').replace(/\|/g, '/').slice(0, 90),
      });
    }
  }
}

const out = [];
out.push('<!-- deps-dashboard -->');
out.push(
  `_Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`deps-dashboard.yml\`._`,
  '',
);
out.push(
  `## ${!osv ? '⚠️' : vulns.length ? '🔴' : '🟢'} Known vulnerabilities on main: ${osv ? vulns.length : 'scan unavailable'}`,
  '',
);
if (!osv)
  out.push(
    'OSV scan did not produce results this run (BLOCKED, not PASS). Re-run the workflow.',
    '',
  );
else if (vulns.length) {
  out.push(
    'Fix: bump the parent, or add a same-major `pnpm.overrides` entry (root or `landing/package.json`).',
    '',
  );
  out.push('| Advisory | Package | Version | Lockfile | Summary |', '|---|---|---|---|---|');
  for (const v of vulns)
    out.push(
      `| [${v.id}](https://osv.dev/${v.id}) | ${v.name} | ${v.version} | ${v.file} | ${v.summary} |`,
    );
  out.push('');
} else
  out.push(
    'None. Root and landing lockfiles are clean against OSV (includes GitHub advisories).',
    '',
  );

out.push(`## Major upgrades available: ${majors.length}`, '');
out.push(
  'Dependabot does not open PRs for majors. Upgrade them deliberately: one PR per migration, verified at runtime.',
  '',
);
if (majors.length) {
  out.push('| Package | Where | Current | Latest | Type |', '|---|---|---|---|---|');
  for (const m of majors)
    out.push(`| \`${m.name}\` | ${m.where} | ${m.current} | **${m.latest}** | ${m.type} |`);
}

console.log(out.join('\n'));
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `vulns=${osv ? vulns.length : -1}\nmajors=${majors.length}\n`,
  );
}
