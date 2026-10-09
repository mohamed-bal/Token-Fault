import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findStudioDir } from '../src/meta.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Creates `<root>/<pkgDir>/dist/meta.js` and returns its file URL. */
function layout(pkgDir: string): { root: string; moduleUrl: string; pkg: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-meta-'));
  roots.push(root);
  const pkg = path.join(root, pkgDir);
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  return { root, pkg, moduleUrl: pathToFileURL(path.join(pkg, 'dist', 'meta.js')).href };
}

function studio(dir: string, packageName?: string): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html>');
  if (packageName)
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: packageName }));
}

describe('findStudioDir', () => {
  it('uses the Studio bundled inside the installed package', () => {
    const { pkg, moduleUrl } = layout('node_modules/tokenfault');
    mkdirSync(path.join(pkg, 'studio'));
    writeFileSync(path.join(pkg, 'studio', 'index.html'), '<!doctype html>');
    expect(findStudioDir(moduleUrl, {})).toBe(path.join(pkg, 'studio'));
  });

  it('never serves an unrelated apps/studio next to an install', () => {
    // <project>/node_modules/tokenfault/dist → ../../../apps/studio is <project>/apps/studio.
    const { root, moduleUrl } = layout('node_modules/tokenfault');
    studio(path.join(root, 'apps', 'studio'), 'my-company-studio');
    expect(findStudioDir(moduleUrl, {})).toBeNull();
    studio(path.join(root, 'apps', 'studio'));
    rmSync(path.join(root, 'apps', 'studio', 'package.json'));
    expect(findStudioDir(moduleUrl, {})).toBeNull();
  });

  it('falls back to the monorepo Studio build only when it is @tokenfault/studio', () => {
    const { root, moduleUrl } = layout('packages/cli');
    studio(path.join(root, 'apps', 'studio'), '@tokenfault/studio');
    expect(findStudioDir(moduleUrl, {})).toBe(path.join(root, 'apps', 'studio', 'dist'));
  });

  it('prefers TOKENFAULT_STUDIO_DIR', () => {
    const { root, moduleUrl } = layout('node_modules/tokenfault');
    const custom = path.join(root, 'custom');
    mkdirSync(custom);
    writeFileSync(path.join(custom, 'index.html'), '<!doctype html>');
    expect(findStudioDir(moduleUrl, { TOKENFAULT_STUDIO_DIR: custom })).toBe(custom);
  });
});
