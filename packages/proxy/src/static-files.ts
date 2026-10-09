/**
 * Minimal static file serving for the Studio bundle (DECISIONS.md D-007).
 *
 * Path safety:
 * - The URL path is percent-decoded exactly once (by the router). NUL bytes and backslashes are rejected.
 * - The resolved path must stay inside the root directory, compared after
 *   `realpath`, so symlinks cannot escape it either.
 * - Only regular files are served. Unknown paths without an extension fall
 *   back to `index.html` (client-side routing); others return 404.
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticFile {
  readonly filePath: string;
  readonly contentType: string;
  readonly size: number;
  readonly immutable: boolean;
}

export type StaticLookup =
  | { readonly ok: true; readonly file: StaticFile }
  | { readonly ok: false; readonly status: 400 | 404 };

export class StaticRoot {
  private realRoot: string | null = null;

  constructor(readonly rootDir: string) {}

  private async root(): Promise<string> {
    this.realRoot ??= await realpath(path.resolve(this.rootDir));
    return this.realRoot;
  }

  /**
   * Resolves a URL path (relative to the mount point) to a file inside the root. The path
   * must already be percent-decoded exactly once (the router does this); it is not decoded
   * again, so `%2541` names the file `%41`.
   */
  async lookup(decoded: string): Promise<StaticLookup> {
    if (decoded.includes('\0') || decoded.includes('\\')) return { ok: false, status: 400 };
    const root = await this.root();
    const relative = decoded.replace(/^\/+/, '');
    const direct = await this.resolveFile(root, relative === '' ? 'index.html' : relative);
    if (direct) return { ok: true, file: direct };
    if (path.extname(relative) === '') {
      const index = await this.resolveFile(root, 'index.html');
      if (index) return { ok: true, file: index };
    }
    return { ok: false, status: 404 };
  }

  private async resolveFile(root: string, relative: string): Promise<StaticFile | null> {
    const candidate = path.resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      return null;
    }
    if (!real.startsWith(root + path.sep)) return null;
    const info = await stat(real);
    if (!info.isFile()) return null;
    const ext = path.extname(real).toLowerCase();
    return {
      filePath: real,
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      size: info.size,
      immutable: real.includes(`${path.sep}assets${path.sep}`),
    };
  }
}

export function openStaticFile(file: StaticFile): NodeJS.ReadableStream {
  return createReadStream(file.filePath);
}
