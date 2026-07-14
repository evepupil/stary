import { expect, test, type Locator, type Page } from '@playwright/test';

interface CameraState {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
}

function isFiniteVector(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return ['x', 'y', 'z'].every(
    (axis) => typeof record[axis] === 'number' && Number.isFinite(record[axis]),
  );
}

function isCameraState(candidate: unknown): candidate is CameraState {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return isFiniteVector(record.position) && isFiniteVector(record.target);
}

async function readCameraState(canvas: Locator): Promise<CameraState> {
  const serialized = await canvas.getAttribute('data-camera-state');
  if (serialized === null) {
    throw new Error('canvas 缺少 data-camera-state');
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!isCameraState(parsed)) {
    throw new Error('data-camera-state 无效');
  }
  return parsed;
}

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
  return diagnostics;
}

async function expectSynchronizedCreationSnapshot(observatory: Locator): Promise<void> {
  await expect(observatory).toHaveAttribute('data-mode', 'create');
  await expect(observatory).toHaveAttribute('data-creation-phase', 'placing');
  await expect
    .poll(async () => {
      const simulationTime = await observatory.getAttribute('data-simulation-time-seconds');
      const snapshotTime = await observatory.getAttribute('data-body-snapshot-time-seconds');
      return simulationTime !== null && simulationTime === snapshotTime;
    })
    .toBe(true);
}

async function placeDraft(
  page: Page,
  expectedBodyCount: number,
  expectedTrackCount = expectedBodyCount,
): Promise<void> {
  const canvas = page.locator('canvas[data-renderer-backend]');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) {
    return;
  }
  const start = {
    x: bounds.x + bounds.width * 0.64,
    y: bounds.y + bounds.height * 0.46,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - Math.min(76, bounds.height * 0.1), { steps: 8 });
  await page.mouse.up();

  await expect(canvas).toHaveAttribute('data-creation-stage', 'placed');
  await expect(canvas).toHaveAttribute(
    'data-creation-body-visual-count',
    String(expectedBodyCount),
  );
  await expect(canvas).toHaveAttribute('data-creation-velocity-arrow-visible', 'true');
  await expect
    .poll(async () => await canvas.getAttribute('data-creation-preview-risk'), {
      timeout: 30_000,
    })
    .toMatch(/stable|collision|escape/);
  await expect(canvas).toHaveAttribute(
    'data-creation-preview-track-count',
    String(expectedTrackCount),
  );
  await expect(canvas).toHaveAttribute(
    'data-creation-trajectory-visual-count',
    String(expectedTrackCount),
  );
  await expect
    .poll(async () => {
      const serialized = await canvas.getAttribute('data-creation-max-track-start-offset');
      return serialized === null ? Number.POSITIVE_INFINITY : Number(serialized);
    })
    .toBeLessThan(0.0001);
}

async function placeRockyPlanet(page: Page): Promise<void> {
  await placeDraft(page, 1);
}

test('创建草稿在确认前隔离，取消恢复运行，确认后原子加入正式模拟', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.goto('/?markerDiagnostics=1');
  const observatory = page.locator('main.observatory-shell');
  const directory = page.locator('aside[aria-label="天体目录"]');
  const canvas = page.locator('canvas[data-renderer-backend]');

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(directory.locator('[role="listitem"]')).toHaveCount(10);

  await page.getByRole('button', { name: '创造', exact: true }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expectSynchronizedCreationSnapshot(observatory);
  const frozenTime = await observatory.getAttribute('data-simulation-time-seconds');

  await placeRockyPlanet(page);
  await expect(observatory).toHaveAttribute('data-creation-phase', 'ready');
  await expect(directory.locator('[role="listitem"]')).toHaveCount(10);
  await expect(observatory).toHaveAttribute('data-body-revision', '0');
  await expect(observatory).toHaveAttribute('data-simulation-time-seconds', frozenTime ?? '');

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-mode', 'observe');
  await expect(canvas).toHaveAttribute('data-creation-active', 'false');
  await expect(page.getByText('模拟运行中')).toBeVisible();
  await expect(directory.locator('[role="listitem"]')).toHaveCount(10);

  await page.getByRole('button', { name: '创造', exact: true }).click();
  await expectSynchronizedCreationSnapshot(observatory);
  await placeRockyPlanet(page);
  await expect(observatory).toHaveAttribute('data-creation-phase', 'ready');
  await page.getByRole('button', { name: '确认创建' }).click();

  await expect(observatory).toHaveAttribute('data-mode', 'observe');
  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expect(directory.locator('[role="listitem"]')).toHaveCount(11);
  await expect(directory.getByText('岩石行星 01', { exact: true })).toBeVisible();
  await expect(observatory).toHaveAttribute('data-view-mode', 'focus');
  await expect(canvas).toHaveAttribute('data-creation-active', 'false');

  expect(browserDiagnostics, '创建流程存在 console warning/error').toEqual([]);
});

