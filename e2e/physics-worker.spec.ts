import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const EARTH_ORBIT_PERIOD_SECONDS = 31_558_103;
const OBSERVATORY_VERTICAL_FOV_DEGREES = 42;
const OBSERVATORY_SCENE_HALF_EXTENT = 10;
const OBSERVATORY_CAMERA_PADDING = 1.12;

function collectBrowserDiagnostics(page: Page): string[] {
  const diagnostics: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const location = message.location();
      const source = location.url.length > 0 ? ` (${location.url})` : '';
      diagnostics.push(`console.${message.type()}: ${message.text()}${source}`);
    }
  });
  page.on('pageerror', (error) => {
    diagnostics.push(`pageerror: ${error.message}`);
  });
  return diagnostics;
}

async function expectRenderedCanvas(page: Page) {
  const canvas = page.locator('canvas[data-renderer-backend]');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width ?? 0).toBeGreaterThan(300);
  expect(canvasBox?.height ?? 0).toBeGreaterThan(300);

  const screenshot = PNG.sync.read(await canvas.screenshot({ animations: 'disabled' }));
  const simulationTimeSeconds = Number(
    await page.locator('main.observatory-shell').getAttribute('data-simulation-time-seconds'),
  );
  const projection = computeObservatoryProjection(screenshot.width, screenshot.height);
  const earthCenter = computeEarthScreenPosition(projection, simulationTimeSeconds);
  const orbitBandHalfWidthPixels = Math.max(2, Math.ceil(projection.orbitRadiusPixels * 0.01));
  const markerExclusionRadiusPixels = 28;
  const startX = Math.floor(screenshot.width * 0.15);
  const endX = Math.ceil(screenshot.width * 0.85);
  const startY = Math.floor(screenshot.height * 0.15);
  const endY = Math.ceil(screenshot.height * 0.78);
  let tealOrbitPixelCount = 0;
  const tealOrbitPixelsByQuadrant = [0, 0, 0, 0];
  let visiblePixelCount = 0;

  for (let y = 0; y < screenshot.height; y += 1) {
    for (let x = 0; x < screenshot.width; x += 1) {
      const index = (y * screenshot.width + x) * 4;
      const red = screenshot.data[index] ?? 0;
      const green = screenshot.data[index + 1] ?? 0;
      const blue = screenshot.data[index + 2] ?? 0;
      const distanceFromBackground = Math.abs(red - 3) + Math.abs(green - 5) + Math.abs(blue - 6);
      if (
        x >= startX &&
        x < endX &&
        y >= startY &&
        y < endY &&
        distanceFromBackground > 18 &&
        (screenshot.data[index + 3] ?? 0) > 0
      ) {
        visiblePixelCount += 1;
      }

      const distanceFromCanvasCenter = Math.hypot(x - projection.centerX, y - projection.centerY);
      const distanceFromEarthMarker = Math.hypot(x - earthCenter.x, y - earthCenter.y);
      const insideExpectedOrbitBand =
        Math.abs(distanceFromCanvasCenter - projection.orbitRadiusPixels) <=
        orbitBandHalfWidthPixels;
      const outsidePositionMarkers =
        distanceFromCanvasCenter > markerExclusionRadiusPixels &&
        distanceFromEarthMarker > markerExclusionRadiusPixels;
      if (
        insideExpectedOrbitBand &&
        outsidePositionMarkers &&
        green >= 45 &&
        green - red >= 18 &&
        green - blue >= 5
      ) {
        tealOrbitPixelCount += 1;
        const quadrant = (y >= projection.centerY ? 2 : 0) + (x >= projection.centerX ? 1 : 0);
        tealOrbitPixelsByQuadrant[quadrant] = (tealOrbitPixelsByQuadrant[quadrant] ?? 0) + 1;
      }
    }
  }

  expect(visiblePixelCount).toBeGreaterThan(96);
  expect(tealOrbitPixelCount, '预期轨道环带缺少青绿色轨道像素').toBeGreaterThan(
    Math.ceil(projection.orbitRadiusPixels),
  );
  for (const [quadrant, pixelCount] of tealOrbitPixelsByQuadrant.entries()) {
    expect(pixelCount, `预期轨道第 ${String(quadrant + 1)} 象限缺少青绿色像素`).toBeGreaterThan(
      Math.ceil(projection.orbitRadiusPixels * 0.15),
    );
  }
}

async function expectInitializedRendererBackend(page: Page): Promise<void> {
  const canvas = page.locator('canvas[data-renderer-backend]');
  const initializedBackend = await canvas.getAttribute('data-renderer-backend');
  expect(['webgpu', 'webgl2']).toContain(initializedBackend);
  const webGpuDeviceAvailable = await page.evaluate(async () => {
    const gpu = Reflect.get(navigator, 'gpu') as
      | {
          requestAdapter(): Promise<{
            requestDevice(): Promise<{ destroy(): void }>;
          } | null>;
        }
      | undefined;
    if (gpu === undefined) {
      return false;
    }
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter === null) {
        return false;
      }
      const device = await adapter.requestDevice();
      device.destroy();
      return true;
    } catch {
      return false;
    }
  });

  if (webGpuDeviceAvailable) {
    await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgpu');
  }

  if (initializedBackend === 'webgpu') {
    await expect(page.getByText('WEBGPU', { exact: true })).toBeVisible();
  } else {
    await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgl2');
    await expect(page.getByText('WEBGL2', { exact: true })).toBeVisible();
  }
}

interface ObservatoryProjection {
  readonly centerX: number;
  readonly centerY: number;
  readonly orbitRadiusPixels: number;
}

