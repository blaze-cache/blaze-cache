/**
 * Generate a CycloneDX 1.5 SBOM from the two lockfiles — no third-party tools or
 * network access required. Run from anywhere with: node scripts/generate-sbom.mjs
 *
 * npm components come from pnpm-lock.yaml's `packages:` section (name, version,
 * integrity hash); Cargo components come from Cargo.lock's [[package]] blocks.
 * The result is written to sbom.cdx.json at the repository root.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

function npmComponents() {
  const lines = read('pnpm-lock.yaml').split(/\r?\n/);
  const out = [];
  let inPackages = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === 'packages:') {
      inPackages = true;
      continue;
    }
    // A top-level key (snapshots:, importers:, …) ends the packages section.
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;

    const match = /^ {2}(?<key>'[^']+'|[^:]+):\s*$/.exec(line);
    if (!match) continue;
    const key = match.groups.key.replace(/^'|'$/g, '');
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (version.startsWith('link:')) continue; // workspace link, not a package

    // The integrity line is within the next few indented lines of this entry.
    let integrity = '';
    for (let j = i + 1; j < Math.min(i + 6, lines.length) && /^ {4}/.test(lines[j]); j += 1) {
      const hash = /integrity:\s*sha512-([A-Za-z0-9+/=]+)/.exec(lines[j]);
      if (hash) {
        integrity = hash[1];
        break;
      }
    }
    out.push({ name, version, integrity });
  }
  return out;
}

function cargoComponents() {
  return read('Cargo.lock')
    .split(/\[\[package\]\]/)
    .slice(1)
    .map((block) => {
      const field = (key) => {
        const match = new RegExp(`^${key} = "([^"]*)"`, 'm').exec(block);
        return match ? match[1] : '';
      };
      return { name: field('name'), version: field('version'), checksum: field('checksum') };
    })
    .filter((pkg) => pkg.name);
}

const pkg = JSON.parse(read('package.json'));
const purl = `pkg:generic/${pkg.name}@${pkg.version}`;

const components = [
  ...npmComponents().map(({ name, version, integrity }) => ({
    type: 'library',
    'bom-ref': `pkg:npm/${name}@${version}`,
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
    ...(integrity
      ? { hashes: [{ alg: 'SHA-512', content: Buffer.from(integrity, 'base64').toString('hex') }] }
      : {}),
  })),
  ...cargoComponents().map(({ name, version, checksum }) => ({
    type: 'library',
    'bom-ref': `pkg:cargo/${name}@${version}`,
    name,
    version,
    purl: `pkg:cargo/${name}@${version}`,
    ...(checksum ? { hashes: [{ alg: 'SHA-256', content: checksum }] } : {}),
  })),
];

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'blaze-cache', name: 'generate-sbom.mjs', version: '1.0.0' }],
    component: { type: 'application', 'bom-ref': purl, name: pkg.name, version: pkg.version, purl },
  },
  components,
};

const out = new URL('sbom.cdx.json', root);
writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`Wrote ${out.pathname} with ${components.length} components.`);
