import { expect, test, type Locator, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

interface AppearanceDiagnostic {
  readonly id: string;
  readonly kind: string;
}

interface LodCounts {
  readonly high: number;
  readonly low: number;
  readonly medium: number;
}

interface BodyProjectionDiagnostic {
  readonly id: string;
  readonly radiusPixels: number;
  readonly x: number;
  readonly y: number;
}

interface PixelColor {
  readonly blue: number;
  readonly green: number;
  readonly red: number;
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

async function readJsonAttribute<T>(canvas: Locator, name: string): Promise<T> {
  const serialized = await canvas.getAttribute(name);
  if (serialized === null) {
    throw new Error(`画布缺少 ${name}`);
  }
  return JSON.parse(serialized) as T;
}

async function expectRenderedPixels(canvas: Locator): Promise<void> {
  const screenshot = PNG.sync.read(await canvas.screenshot({ animations: 'disabled' }));
  let visiblePixels = 0;
  for (let y = Math.floor(screenshot.height * 0.15); y < screenshot.height * 0.8; y += 1) {
    for (let x = Math.floor(screenshot.width * 0.2); x < screenshot.width * 0.8; x += 1) {
      const index = (y * screenshot.width + x) * 4;
      const red = screenshot.data[index] ?? 0;
      const green = screenshot.data[index + 1] ?? 0;
      const blue = screenshot.data[index + 2] ?? 0;
      if (Math.abs(red - 3) + Math.abs(green - 5) + Math.abs(blue - 6) > 18) {
        visiblePixels += 1;
      }
    }
  }
  expect(visiblePixels, '真实画面基线缺少非背景像素').toBeGreaterThan(96);
}

function readPixel(screenshot: PNG, x: number, y: number): PixelColor {
  const clampedX = Math.max(0, Math.min(screenshot.width - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(screenshot.height - 1, Math.round(y)));
  const index = (clampedY * screenshot.width + clampedX) * 4;
  return {
    red: screenshot.data[index] ?? 0,
    green: screenshot.data[index + 1] ?? 0,
    blue: screenshot.data[index + 2] ?? 0,
  };
}

function pixelLuminance(pixel: PixelColor): number {
  return pixel.red * 0.2126 + pixel.green * 0.7152 + pixel.blue * 0.0722;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    throw new Error('像素样本不能为空');
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index] ?? 0;
}

async function expectFocusedStarPixels(canvas: Locator, bodyId: string): Promise<void> {
  const projections = await readJsonAttribute<BodyProjectionDiagnostic[]>(
    canvas,
    'data-visual-body-projections',
  );
  const projection = projections.find((candidate) => candidate.id === bodyId);
  if (projection === undefined) {
    throw new Error(`视觉诊断缺少 ${bodyId} 投影`);
  }

  const canvasBox = await canvas.boundingBox();
  if (canvasBox === null) {
    throw new Error('无法读取画布边界');
  }
  const screenshot = PNG.sync.read(await canvas.screenshot({ animations: 'disabled' }));
  const scaleX = screenshot.width / canvasBox.width;
  const scaleY = screenshot.height / canvasBox.height;
  const centerX = projection.x * scaleX;
  const centerY = projection.y * scaleY;
  const radiusX = projection.radiusPixels * scaleX;
  const radiusY = projection.radiusPixels * scaleY;
  expect(Math.min(radiusX, radiusY), `${bodyId} 近景球面过小`).toBeGreaterThan(48);
  expect(centerX - radiusX * 2.1, `${bodyId} 左侧背景采样越界`).toBeGreaterThanOrEqual(0);
  expect(centerX + radiusX * 2.1, `${bodyId} 右侧背景采样越界`).toBeLessThan(screenshot.width);
  expect(centerY - radiusY * 2.1, `${bodyId} 上侧背景采样越界`).toBeGreaterThanOrEqual(0);
  expect(centerY + radiusY * 2.1, `${bodyId} 下侧背景采样越界`).toBeLessThan(screenshot.height);

  const surfaceLuminances: number[] = [];
  const haloLuminances: number[] = [];
  const backgroundLuminances: number[] = [];
  const minimumX = Math.floor(centerX - radiusX * 2.1);
  const maximumX = Math.ceil(centerX + radiusX * 2.1);
  const minimumY = Math.floor(centerY - radiusY * 2.1);
  const maximumY = Math.ceil(centerY + radiusY * 2.1);
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const normalizedRadius = Math.hypot((x - centerX) / radiusX, (y - centerY) / radiusY);
      const luminance = pixelLuminance(readPixel(screenshot, x, y));
      if (normalizedRadius <= 0.55) {
        surfaceLuminances.push(luminance);
      } else if (normalizedRadius >= 1.05 && normalizedRadius <= 1.45) {
        haloLuminances.push(luminance);
      } else if (normalizedRadius >= 1.8 && normalizedRadius <= 2.1) {
        backgroundLuminances.push(luminance);
      }
    }
  }

  expect(surfaceLuminances.length, `${bodyId} 球面采样不足`).toBeGreaterThan(1_000);
  expect(backgroundLuminances.length, `${bodyId} 背景采样不足`).toBeGreaterThan(1_000);
  const backgroundMedian = percentile(backgroundLuminances, 0.5);
  const visibleSurfaceCoverage =
    surfaceLuminances.filter((luminance) => luminance > backgroundMedian + 20).length /
    surfaceLuminances.length;
  expect(visibleSurfaceCoverage, `${bodyId} 投影区域没有连续的发光球面`).toBeGreaterThan(0.8);
  expect(
    percentile(surfaceLuminances, 0.9) - percentile(surfaceLuminances, 0.1),
    `${bodyId} 球面缺少确定性亮度变化`,
  ).toBeGreaterThan(2);
  expect(
    percentile(haloLuminances, 0.5) - backgroundMedian,
    `${bodyId} 球面外侧缺少连续光晕`,
  ).toBeGreaterThan(2);
}

