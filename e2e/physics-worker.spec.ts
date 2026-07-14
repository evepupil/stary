import { expect, test } from '@playwright/test';

test('生产页面通过固定 REBOUND WASM 的完整 physics Worker 验收', async ({ page }) => {
  const browserDiagnostics: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const location = message.location();
      const source = location.url.length > 0 ? ` (${location.url})` : '';
      browserDiagnostics.push(`console.${message.type()}: ${message.text()}${source}`);
    }
  });
  page.on('pageerror', (error) => {
    browserDiagnostics.push(`pageerror: ${error.message}`);
  });

  await page.goto('/');

  await expect(page).toHaveTitle('STARY');
  await expect(page.getByRole('heading', { name: '宇宙模拟工程底座' })).toBeVisible();
  await expect(page.locator('dd[data-probe]')).toHaveCount(3);
  await expect(page.locator('dd[data-status="loading"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('dd[data-status="error"]')).toHaveCount(0);

  const workerProbe = page.locator('dd[data-probe="worker"]');
  await expect(workerProbe).toHaveAttribute('data-status', 'ready');
  await expect(workerProbe).toContainText('依次完成启动、暂停、单步推进 3600 秒');
  await expect(workerProbe).toContainText('返回 2 个天体');
  await expect(page.locator('dd[data-probe="wasm"]')).toHaveAttribute('data-status', 'ready');

  expect(browserDiagnostics, '页面存在 console warning/error 或未处理异常').toEqual([]);
});
