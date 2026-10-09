import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2E_CONTROL_TOKEN } from './token.js';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Fails with the rule ids and offending selectors, so a regression names its cause. */
async function expectNoViolations(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = violations.map(
    (v) =>
      `${label}: ${v.id} (${v.impact ?? 'n/a'}) → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(summary).toEqual([]);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/__tokenfault/studio/');
  await expectNoViolations(page, 'sign-in');
  // The token field has focus on load, so the token can be pasted straight away.
  await expect(page.getByTestId('control-token')).toBeFocused();
  await page.keyboard.type(E2E_CONTROL_TOKEN);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
}

test('every Studio view passes automated WCAG 2.2 AA checks', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveTitle('Overview · TokenFault Studio');
  await expectNoViolations(page, 'overview');

  await page.getByTestId('send-test-request').click();
  await expect(page.getByTestId('session-outcome')).toHaveText('completed', { timeout: 15_000 });
  await expect(page).toHaveTitle('Stream Inspector · TokenFault Studio');
  await expectNoViolations(page, 'inspector');

  // A broken stream: fault markers, termination line and fault badges must be accessible too.
  await page.getByRole('link', { name: 'Fault Lab' }).first().click();
  await page.getByTestId('run-mid-stream-disconnect').click();
  await expect(page.getByTestId('session-outcome')).toHaveText('incomplete', { timeout: 15_000 });
  await expect(page.getByTestId('session-termination')).toContainText(
    'faults injected by TokenFault',
  );
  await expect(
    page.getByRole('img', { name: /1 injected fault.*ended by fault-disconnect/ }),
  ).toBeVisible();
  await expectNoViolations(page, 'inspector (fault)');

  for (const view of ['Fault Lab', 'Replay']) {
    await page.getByRole('link', { name: view }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: view })).toBeAttached();
    await expectNoViolations(page, view);
  }
});

test('the inspector is operable from the keyboard', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('send-test-request').click();
  await expect(page.getByTestId('session-outcome')).toHaveText('completed', { timeout: 15_000 });

  // Listbox: arrow keys move the selection and aria-activedescendant follows it.
  const list = page.getByRole('listbox', { name: 'SSE events' });
  await list.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('event-seq')).toHaveText('#1');
  const active = await list.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('aria-posinset', '2');

  // Tabs: roving tabindex, arrows move between tabs and the panel is labelled by the tab.
  const events = page.getByRole('tab', { name: /^Events/ });
  await events.focus();
  await page.keyboard.press('ArrowRight');
  const network = page.getByRole('tab', { name: /^Network/ });
  await expect(network).toBeFocused();
  await expect(network).toHaveAttribute('aria-selected', 'true');
  await expect(events).toHaveAttribute('tabindex', '-1');
  await expect(page.getByRole('tabpanel', { name: /^Network/ })).toBeVisible();
  // Network chunks are a read-only list, not a selectable listbox.
  await expect(page.getByRole('list', { name: 'Network chunks' })).toBeVisible();

  // A finished session can be exported from the keyboard.
  await expect(page.getByRole('link', { name: 'Export recording' })).toBeEnabled();
});