async function expectVisualFoundation(page: Page, expectedBackend?: 'webgpu' | 'webgl2') {
  const canvas = page.locator('canvas[data-renderer-backend]');
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toBeVisible();
  if (expectedBackend !== undefined) {
    await expect(canvas).toHaveAttribute('data-renderer-backend', expectedBackend);
  }
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-render-frame-count')))
    .toBeGreaterThan(5);

  const firstFrameCount = Number(await canvas.getAttribute('data-render-frame-count'));
  await page.waitForTimeout(250);
  const secondFrameCount = Number(await canvas.getAttribute('data-render-frame-count'));
  expect(secondFrameCount - firstFrameCount, 'Three.js 实际场景帧没有持续推进').toBeGreaterThan(5);

  await expect(canvas).toHaveAttribute('data-visual-active-light-count', '1');
  await expect(canvas).toHaveAttribute('data-render-scale-tier', 'system');
  await expect(canvas).toHaveAttribute('data-visual-tone-mapping-exposure', '1.1');

  const appearances = await readJsonAttribute<AppearanceDiagnostic[]>(
    canvas,
    'data-visual-appearance-kinds',
  );
  expect(appearances).toEqual([
    { id: 'earth', kind: 'rocky' },
    { id: 'jupiter', kind: 'gas-giant' },
    { id: 'mars', kind: 'rocky' },
    { id: 'mercury', kind: 'airless' },
    { id: 'moon', kind: 'airless' },
    { id: 'neptune', kind: 'ice-giant' },
    { id: 'saturn', kind: 'gas-giant' },
    { id: 'sun', kind: 'star' },
    { id: 'uranus', kind: 'ice-giant' },
    { id: 'venus', kind: 'rocky' },
  ]);

  const lodCounts = await readJsonAttribute<LodCounts>(canvas, 'data-visual-lod-counts');
  expect(lodCounts.high + lodCounts.medium + lodCounts.low).toBe(10);
  await expectRenderedPixels(canvas);
}

test('桌面默认后端使用恒星物理外观、材质分类和实际场景帧', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.goto('/?markerDiagnostics=1&visualDiagnostics=1');

  await expectVisualFoundation(page);
  const canvas = page.locator('canvas[data-renderer-backend]');
  await page.getByRole('button', { name: '聚焦太阳', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-render-scale-tier', 'surface');
  await expect(canvas).toHaveAttribute('data-visual-focused-marker-visible', 'false');
  await expect
    .poll(async () => (await readJsonAttribute<LodCounts>(canvas, 'data-visual-lod-counts')).high)
    .toBeGreaterThanOrEqual(1);
  await expectFocusedStarPixels(canvas, 'sun');

  expect(browserDiagnostics, 'M2 桌面视觉基线存在 console warning/error').toEqual([]);
});

test('手机 WebGL2 回退保留相同视觉分类和实际场景帧', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/?visualDiagnostics=1');

  await expectVisualFoundation(page, 'webgl2');
  const canvas = page.locator('canvas[data-renderer-backend]');
  await page.getByRole('button', { name: '天体目录', exact: true }).click();
  await page.getByRole('button', { name: '聚焦太阳', exact: true }).click();
  await page.getByRole('button', { name: '关闭天体数据', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '天体数据' })).toBeHidden();
  await expect
    .poll(async () => await canvas.getAttribute('data-render-scale-tier'))
    .not.toBe('system');
  await expect(canvas).toHaveAttribute('data-visual-focused-marker-visible', 'false');
  await expect
    .poll(async () => {
      const lodCounts = await readJsonAttribute<LodCounts>(canvas, 'data-visual-lod-counts');
      return lodCounts.high + lodCounts.medium;
    })
    .toBeGreaterThanOrEqual(1);
  await expectFocusedStarPixels(canvas, 'sun');
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width ?? 0).toBeGreaterThanOrEqual(390);
  expect(canvasBox?.height ?? 0).toBeGreaterThan(300);

  expect(browserDiagnostics, 'M2 手机 WebGL2 视觉基线存在 console warning/error').toEqual([]);
});
