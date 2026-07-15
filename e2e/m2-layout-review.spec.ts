import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

interface Box {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface Viewport {
  readonly height: number;
  readonly width: number;
}

interface VisualCameraState {
  readonly transitionActive: boolean;
}

interface VisualOriginState {
  readonly bodyId: string | null;
}

const screenshotDirectory = path.join(tmpdir(), 'stary-m2-layout-review');
const screenshots = {
  desktopEarth: path.join(screenshotDirectory, 'desktop-1280x720-earth.png'),
  desktopOverview: path.join(screenshotDirectory, 'desktop-1440x900-overview.png'),
  mobileBlackHole: path.join(screenshotDirectory, 'mobile-390x844-webgl2-black-hole.png'),
} as const;

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
});

function collectBrowserDiagnostics(page: Page): string[] {
  const diagnostics: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    diagnostics.push(`pageerror: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    diagnostics.push(
      `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`,
    );
  });

  return diagnostics;
}

async function readBox(locator: Locator, description: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${description} 缺少可见布局边界`).not.toBeNull();
  if (box === null) {
    throw new Error(`${description} 缺少可见布局边界`);
  }
  return box;
}

function expectInsideViewport(box: Box, viewport: Viewport, description: string): void {
  expect(box.x, `${description} 左侧超出视口`).toBeGreaterThanOrEqual(-0.5);
  expect(box.y, `${description} 顶部超出视口`).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, `${description} 右侧超出视口`).toBeLessThanOrEqual(
    viewport.width + 0.5,
  );
  expect(box.y + box.height, `${description} 底部超出视口`).toBeLessThanOrEqual(
    viewport.height + 0.5,
  );
}

function expectNoOverlap(left: Box, right: Box, description: string): void {
  const overlapWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  expect(overlapWidth * overlapHeight, `${description} 存在遮挡`).toBeLessThanOrEqual(0.5);
}

async function expectNoErrorOverlay(page: Page): Promise<void> {
  await expect(page.locator('.error-notice')).toHaveCount(0);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
  await expect(page.locator('[data-nextjs-dialog-overlay]')).toHaveCount(0);
}

async function readJsonAttribute<T>(locator: Locator, name: string): Promise<T> {
  const serialized = await locator.getAttribute(name);
  if (serialized === null) {
    throw new Error(`元素缺少 ${name}`);
  }
  return JSON.parse(serialized) as T;
}

async function waitForFocusedBody(canvas: Locator, bodyId: string): Promise<void> {
  await expect
    .poll(async () => {
      const camera = await readJsonAttribute<VisualCameraState>(canvas, 'data-visual-camera-state');
      const origin = await readJsonAttribute<VisualOriginState>(canvas, 'data-visual-origin-state');
      return { bodyId: origin.bodyId, transitionActive: camera.transitionActive };
    })
    .toEqual({ bodyId, transitionActive: false });
}

async function expectReadyObservatory(page: Page): Promise<{
  readonly canvas: Locator;
  readonly observatory: Locator;
}> {
  const observatory = page.locator('main.observatory-shell');
  const canvas = page.locator('canvas[data-renderer-backend]');

  await expect(observatory).toBeVisible();
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-render-frame-count')))
    .toBeGreaterThan(5);

  return { canvas, observatory };
}

async function expectDesktopLayout(page: Page, viewport: Viewport): Promise<void> {
  const header = await readBox(page.locator('.observatory-header'), '桌面顶栏');
  const modeSwitcher = await readBox(page.locator('.mode-switcher'), '模式切换');
  const directory = await readBox(
    page.getByRole('complementary', { name: '天体目录' }),
    '天体目录',
  );
  const inspector = await readBox(
    page.getByRole('complementary', { name: '天体数据' }),
    '天体数据',
  );
  const timeControls = await readBox(page.locator('.time-controls'), '时间条');

  for (const [description, box] of [
    ['桌面顶栏', header],
    ['模式切换', modeSwitcher],
    ['天体目录', directory],
    ['天体数据', inspector],
    ['时间条', timeControls],
  ] as const) {
    expectInsideViewport(box, viewport, description);
  }

  expectNoOverlap(directory, inspector, '左右桌面面板');
  expectNoOverlap(directory, timeControls, '天体目录与时间条');
  expectNoOverlap(inspector, timeControls, '天体数据与时间条');
  expectNoOverlap(header, timeControls, '桌面顶栏与时间条');
}

async function expectSettledMobilePanel(panel: Locator): Promise<void> {
  await expect(panel).toHaveAttribute('data-mobile-open', 'true');
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const style = getComputedStyle(element);
        const transform =
          style.transform === 'none' ? null : new DOMMatrixReadOnly(style.transform);
        return Number(style.opacity) === 1 && Math.abs(transform?.m42 ?? 0) < 0.1;
      }),
    )
    .toBe(true);
}