test('手机视口保留上半屏画布并完成创建确认', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/?markerDiagnostics=1');
  const observatory = page.locator('main.observatory-shell');

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '创造', exact: true }).click();
  await expectSynchronizedCreationSnapshot(observatory);

  const creationPanel = page.locator('aside[aria-label="创造工具"]');
  const panelBounds = await creationPanel.boundingBox();
  expect(panelBounds).not.toBeNull();
  if (panelBounds !== null) {
    expect(panelBounds.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(390);
    expect(panelBounds.y).toBeGreaterThan(844 * 0.38);
    expect(panelBounds.y + panelBounds.height).toBeLessThanOrEqual(844);
  }

  await placeRockyPlanet(page);
  await expect(observatory).toHaveAttribute('data-creation-phase', 'ready');
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect(observatory).toHaveAttribute('data-mode', 'observe');
  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(page.getByText('模拟已暂停')).toBeVisible();

  await page.getByRole('button', { exact: true, name: '天体目录' }).click();
  const directory = page.locator('aside[aria-label="天体目录"]');
  await expect(directory.locator('[role="listitem"]')).toHaveCount(11);
  await expect(directory.getByText('岩石行星 01', { exact: true })).toBeVisible();

  expect(browserDiagnostics, '手机创建流程存在 console warning/error').toEqual([]);
});

test('旋转相机后在 WebGL2 中创建黑洞，轨迹起点与草稿球重合', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/?markerDiagnostics=1');
  const observatory = page.locator('main.observatory-shell');
  const canvas = page.locator('canvas[data-renderer-backend]');
  const directory = page.locator('aside[aria-label="天体目录"]');

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgl2');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) {
    return;
  }
  const initialCameraState = await canvas.getAttribute('data-camera-state');
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.76, bounds.y + bounds.height * 0.78, {
    steps: 12,
  });
  await page.mouse.up();
  await expect
    .poll(async () => await canvas.getAttribute('data-camera-state'))
    .not.toBe(initialCameraState);

  await page.getByRole('button', { name: '创造', exact: true }).click();
  await expectSynchronizedCreationSnapshot(observatory);
  await expect
    .poll(async () => {
      const camera = await readCameraState(canvas);
      return Math.hypot(camera.position.x - camera.target.x, camera.position.y - camera.target.y);
    })
    .toBeLessThan(0.000001);
  await page.getByRole('radio', { name: '黑洞 5 倍太阳质量黑洞' }).click();
  await placeDraft(page, 1);
  await expect(observatory).toHaveAttribute('data-creation-phase', 'ready');
  await page.getByRole('button', { name: '确认创建' }).click();

  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(directory.locator('[role="listitem"]')).toHaveCount(11);
  await expect(directory.getByText('黑洞 01', { exact: true })).toBeVisible();
  expect(browserDiagnostics, '黑洞 WebGL2 创建流程存在 console warning/error').toEqual([]);
});

test('小行星群创建六个独立草稿和六条真实轨迹', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.goto('/?markerDiagnostics=1');
  const observatory = page.locator('main.observatory-shell');
  const directory = page.locator('aside[aria-label="天体目录"]');

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '创造', exact: true }).click();
  await expectSynchronizedCreationSnapshot(observatory);
  await page.getByRole('radio', { name: '小行星群 6 个天体' }).click();
  await placeDraft(page, 6);
  await expect(observatory).toHaveAttribute('data-creation-phase', 'ready');
  await page.getByRole('button', { name: '确认创建' }).click();

  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(directory.locator('[role="listitem"]')).toHaveCount(16);
  await expect(directory.getByText('小行星 01-01', { exact: true })).toBeVisible();
  await expect(directory.getByText('小行星 01-06', { exact: true })).toBeVisible();
  expect(browserDiagnostics, '小行星群创建流程存在 console warning/error').toEqual([]);
});
