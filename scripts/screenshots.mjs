// Regenerates the README screenshots in docs/assets from the real Studio.
//
// Usage: pnpm build && node scripts/screenshots.mjs
// Starts the embedded mock and a proxy on loopback, signs in to the Studio with
// the per-run control token, runs real scenarios and captures 1440×860 PNGs.
// Nothing leaves the machine; no API key is used.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startMockLlm } from '../packages/mock-llm/dist/index.js';
import { createTokenFaultServer } from '../packages/proxy/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'docs', 'assets');

const mock = await startMockLlm({ port: 0 });
const server = createTokenFaultServer({
  target: mock.url,
  port: 0,
  studioDir: path.join(ROOT, 'apps', 'studio', 'dist'),
});
const url = await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await page.goto(`${url}/__tokenfault/studio/`);
  await page.getByTestId('control-token').fill(server.controlToken);
  await page.getByTestId('sign-in').click();
  await page.getByRole('status').filter({ hasText: 'Live' }).waitFor();

  // 1. Inspector on a jittered stream, with an event selected.
  await page.getByRole('link', { name: 'Fault Lab' }).first().click();
  await page.getByTestId('run-irregular-timing').click();
  await page.getByTestId('session-outcome').filter({ hasText: 'completed' }).waitFor({
    timeout: 30_000,
  });
  // The list is virtualised; select event #14 from the keyboard.
  await page.getByRole('listbox', { name: 'SSE events' }).focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowDown');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(OUT, 'studio-inspector.png') });

  // 2. A mid-stream disconnect, with the fault annotations tab open.
  await page.getByRole('link', { name: 'Fault Lab' }).first().click();
  await page.getByTestId('run-mid-stream-disconnect').click();
  await page.getByTestId('session-outcome').filter({ hasText: 'incomplete' }).waitFor({
    timeout: 30_000,
  });
  await page.getByRole('tab', { name: /^Faults/ }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(OUT, 'studio-disconnect.png') });

  // 3. Fault Lab.
  await page.getByRole('link', { name: 'Fault Lab' }).first().click();
  await page.getByRole('heading', { level: 1, name: 'Fault Lab' }).waitFor({ state: 'attached' });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(OUT, 'studio-fault-lab.png') });
  console.log(`screenshots written to ${OUT}`);
} finally {
  await browser.close();
  await server.close();
  await mock.close();
}