async function expectMobileLayout(page: Page, viewport: Viewport): Promise<void> {
  const header = await readBox(page.locator('.observatory-header'), '手机顶栏');
  const modeSwitcher = await readBox(page.locator('.mode-switcher'), '手机模式切换');
  const inspector = await readBox(
    page.getByRole('complementary', { name: '天体数据' }),
    '手机天体数据抽屉',
  );
  const tabs = await readBox(
    page.getByRole('navigation', { name: '手机端数据面板' }),
    '手机面板标签',
  );
  const timeControls = await readBox(page.locator('.time-controls'), '手机时间条');

  for (const [description, box] of [
    ['手机顶栏', header],
    ['手机模式切换', modeSwitcher],
    ['手机天体数据抽屉', inspector],
    ['手机面板标签', tabs],
    ['手机时间条', timeControls],
  ] as const) {
    expectInsideViewport(box, viewport, description);
  }

  expect(inspector.y + inspector.height, '数据抽屉应位于手机面板标签上方').toBeLessThanOrEqual(
    tabs.y + 0.5,
  );
  expect(tabs.y + tabs.height, '手机面板标签应位于时间条上方').toBeLessThan(timeControls.y);
  expectNoOverlap(inspector, tabs, '手机数据抽屉与面板标签');
  expectNoOverlap(tabs, timeControls, '手机面板标签与时间条');
  expectNoOverlap(header, inspector, '手机顶栏与数据抽屉');
}

async function createBlackHole(page: Page): Promise<string> {
  const observatory = page.locator('main.observatory-shell');
  const canvas = page.locator('canvas[data-renderer-backend]');

  await page.getByRole('button', { name: '创造', exact: true }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expect(observatory).toHaveAttribute('data-creation-phase', 'placing');
  await page.getByRole('radio', { name: '黑洞 5 倍太阳质量黑洞' }).click();

  const bounds = await readBox(canvas, '黑洞创建画布');
  const start = {
    x: bounds.x + bounds.width * 0.64,
    y: bounds.y + bounds.height * 0.44,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - Math.min(76, bounds.height * 0.1), { steps: 8 });
  await page.mouse.up();

  await expect(canvas).toHaveAttribute('data-creation-stage', 'placed');
  await expect
    .poll(async () => await canvas.getAttribute('data-creation-preview-risk'), {
      timeout: 30_000,
    })
    .toMatch(/stable|collision|escape/);
  await expect(observatory).toHaveAttribute('data-creation-phase', 'ready');
  await page.getByRole('button', { name: '确认创建', exact: true }).click();

  await expect(observatory).toHaveAttribute('data-mode', 'observe');
  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(observatory).toHaveAttribute('data-view-mode', 'focus');
  return 'created-black-hole-01';
}

test('1440x900 默认后端全景布局完整且无错误覆盖层', async ({ page }) => {
  const viewport = { height: 900, width: 1_440 } as const;
  const diagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize(viewport);
  await page.goto('/?markerDiagnostics=1&visualDiagnostics=1');

  const { observatory } = await expectReadyObservatory(page);
  await expect(observatory).toHaveAttribute('data-view-mode', 'overview');
  await expectDesktopLayout(page, viewport);
  await expectNoErrorOverlay(page);
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: screenshots.desktopOverview,
  });

  expect(diagnostics, '桌面全景存在浏览器告警、异常或失败请求').toEqual([]);
});

test('1280x720 默认后端地球近景布局完整且无错误覆盖层', async ({ page }) => {
  const viewport = { height: 720, width: 1_280 } as const;
  const diagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize(viewport);
  await page.goto('/?markerDiagnostics=1&visualDiagnostics=1');

  const { canvas, observatory } = await expectReadyObservatory(page);
  await page.getByRole('button', { name: '聚焦地球', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-view-mode', 'focus');
  await waitForFocusedBody(canvas, 'earth');
  await expect(
    page.getByRole('complementary', { name: '天体数据' }).getByRole('heading', {
      name: '地球',
      exact: true,
    }),
  ).toBeVisible();
  await expectDesktopLayout(page, viewport);
  await expectNoErrorOverlay(page);
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: screenshots.desktopEarth,
  });

  expect(diagnostics, '桌面地球近景存在浏览器告警、异常或失败请求').toEqual([]);
});

test('390x844 WebGL2 地球与黑洞近景保留可用手机抽屉', async ({ page }) => {
  const viewport = { height: 844, width: 390 } as const;
  const diagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/?markerDiagnostics=1&visualDiagnostics=1');

  const { canvas } = await expectReadyObservatory(page);
  await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgl2');

  await page.getByRole('button', { name: '天体目录', exact: true }).click();
  const directory = page.getByRole('complementary', { name: '天体目录' });
  await expectSettledMobilePanel(directory);
  await directory.getByRole('button', { name: '聚焦地球', exact: true }).click();

  const inspector = page.getByRole('complementary', { name: '天体数据' });
  await expectSettledMobilePanel(inspector);
  await waitForFocusedBody(canvas, 'earth');
  await expect(inspector.getByRole('heading', { name: '地球', exact: true })).toBeVisible();
  await expectMobileLayout(page, viewport);

  await page.getByRole('button', { name: '关闭天体数据', exact: true }).click();
  await expect(inspector).toHaveAttribute('data-mobile-open', 'false');
  const blackHoleId = await createBlackHole(page);
  await waitForFocusedBody(canvas, blackHoleId);

  await page.getByRole('button', { name: '天体数据', exact: true }).click();
  await expectSettledMobilePanel(inspector);
  await expect(inspector.getByRole('heading', { name: '黑洞 01', exact: true })).toBeVisible();
  await expectMobileLayout(page, viewport);
  await expectNoErrorOverlay(page);
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: screenshots.mobileBlackHole,
  });

  expect(diagnostics, '手机 WebGL2 近景存在浏览器告警、异常或失败请求').toEqual([]);
});
