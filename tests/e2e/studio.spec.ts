import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2E_CONTROL_TOKEN } from './token.js';

async function signIn(page: Page, path = '/__tokenfault/studio/'): Promise<void> {
  await page.goto(path);
  await page.getByTestId('control-token').fill(E2E_CONTROL_TOKEN);
  await page.getByTestId('sign-in').click();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
}

test('the Studio requires the control token and keeps it out of browser storage', async ({
  page,
  context,
}) => {
  await page.goto('/__tokenfault/studio/');
  await page.getByTestId('control-token').fill('definitely-not-the-token-0123456789');
  await page.getByTestId('sign-in').click();
  await expect(page.getByRole('alert')).toContainText('Invalid control token');
  await page.getByTestId('control-token').fill(E2E_CONTROL_TOKEN);
  await page.getByTestId('sign-in').click();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  const storage = await page.evaluate(
    () =>
      JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie,
  );
  expect(storage).not.toContain(E2E_CONTROL_TOKEN);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'tf_session');
  expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/__tokenfault' });
  expect(page.url()).not.toContain(E2E_CONTROL_TOKEN);
});

/**
 * The v0.1 release journey, end to end:
 * mock LLM → proxy → Studio → real SSE events → event details → fault injection →
 * observed failure → recording → replay. No external API is contacted.
 */
test('inspect, break, record and replay a stream from the Studio', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  // 1–3. Open the Studio served by the proxy (which fronts the embedded mock) and sign in.
  await signIn(page);
  await page.getByRole('link', { name: 'Overview' }).first().click();
  await expect(page.getByRole('heading', { name: 'Recent sessions' })).toBeVisible();

  // 4. Send a test request through the proxy.
  await page.getByTestId('send-test-request').click();
  await expect(page).toHaveURL(/#\/inspector\/[0-9a-f-]{36}$/);

  // 5. Real streaming events appear and the stream completes.
  await expect(page.getByTestId('session-outcome')).toHaveText('completed', { timeout: 15_000 });
  const rows = page.getByTestId('event-row');
  expect(await rows.count()).toBeGreaterThan(10);

  // 6. Inspect event details (keyboard and mouse).
  const list = page.getByRole('listbox', { name: 'SSE events' });
  await list.press('Home');
  const seq = page.getByTestId('event-seq');
  await expect(seq).toHaveText('#0');
  await expect(page.getByTestId('event-detail')).toContainText('role');
  await list.press('ArrowDown');
  await list.press('ArrowDown');
  await expect(seq).toHaveText('#2');
  await expect(page.getByTestId('event-detail')).toContainText('content delta');
  await page.getByRole('option', { name: /^3 / }).click();
  await expect(seq).toHaveText('#3');
  await page.getByRole('tab', { name: 'Response' }).click();
  await expect(page.getByTestId('assembled-content')).toContainText('TokenFault mock response.');

  // 7–8. Inject a mid-stream disconnect and observe the exact failure.
  await page.getByRole('link', { name: 'Fault Lab' }).first().click();
  await page.getByTestId('run-mid-stream-disconnect').click();
  await expect(page.getByTestId('session-outcome')).toHaveText('incomplete', { timeout: 15_000 });
  await expect(page.getByTestId('session-termination')).toContainText('fault-disconnect');
  await expect(page.getByTestId('event-row')).toHaveCount(5);
  await page.getByRole('tab', { name: /Faults/ }).click();
  await expect(page.getByTestId('fault-annotations')).toContainText('after 5 events');

  // 9. Record the session (payload-free by default).
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-recording').click(),
  ]);
  const recordingPath = await download.path();
  const recording = JSON.parse(await readFile(recordingPath, 'utf8'));
  expect(recording.format).toBe('tokenfault-recording');
  expect(recording.schemaVersion).toBe(1);
  expect(recording.payloads.included).toBe(false);
  expect(recording.events).toHaveLength(5);

  // 10. Replay the recording file without contacting any model.
  await page.getByRole('link', { name: 'Replay' }).first().click();
  await page.getByRole('radio', { name: 'Speed factor' }).check();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'disconnect.tfrec.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(recording)),
  });
  await expect(page.getByText(/^replay of/)).toBeVisible();
  await expect(page.getByTestId('session-outcome')).toHaveText('incomplete', { timeout: 15_000 });
  await expect(page.getByTestId('event-row')).toHaveCount(5);

  // In-memory replay of the first (completed) session is byte-exact.
  await page.getByRole('link', { name: 'Replay' }).first().click();
  await page.getByTestId('replay-session').last().click();
  await expect(page.getByText(/^replay of/)).toBeVisible();
  await expect(page.getByTestId('session-outcome')).toHaveText('completed', { timeout: 15_000 });

  expect(consoleErrors).toEqual([]);
});

test('server-wide faults can be applied and cleared from the Fault Lab', async ({ page }) => {
  await signIn(page, '/__tokenfault/studio/#/faults');
  const card = page.getByTestId('scenario-rate-limit-429');
  await card.getByRole('button', { name: 'Apply to all requests' }).click();
  await expect(page.getByTestId('active-faults')).toContainText('rate-limit-429');
  await page.getByTestId('send-test-request').click();
  await expect(page.getByTestId('session-outcome')).toHaveText('HTTP error', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Fault Lab' }).first().click();
  await page.getByTestId('clear-faults').click();
  await expect(page.getByTestId('active-faults')).toContainText('None');
});

test('the Studio is served with a strict CSP and the API rejects cross-site writes', async ({
  page,
  request,
}) => {
  const response = await page.goto('/__tokenfault/studio/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  const crossSite = await request.delete('/__tokenfault/api/sessions', {
    headers: { origin: 'https://evil.example' },
  });
  expect(crossSite.status()).toBe(403);
});