function computeObservatoryProjection(width: number, height: number): ObservatoryProjection {
  const aspect = width / height;
  const tangent = Math.tan((OBSERVATORY_VERTICAL_FOV_DEGREES * Math.PI) / 360);
  const paddedExtent = OBSERVATORY_SCENE_HALF_EXTENT * OBSERVATORY_CAMERA_PADDING;
  const cameraDistance = Math.max(paddedExtent / tangent, paddedExtent / (tangent * aspect));
  const pixelsPerSceneUnit = height / (2 * cameraDistance * tangent);
  return {
    centerX: width / 2,
    centerY: height / 2,
    orbitRadiusPixels: OBSERVATORY_SCENE_HALF_EXTENT * pixelsPerSceneUnit,
  };
}

function computeEarthScreenPosition(
  projection: ObservatoryProjection,
  simulationTimeSeconds: number,
): { readonly x: number; readonly y: number } {
  const orbitAngle = (simulationTimeSeconds / EARTH_ORBIT_PERIOD_SECONDS) * Math.PI * 2;
  return {
    x: projection.centerX + projection.orbitRadiusPixels * Math.cos(orbitAngle),
    y: projection.centerY - projection.orbitRadiusPixels * Math.sin(orbitAngle),
  };
}

async function clickEarthHitTarget(page: Page, simulationTimeSeconds: number): Promise<void> {
  const canvas = page.locator('canvas[data-renderer-backend]');
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox === null) {
    return;
  }

  const earthCenter = computeEarthScreenPosition(
    computeObservatoryProjection(canvasBox.width, canvasBox.height),
    simulationTimeSeconds,
  );

  await canvas.click({
    position: {
      x: earthCenter.x + 12,
      y: earthCenter.y,
    },
  });
}

test('生产观测台渲染真实 Worker 状态并完成时间控制', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);

  await page.goto('/');

  await expect(page).toHaveTitle('STARY');
  await expect(page.locator('main.observatory-shell')).toBeVisible();
  await expect(page.getByText('STARY', { exact: true })).toBeVisible();
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('地球', { exact: true }).first()).toBeVisible();
  await expectRenderedCanvas(page);
  await expectInitializedRendererBackend(page);

  await page.getByRole('button', { name: '暂停模拟' }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  const observatory = page.locator('main.observatory-shell');
  const timeBeforeStep = Number(await observatory.getAttribute('data-simulation-time-seconds'));

  await page.getByRole('button', { name: '太阳 G2V 恒星 追踪' }).click();
  await expect(page.getByRole('heading', { name: '太阳' })).toBeVisible();
  await clickEarthHitTarget(page, timeBeforeStep);
  await expect(page.getByRole('heading', { name: '地球' })).toBeVisible();

  await page.getByRole('button', { name: '单步推进一小时' }).click();
  await expect(observatory).not.toHaveAttribute(
    'data-simulation-time-seconds',
    String(timeBeforeStep),
  );
  const timeAfterStep = Number(await observatory.getAttribute('data-simulation-time-seconds'));
  expect(timeAfterStep - timeBeforeStep).toBeCloseTo(3_600, 8);
  await expect(page.getByText('模拟已暂停')).toBeVisible();

  await page.getByLabel('时间倍率').selectOption('3600');
  await expect(page.getByLabel('时间倍率')).toHaveValue('3600');
  await expect(page.locator('.time-controls output')).toHaveText('3,600×');

  await page.getByRole('button', { name: '开始模拟' }).click();
  await expect(page.getByText('模拟运行中')).toBeVisible();
  await expect(page.getByText('相对漂移', { exact: false }).first()).toBeVisible();

  expect(browserDiagnostics, '页面存在 console warning/error 或未处理异常').toEqual([]);
});

test('手机视口保留画布、时间控制和可切换数据抽屉', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/');

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expectRenderedCanvas(page);

  await page.getByRole('button', { exact: true, name: '天体目录' }).click();
  const bodyPanel = page.locator('aside[aria-label="天体目录"]');
  await expect(bodyPanel).toHaveAttribute('data-mobile-open', 'true');
  await expect(bodyPanel.getByText('地球', { exact: true })).toBeVisible();

  await page.getByRole('button', { exact: true, name: '天体数据' }).click();
  const inspectorPanel = page.locator('aside[aria-label="天体数据"]');
  await expect(inspectorPanel).toHaveAttribute('data-mobile-open', 'true');
  await expect(inspectorPanel.getByRole('heading', { name: '地球' })).toBeVisible();

  const layout = await page.evaluate(() => {
    const controls = document.querySelector<HTMLElement>('.time-controls');
    const tabs = document.querySelector<HTMLElement>('.mobile-panel-tabs');
    if (controls === null || tabs === null) {
      throw new Error('手机控制区域缺失');
    }
    const controlsBox = controls.getBoundingClientRect();
    const tabsBox = tabs.getBoundingClientRect();
    return {
      controlsBottom: controlsBox.bottom,
      controlsLeft: controlsBox.left,
      controlsRight: controlsBox.right,
      scrollTop: document.scrollingElement?.scrollTop ?? 0,
      tabsBottom: tabsBox.bottom,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.controlsLeft).toBeGreaterThanOrEqual(0);
  expect(layout.controlsRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.controlsBottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.tabsBottom).toBeLessThan(layout.controlsBottom);
  expect(layout.scrollTop).toBe(0);

  expect(browserDiagnostics, '手机页面存在 console warning/error 或未处理异常').toEqual([]);
});

test('WebGPU 不可用时真实回退到 WebGL2 观测场景', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expectRenderedCanvas(page);
  await expect(page.locator('canvas[data-renderer-backend]')).toHaveAttribute(
    'data-renderer-backend',
    'webgl2',
  );
  await expect(page.getByText('WEBGL2', { exact: true })).toBeVisible();

  expect(browserDiagnostics, 'WebGL2 回退存在 console warning/error 或未处理异常').toEqual([]);
});
