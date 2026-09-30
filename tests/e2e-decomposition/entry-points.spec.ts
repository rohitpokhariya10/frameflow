import { expect, test } from '@playwright/test';

/**
 * The earlier generic "Image to layers" flow sits behind VITE_LEGACY_IMAGE_TO_LAYERS, and this suite runs with it on
 * (playwright.decomposition.config.ts). With the flag on, its entry points are exactly where they always were: the
 * floating button in the corner, the AI panel's "Decompose" operation, and (editor-modes.spec.ts) the "Detected
 * layers" tray. Isolated E2E stack: fake provider, no real key.
 */
test('flag on: the floating "Image to layers" button is in the corner, with the other launchers where they were', async ({ page }) => {
  await page.goto('/');
  const launchers = page.locator('.decomp-launch');
  await expect(launchers).toHaveText(['Image to layers', 'OpenAI + Seedream test', 'Create Own Template']);
  // The offsets the three buttons have always had.
  expect(await launchers.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).style.right))).toEqual(['', '160px', '388px']);
  const boxes = await launchers.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON() as { x: number; y: number; width: number }));
  // In one row, from the corner leftwards, in that order.
  expect(boxes[0].x).toBeGreaterThan(boxes[1].x);
  expect(boxes[1].x).toBeGreaterThan(boxes[2].x);
  expect(new Set(boxes.map(box => Math.round(box.y))).size).toBe(1);
  // It opens the workspace, and closing returns to the editor.
  await page.getByRole('button', { name: 'Image to layers' }).click();
  await expect(page.getByRole('heading', { name: 'Turn any image into an editable design' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Image to layers' })).toBeVisible();
});

test('flag on: the AI panel offers Generate, Adapt format and Decompose, and Decompose opens the same workspace', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const operations = page.getByRole('group', { name: 'AI operation' });
  await expect(operations.getByRole('button')).toHaveText(['Generate', 'Adapt format', 'Decompose']);
  await operations.getByRole('button', { name: 'Decompose' }).click();
  await expect(operations.getByRole('button', { name: 'Decompose' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Turn any image into an editable design' })).toBeVisible();
  await page.getByRole('button', { name: /Open image to layers/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Turn any image into an editable design' })).toBeVisible();
});
