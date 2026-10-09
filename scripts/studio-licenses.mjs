// Writes dist/THIRD_PARTY_LICENSES.txt for the Studio bundle. The minified
// bundle drops license comments, but the MIT licenses of the bundled packages
// require their notices to travel with redistributed copies. Run from apps/studio.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Packages whose code ends up in dist/ (JS: React runtime; CSS: Tailwind preflight/utilities).
const BUNDLED = [
  ['react', null],
  ['react-dom', null],
  ['scheduler', 'react-dom'],
  ['tailwindcss', null],
];

/** Resolves a package directory from the Studio, or from another package's location. */
function packageDir(name, via) {
  const from = via
    ? path.join(packageDir(via, null), 'package.json')
    : path.resolve('package.json');
  return path.dirname(createRequire(from).resolve(`${name}/package.json`));
}

const sections = [];
for (const [name, via] of BUNDLED) {
  const dir = packageDir(name, via);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (!licenseFile) {
    console.error(`studio-licenses: no license file in ${name}`);
    process.exit(1);
  }
  const text = readFileSync(path.join(dir, licenseFile), 'utf8').trim();
  sections.push(`${pkg.name}@${pkg.version} (${pkg.license})\n${'-'.repeat(60)}\n${text}\n`);
}
writeFileSync(
  path.join('dist', 'THIRD_PARTY_LICENSES.txt'),
  `TokenFault Studio bundles the following third-party packages.\n\n${sections.join('\n')}`,
);
