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

interface VisualResourceDiagnostic {
  readonly assetId: string | null;
  readonly bound: boolean;
  readonly id: string;
  readonly state: 'procedural' | 'idle' | 'loading' | 'ready' | 'fallback';
}

interface AtmosphereResourceDiagnostic {
  readonly id: string;
  readonly layerCount: number;
  readonly outerRadiusRatio: number;
  readonly visible: boolean;
}

interface CloudResourceDiagnostic extends VisualResourceDiagnostic {
  readonly phaseRadians: number;
  readonly radiusRatio: number;
  readonly shadowRadiusRatio: number;
  readonly shadowVisible: boolean;
  readonly visible: boolean;
}

interface ExposureStateDiagnostic {
  readonly current: number;
  readonly settled: boolean;
  readonly target: number;
}

interface PlanetaryRingResourceDiagnostic extends VisualResourceDiagnostic {
  readonly innerRadiusRatio: number;
  readonly outerRadiusRatio: number;
  readonly shadowLatitudeOffset: number;
  readonly shadowOpacity: number;
  readonly shadowVisible: boolean;
  readonly visible: boolean;
}

interface PlanetaryRingProjectionDiagnostic {
  readonly axisX: { readonly x: number; readonly y: number };
  readonly axisY: { readonly x: number; readonly y: number };
  readonly center: { readonly x: number; readonly y: number; readonly z: number };
  readonly id: string;
  readonly innerRadiusFraction: number;
}

interface BlackHoleResourceDiagnostic {
  readonly accretionDiskVisible: boolean;
  readonly haloVisible: boolean;
  readonly id: string;
  readonly mode: 'webgpu-halo' | 'webgl2-ring';
  readonly observableOuterRadiusRatio: number;
  readonly observableProjectedRadiusPixels: number;
  readonly photonRingVisible: boolean;
  readonly physicalProjectedRadiusPixels: number;
  readonly visible: boolean;
}

interface TextureCacheDiagnostic {
  readonly disposed: boolean;
  readonly loading: number;
  readonly ready: number;
  readonly references: number;
  readonly waiters: number;
}

interface VisualResourceCountsDiagnostic {
  readonly atmosphereShells: number;
  readonly blackHoleEffects: number;
  readonly blackHoleSprites: number;
  readonly cloudLayers: number;
  readonly cloudShadows: number;
  readonly planetaryRingMeshes: number;
  readonly textureCache: TextureCacheDiagnostic;
}

interface VisualOriginStateDiagnostic {
  readonly bodyId: string | null;
  readonly focusedLocalPosition: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  } | null;
  readonly maxLocalMagnitude: number;
  readonly originMeters: { readonly x: number; readonly y: number; readonly z: number };
}

interface PixelColor {
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

interface CanvasCapture {
  readonly image: PNG;
  readonly scaleX: number;
  readonly scaleY: number;
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

async function captureCanvas(canvas: Locator): Promise<CanvasCapture> {
  const canvasBox = await canvas.boundingBox();
  if (canvasBox === null) {
    throw new Error('无法读取画布边界');
  }
  const image = PNG.sync.read(await canvas.screenshot({ animations: 'disabled' }));
  return {
    image,
    scaleX: image.width / canvasBox.width,
    scaleY: image.height / canvasBox.height,
  };
}

async function readBodyProjection(
  canvas: Locator,
  bodyId: string,
): Promise<BodyProjectionDiagnostic> {
  const projections = await readJsonAttribute<BodyProjectionDiagnostic[]>(
    canvas,
    'data-visual-body-projections',
  );
  const projection = projections.find((candidate) => candidate.id === bodyId);
  if (projection === undefined) {
    throw new Error(`视觉诊断缺少 ${bodyId} 投影`);
  }
  return projection;
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

async function createBlackHole(page: Page): Promise<string> {
  const observatory = page.locator('main.observatory-shell');
  const canvas = page.locator('canvas[data-renderer-backend]');
  await page.getByRole('button', { name: '创造', exact: true }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expectSynchronizedCreationSnapshot(observatory);
  await page.getByRole('radio', { name: '黑洞 5 倍太阳质量黑洞' }).click();

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) {
    throw new Error('黑洞创建流程缺少画布边界');
  }
  const start = {
    x: bounds.x + bounds.width * 0.64,
    y: bounds.y + bounds.height * 0.44,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - Math.min(76, bounds.height * 0.1), { steps: 8 });
  await page.mouse.up();

  await expect(canvas).toHaveAttribute('data-creation-stage', 'placed');
  await expect(canvas).toHaveAttribute('data-creation-body-visual-count', '1');
  await expect
    .poll(async () => await canvas.getAttribute('data-creation-preview-risk'), {
      timeout: 30_000,
    })
    .toMatch(/stable|collision|escape/);
  await expect(canvas).toHaveAttribute('data-creation-preview-track-count', '1');
  await expect(observatory).toHaveAttribute('data-creation-phase', 'ready');
  await page.getByRole('button', { name: '确认创建', exact: true }).click();

  await expect(observatory).toHaveAttribute('data-mode', 'observe');
  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(observatory).toHaveAttribute('data-view-mode', 'focus');
  await expect(canvas).toHaveAttribute('data-creation-active', 'false');
  return 'created-black-hole-01';
}

async function waitForCameraTransition(
  canvas: Locator,
  expectedOriginBodyId: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const state = await readJsonAttribute<{ readonly transitionActive: boolean }>(
        canvas,
        'data-visual-camera-state',
      );
      const origin = await readJsonAttribute<VisualOriginStateDiagnostic>(
        canvas,
        'data-visual-origin-state',
      );
      return { originBodyId: origin.bodyId, transitionActive: state.transitionActive };
    })
    .toEqual({ originBodyId: expectedOriginBodyId, transitionActive: true });

  await expect
    .poll(async () => {
      const state = await readJsonAttribute<{ readonly transitionActive: boolean }>(
        canvas,
        'data-visual-camera-state',
      );
      const origin = await readJsonAttribute<VisualOriginStateDiagnostic>(
        canvas,
        'data-visual-origin-state',
      );
      return { originBodyId: origin.bodyId, transitionActive: state.transitionActive };
    })
    .toEqual({ originBodyId: expectedOriginBodyId, transitionActive: false });
}

async function closeMobileInspectorIfVisible(page: Page): Promise<void> {
  const closeButton = page.getByRole('button', { name: '关闭天体数据', exact: true });
  if (await closeButton.isVisible()) {
    await closeButton.click();
  }
}

async function focusBodyByName(page: Page, name: string, mobile: boolean): Promise<void> {
  if (mobile) {
    await closeMobileInspectorIfVisible(page);
    await page.getByRole('button', { name: '天体目录', exact: true }).click();
  }
  await page.getByRole('button', { name: `聚焦${name}`, exact: true }).click();
  if (mobile) {
    await closeMobileInspectorIfVisible(page);
  }
}

async function readBlackHoleResource(
  canvas: Locator,
  bodyId: string,
): Promise<BlackHoleResourceDiagnostic> {
  const resources = await readJsonAttribute<BlackHoleResourceDiagnostic[]>(
    canvas,
    'data-visual-black-hole-resources',
  );
  const resource = resources.find((candidate) => candidate.id === bodyId);
  if (resource === undefined) {
    throw new Error(`视觉诊断缺少 ${bodyId} 黑洞资源`);
  }
  return resource;
}

async function expectBlackHoleResource(
  canvas: Locator,
  bodyId: string,
  expectedMode: BlackHoleResourceDiagnostic['mode'],
): Promise<BlackHoleResourceDiagnostic> {
  await expect
    .poll(async () => await readBlackHoleResource(canvas, bodyId))
    .toEqual({
      accretionDiskVisible: false,
      haloVisible: expectedMode === 'webgpu-halo',
      id: bodyId,
      mode: expectedMode,
      observableOuterRadiusRatio: 3.25,
      observableProjectedRadiusPixels: expect.any(Number),
      photonRingVisible: true,
      physicalProjectedRadiusPixels: expect.any(Number),
      visible: true,
    });
  const resource = await readBlackHoleResource(canvas, bodyId);
  expect(resource.observableProjectedRadiusPixels, `${bodyId} 可观察轮廓投影过小`).toBeGreaterThan(
    48,
  );
  expect(resource.physicalProjectedRadiusPixels, `${bodyId} 物理事件视界投影无效`).toBeGreaterThan(
    0,
  );
  expect(
    resource.observableProjectedRadiusPixels / resource.physicalProjectedRadiusPixels,
    `${bodyId} 可观察轮廓与物理半径比例错误`,
  ).toBeCloseTo(resource.observableOuterRadiusRatio, 2);
  return resource;
}

async function expectBlackHolePixels(
  canvas: Locator,
  bodyId: string,
  resource: BlackHoleResourceDiagnostic,
): Promise<void> {
  const projection = await readBodyProjection(canvas, bodyId);
  const capture = await captureCanvas(canvas);
  const centerX = projection.x * capture.scaleX;
  const centerY = projection.y * capture.scaleY;
  const radiusX = resource.observableProjectedRadiusPixels * capture.scaleX;
  const radiusY = resource.observableProjectedRadiusPixels * capture.scaleY;
  const observableRadius = Math.min(radiusX, radiusY);
  expect(observableRadius, `${bodyId} 可观察黑洞近景过小`).toBeGreaterThan(48);
  expect(centerX - radiusX * 1.25, `${bodyId} 左侧轮廓采样越界`).toBeGreaterThanOrEqual(0);
  expect(centerX + radiusX * 1.25, `${bodyId} 右侧轮廓采样越界`).toBeLessThan(capture.image.width);
  expect(centerY - radiusY * 1.25, `${bodyId} 上侧轮廓采样越界`).toBeGreaterThanOrEqual(0);
  expect(centerY + radiusY * 1.25, `${bodyId} 下侧轮廓采样越界`).toBeLessThan(capture.image.height);

  const coreLuminances: number[] = [];
  const ringLuminances: number[] = [];
  const ringBlueBiases: number[] = [];
  const backgroundLuminances: number[] = [];
  const ringSamples: { readonly angle: number; readonly luminance: number }[] = [];
  for (let y = Math.floor(centerY - radiusY * 1.25); y <= centerY + radiusY * 1.25; y += 1) {
    for (let x = Math.floor(centerX - radiusX * 1.25); x <= centerX + radiusX * 1.25; x += 1) {
      const normalizedX = (x - centerX) / radiusX;
      const normalizedY = (y - centerY) / radiusY;
      const normalizedRadius = Math.hypot(normalizedX, normalizedY);
      const pixel = readPixel(capture.image, x, y);
      const luminance = pixelLuminance(pixel);
      if (normalizedRadius <= 0.55) {
        coreLuminances.push(luminance);
      } else if (normalizedRadius >= 0.73 && normalizedRadius <= 0.86) {
        ringLuminances.push(luminance);
        ringBlueBiases.push(pixel.blue - (pixel.red + pixel.green) / 2);
        ringSamples.push({ angle: Math.atan2(normalizedY, normalizedX), luminance });
      } else if (normalizedRadius >= 1.08 && normalizedRadius <= 1.25) {
        backgroundLuminances.push(luminance);
      }
    }
  }

  expect(coreLuminances.length, `${bodyId} 黑洞阴影采样不足`).toBeGreaterThan(1_000);
  expect(ringLuminances.length, `${bodyId} 光子环采样不足`).toBeGreaterThan(500);
  expect(backgroundLuminances.length, `${bodyId} 背景采样不足`).toBeGreaterThan(500);
  const coreNinetieth = percentile(coreLuminances, 0.9);
  const backgroundMedian = percentile(backgroundLuminances, 0.5);
  const ringThreshold = Math.max(coreNinetieth, backgroundMedian) + 12;
  const darkCoreCoverage =
    coreLuminances.filter((luminance) => luminance < 12).length / coreLuminances.length;
  const brightRingCoverage =
    ringLuminances.filter((luminance) => luminance > ringThreshold).length / ringLuminances.length;
  const coveredSectors = Array.from({ length: 16 }, (_, sector) => {
    const sectorStart = -Math.PI + (sector * Math.PI * 2) / 16;
    const sectorEnd = sectorStart + (Math.PI * 2) / 16;
    return ringSamples.some(
      (sample) =>
        sample.angle >= sectorStart && sample.angle < sectorEnd && sample.luminance > ringThreshold,
    );
  }).filter(Boolean).length;

  expect(darkCoreCoverage, `${bodyId} 中心缺少连续黑洞阴影`).toBeGreaterThan(0.8);
  expect(
    percentile(ringLuminances, 0.9) - coreNinetieth,
    `${bodyId} 光子环没有从黑洞阴影中分离`,
  ).toBeGreaterThan(18);
  expect(brightRingCoverage, `${bodyId} 光子环亮像素覆盖不足`).toBeGreaterThan(0.08);
  expect(coveredSectors, `${bodyId} 光子环轮廓不连续`).toBeGreaterThanOrEqual(10);
  expect(percentile(ringBlueBiases, 0.75), `${bodyId} 光子环缺少冷色偏向`).toBeGreaterThan(4);
}

async function readVisualResourceCounts(canvas: Locator): Promise<VisualResourceCountsDiagnostic> {
  return readJsonAttribute<VisualResourceCountsDiagnostic>(canvas, 'data-visual-resource-counts');
}

async function waitForSettledVisualResources(canvas: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const counts = await readVisualResourceCounts(canvas);
      return { loading: counts.textureCache.loading, waiters: counts.textureCache.waiters };
    })
    .toEqual({ loading: 0, waiters: 0 });
}

async function expectBlackHoleOrigin(canvas: Locator, bodyId: string): Promise<void> {
  const origin = await readJsonAttribute<VisualOriginStateDiagnostic>(
    canvas,
    'data-visual-origin-state',
  );
  expect(origin.bodyId).toBe(bodyId);
  expect(origin.focusedLocalPosition).not.toBeNull();
  expect(
    Math.hypot(
      origin.focusedLocalPosition?.x ?? Number.POSITIVE_INFINITY,
      origin.focusedLocalPosition?.y ?? Number.POSITIVE_INFINITY,
      origin.focusedLocalPosition?.z ?? Number.POSITIVE_INFINITY,
    ),
    `${bodyId} 聚焦后没有落在局部渲染原点`,
  ).toBeLessThan(1e-7);
  expect(
    Math.hypot(origin.originMeters.x, origin.originMeters.y, origin.originMeters.z),
    `${bodyId} 黑洞创建位置没有进入物理空间`,
  ).toBeGreaterThan(1e9);
  expect(origin.maxLocalMagnitude, '局部场景范围无效').toBeGreaterThan(0);
}

async function expectSurfaceResource(
  canvas: Locator,
  bodyId: string,
  assetId: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const resources = await readJsonAttribute<VisualResourceDiagnostic[]>(
        canvas,
        'data-visual-surface-resources',
      );
      return resources.find((resource) => resource.id === bodyId);
    })
    .toEqual({ assetId, bound: true, id: bodyId, state: 'ready' });
}

async function expectEarthSurfacePixels(canvas: Locator): Promise<void> {
  const projection = await readBodyProjection(canvas, 'earth');
  const capture = await captureCanvas(canvas);
  const centerX = projection.x * capture.scaleX;
  const centerY = projection.y * capture.scaleY;
  const radiusX = projection.radiusPixels * capture.scaleX;
  const radiusY = projection.radiusPixels * capture.scaleY;
  expect(Math.min(radiusX, radiusY), 'earth 真实表面近景过小').toBeGreaterThan(48);

  const surfaceColors: PixelColor[] = [];
  const surfaceLuminances: number[] = [];
  const backgroundLuminances: number[] = [];
  const minimumX = Math.floor(centerX - radiusX * 1.45);
  const maximumX = Math.ceil(centerX + radiusX * 1.45);
  const minimumY = Math.floor(centerY - radiusY * 1.45);
  const maximumY = Math.ceil(centerY + radiusY * 1.45);
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const normalizedRadius = Math.hypot((x - centerX) / radiusX, (y - centerY) / radiusY);
      const pixel = readPixel(capture.image, x, y);
      if (normalizedRadius <= 0.72) {
        surfaceColors.push(pixel);
        surfaceLuminances.push(pixelLuminance(pixel));
      } else if (normalizedRadius >= 1.2 && normalizedRadius <= 1.45) {
        backgroundLuminances.push(pixelLuminance(pixel));
      }
    }
  }

  expect(surfaceColors.length, 'earth 球面纹理采样不足').toBeGreaterThan(1_000);
  expect(backgroundLuminances.length, 'earth 空间背景采样不足').toBeGreaterThan(1_000);
  const oceanPixels = surfaceColors.filter(
    (pixel) => pixel.blue > pixel.red * 1.08 && pixel.blue > pixel.green * 1.02,
  );
  const landPixels = surfaceColors.filter(
    (pixel) => pixel.red > pixel.blue * 1.08 && pixel.green > pixel.blue * 1.05,
  );
  expect(oceanPixels.length / surfaceColors.length, 'earth 近景缺少连续海洋色').toBeGreaterThan(
    0.03,
  );
  expect(landPixels.length / surfaceColors.length, 'earth 近景缺少连续陆地色').toBeGreaterThan(
    0.01,
  );
  expect(
    percentile(surfaceLuminances, 0.9) - percentile(surfaceLuminances, 0.1),
    'earth 近景缺少表面纹理明暗结构',
  ).toBeGreaterThan(8);
  expect(
    percentile(surfaceLuminances, 0.75) - percentile(backgroundLuminances, 0.5),
    'earth 球面与空间背景没有分离',
  ).toBeGreaterThan(8);
}

async function readEarthCloudResource(canvas: Locator): Promise<CloudResourceDiagnostic> {
  const resources = await readJsonAttribute<CloudResourceDiagnostic[]>(
    canvas,
    'data-visual-cloud-resources',
  );
  const resource = resources.find((candidate) => candidate.id === 'earth');
  if (resource === undefined) {
    throw new Error('视觉诊断缺少 earth 云层资源');
  }
  return resource;
}

async function expectEarthEnvironmentResources(
  canvas: Locator,
  expectedCloudState: 'ready' | 'fallback' = 'ready',
): Promise<void> {
  await expect
    .poll(async () => {
      const resources = await readJsonAttribute<AtmosphereResourceDiagnostic[]>(
        canvas,
        'data-visual-atmosphere-resources',
      );
      return resources.find((resource) => resource.id === 'earth');
    })
    .toEqual({ id: 'earth', layerCount: 2, outerRadiusRatio: 1.026, visible: true });
  await expect
    .poll(async () => await readEarthCloudResource(canvas))
    .toEqual({
      assetId: 'earth-cloud-opacity',
      bound: expectedCloudState === 'ready',
      id: 'earth',
      phaseRadians: expect.any(Number),
      radiusRatio: 1.008,
      shadowRadiusRatio: 1.0015,
      shadowVisible: true,
      state: expectedCloudState,
      visible: true,
    });
}

async function expectEarthAtmospherePixels(canvas: Locator): Promise<void> {
  const projection = await readBodyProjection(canvas, 'earth');
  const capture = await captureCanvas(canvas);
  const centerX = projection.x * capture.scaleX;
  const centerY = projection.y * capture.scaleY;
  const radiusX = projection.radiusPixels * capture.scaleX;
  const radiusY = projection.radiusPixels * capture.scaleY;
  const atmosphereBlueBias: number[] = [];
  const atmosphereLuminance: number[] = [];
  const backgroundBlueBias: number[] = [];
  const backgroundLuminance: number[] = [];
  for (let y = Math.floor(centerY - radiusY * 1.14); y <= centerY + radiusY * 1.14; y += 1) {
    for (let x = Math.floor(centerX - radiusX * 1.14); x <= centerX + radiusX * 1.14; x += 1) {
      const normalizedRadius = Math.hypot((x - centerX) / radiusX, (y - centerY) / radiusY);
      const pixel = readPixel(capture.image, x, y);
      const blueBias = pixel.blue - (pixel.red + pixel.green) / 2;
      if (normalizedRadius >= 1.002 && normalizedRadius <= 1.035) {
        atmosphereBlueBias.push(blueBias);
        atmosphereLuminance.push(pixelLuminance(pixel));
      } else if (normalizedRadius >= 1.08 && normalizedRadius <= 1.14) {
        backgroundBlueBias.push(blueBias);
        backgroundLuminance.push(pixelLuminance(pixel));
      }
    }
  }
  expect(atmosphereBlueBias.length, 'earth 大气边缘采样不足').toBeGreaterThan(100);
  expect(backgroundBlueBias.length, 'earth 大气背景采样不足').toBeGreaterThan(200);
  expect(
    percentile(atmosphereBlueBias, 0.75) - percentile(backgroundBlueBias, 0.75),
    'earth 外缘缺少蓝色大气层',
  ).toBeGreaterThan(1.5);
  expect(
    percentile(atmosphereLuminance, 0.75) - percentile(backgroundLuminance, 0.5),
    'earth 大气边缘没有从空间背景中分离',
  ).toBeGreaterThan(1);
}

function countChangedBodyInteriorSamples(
  before: CanvasCapture,
  beforeProjection: BodyProjectionDiagnostic,
  after: CanvasCapture,
  afterProjection: BodyProjectionDiagnostic,
): { readonly changed: number; readonly total: number } {
  let changed = 0;
  let total = 0;
  for (let normalizedY = -0.78; normalizedY <= 0.78; normalizedY += 0.025) {
    for (let normalizedX = -0.78; normalizedX <= 0.78; normalizedX += 0.025) {
      if (Math.hypot(normalizedX, normalizedY) > 0.78) {
        continue;
      }
      const beforePixel = readPixel(
        before.image,
        (beforeProjection.x + normalizedX * beforeProjection.radiusPixels) * before.scaleX,
        (beforeProjection.y + normalizedY * beforeProjection.radiusPixels) * before.scaleY,
      );
      const afterPixel = readPixel(
        after.image,
        (afterProjection.x + normalizedX * afterProjection.radiusPixels) * after.scaleX,
        (afterProjection.y + normalizedY * afterProjection.radiusPixels) * after.scaleY,
      );
      const difference =
        Math.abs(afterPixel.red - beforePixel.red) +
        Math.abs(afterPixel.green - beforePixel.green) +
        Math.abs(afterPixel.blue - beforePixel.blue);
      if (difference >= 12) {
        changed += 1;
      }
      total += 1;
    }
  }
  return { changed, total };
}

async function expectPausedCloudsAdvanceAfterOneHour(
  page: Page,
  canvas: Locator,
  expectedCloudState: 'ready' | 'fallback' = 'ready',
): Promise<void> {
  await page.getByRole('button', { name: '暂停模拟' }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expectEarthEnvironmentResources(canvas, expectedCloudState);
  const shell = page.locator('main.observatory-shell');
  await expect
    .poll(
      async () => {
        const first = Number(await shell.getAttribute('data-body-snapshot-time-seconds'));
        await page.waitForTimeout(200);
        const second = Number(await shell.getAttribute('data-body-snapshot-time-seconds'));
        return second - first;
      },
      { timeout: 5_000 },
    )
    .toBe(0);
  await page.waitForTimeout(150);
  const beforePhase = (await readEarthCloudResource(canvas)).phaseRadians;
  const beforeProjection = await readBodyProjection(canvas, 'earth');
  const beforeCapture = await captureCanvas(canvas);
  const beforeTime = Number(await shell.getAttribute('data-body-snapshot-time-seconds'));

  await page.waitForTimeout(300);
  expect((await readEarthCloudResource(canvas)).phaseRadians, '暂停后云相位仍在变化').toBe(
    beforePhase,
  );

  await page.getByRole('button', { name: '单步推进一小时' }).click();
  await expect
    .poll(async () => Number(await shell.getAttribute('data-body-snapshot-time-seconds')))
    .toBeGreaterThan(beforeTime + 3_599);
  await expect
    .poll(async () => (await readEarthCloudResource(canvas)).phaseRadians)
    .not.toBe(beforePhase);

  const afterPhase = (await readEarthCloudResource(canvas)).phaseRadians;
  const phaseDelta = (afterPhase - beforePhase + Math.PI * 2) % (Math.PI * 2);
  expect(phaseDelta, '单步一小时后的云相位增量错误').toBeCloseTo(Math.PI / 60, 4);
  const afterProjection = await readBodyProjection(canvas, 'earth');
  const afterCapture = await captureCanvas(canvas);
  const difference = countChangedBodyInteriorSamples(
    beforeCapture,
    beforeProjection,
    afterCapture,
    afterProjection,
  );
  const changedFraction = difference.changed / difference.total;
  expect(changedFraction, '云相位推进后球面像素没有变化').toBeGreaterThan(0.01);
  expect(changedFraction, '云相位推进导致整颗地球画面失稳').toBeLessThan(0.55);
}

async function readExposureState(canvas: Locator): Promise<ExposureStateDiagnostic> {
  return readJsonAttribute<ExposureStateDiagnostic>(canvas, 'data-visual-exposure-state');
}

function samplePatchLuminance(
  capture: CanvasCapture,
  cssX: number,
  cssY: number,
  radius = 2,
): number {
  const centerX = cssX * capture.scaleX;
  const centerY = cssY * capture.scaleY;
  const values: number[] = [];
  for (let y = Math.round(centerY) - radius; y <= Math.round(centerY) + radius; y += 1) {
    for (let x = Math.round(centerX) - radius; x <= Math.round(centerX) + radius; x += 1) {
      values.push(pixelLuminance(readPixel(capture.image, x, y)));
    }
  }
  return percentile(values, 0.5);
}

async function expectSaturnRingPixels(canvas: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const resources = await readJsonAttribute<PlanetaryRingResourceDiagnostic[]>(
        canvas,
        'data-visual-planetary-ring-resources',
      );
      return resources.find((resource) => resource.id === 'saturn');
    })
    .toEqual({
      assetId: 'saturn-ring-opacity',
      bound: true,
      id: 'saturn',
      innerRadiusRatio: 1.24,
      outerRadiusRatio: 2.27,
      shadowLatitudeOffset: expect.any(Number),
      shadowOpacity: expect.any(Number),
      shadowVisible: true,
      state: 'ready',
      visible: true,
    });

  const projections = await readJsonAttribute<PlanetaryRingProjectionDiagnostic[]>(
    canvas,
    'data-visual-planetary-ring-projections',
  );
  const ring = projections.find((projection) => projection.id === 'saturn');
  if (ring === undefined) {
    throw new Error('视觉诊断缺少 saturn 行星环投影');
  }
  const body = await readBodyProjection(canvas, 'saturn');
  const axisXLength = Math.hypot(ring.axisX.x, ring.axisX.y);
  const axisYLength = Math.hypot(ring.axisY.x, ring.axisY.y);
  const majorAxis = axisXLength >= axisYLength ? ring.axisX : ring.axisY;
  const majorAxisLength = Math.max(axisXLength, axisYLength);
  expect(majorAxisLength, 'saturn 环投影过小').toBeGreaterThan(64);
  const bodyRadiusFraction = body.radiusPixels / majorAxisLength;
  expect(bodyRadiusFraction, 'saturn 环内洞被球体完全挡住').toBeLessThan(ring.innerRadiusFraction);

  const capture = await captureCanvas(canvas);
  const sampleAt = (fraction: number, patchRadius = 2): number =>
    samplePatchLuminance(
      capture,
      ring.center.x + majorAxis.x * fraction,
      ring.center.y + majorAxis.y * fraction,
      patchRadius,
    );
  const bandFractions = [0.62, 0.7, 0.78, 0.86, 0.94];
  const leftBands = bandFractions.map((fraction) => sampleAt(-fraction));
  const rightBands = bandFractions.map((fraction) => sampleAt(fraction));
  const background = [sampleAt(-1.08), sampleAt(1.08)];
  const holeFraction = (bodyRadiusFraction + ring.innerRadiusFraction) / 2;
  const hole = [sampleAt(-holeFraction), sampleAt(holeFraction)];
  const backgroundMedian = percentile(background, 0.5);
  const ringMedian = percentile([...leftBands, ...rightBands], 0.5);
  const patternFractions = [0.65, 0.7, 0.75].map(
    (textureU) => ring.innerRadiusFraction + (1 - ring.innerRadiusFraction) * textureU,
  );
  const radialBandContrasts = [-1, 1].map((side) => {
    const [brightInner = 0, darkMiddle = 0, brightOuter = 0] = patternFractions.map((fraction) =>
      sampleAt(side * fraction, 1),
    );
    return Math.min(brightInner - darkMiddle, brightOuter - darkMiddle);
  });

  expect(percentile(leftBands, 0.5) - backgroundMedian, 'saturn 左侧环带不可见').toBeGreaterThan(3);
  expect(percentile(rightBands, 0.5) - backgroundMedian, 'saturn 右侧环带不可见').toBeGreaterThan(
    3,
  );
  expect(ringMedian - Math.min(...hole), 'saturn 环内洞没有露出空间背景').toBeGreaterThan(3);
  expect(Math.max(...radialBandContrasts), 'saturn 同侧环带缺少亮暗相间的径向结构').toBeGreaterThan(
    1.75,
  );
}

async function expectFallbackBodyPixels(canvas: Locator, bodyId: string): Promise<void> {
  const projection = await readBodyProjection(canvas, bodyId);
  const capture = await captureCanvas(canvas);
  const centerX = projection.x * capture.scaleX;
  const centerY = projection.y * capture.scaleY;
  const radiusX = projection.radiusPixels * capture.scaleX;
  const radiusY = projection.radiusPixels * capture.scaleY;
  expect(Math.min(radiusX, radiusY), `${bodyId} 回退球面过小`).toBeGreaterThan(48);

  const surface: number[] = [];
  const background: number[] = [];
  for (let y = Math.floor(centerY - radiusY * 1.4); y <= centerY + radiusY * 1.4; y += 1) {
    for (let x = Math.floor(centerX - radiusX * 1.4); x <= centerX + radiusX * 1.4; x += 1) {
      const normalizedRadius = Math.hypot((x - centerX) / radiusX, (y - centerY) / radiusY);
      const luminance = pixelLuminance(readPixel(capture.image, x, y));
      if (normalizedRadius <= 0.65) {
        surface.push(luminance);
      } else if (normalizedRadius >= 1.15 && normalizedRadius <= 1.4) {
        background.push(luminance);
      }
    }
  }
  expect(
    percentile(surface, 0.75) - percentile(background, 0.5),
    `${bodyId} 资产失败后没有可见回退球面`,
  ).toBeGreaterThan(5);
}

async function expectFocusedStarPixels(canvas: Locator, bodyId: string): Promise<void> {
  const projection = await readBodyProjection(canvas, bodyId);
  const capture = await captureCanvas(canvas);
  const screenshot = capture.image;
  const scaleX = capture.scaleX;
  const scaleY = capture.scaleY;
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

test('桌面默认后端显示真实太阳、地球环境和土星环影', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.goto('/?markerDiagnostics=1&visualDiagnostics=1');

  await expectVisualFoundation(page);
  const canvas = page.locator('canvas[data-renderer-backend]');
  await page.getByRole('button', { name: '聚焦太阳', exact: true }).click();
  await waitForCameraTransition(canvas, 'sun');
  await expect(canvas).toHaveAttribute('data-render-scale-tier', 'surface');
  await expect(canvas).toHaveAttribute('data-visual-focused-marker-visible', 'false');
  await expect
    .poll(async () => (await readJsonAttribute<LodCounts>(canvas, 'data-visual-lod-counts')).high)
    .toBeGreaterThanOrEqual(1);
  await expectSurfaceResource(canvas, 'sun', 'sun-surface');
  await expectFocusedStarPixels(canvas, 'sun');

  await page.getByRole('button', { name: '聚焦地球', exact: true }).click();
  await waitForCameraTransition(canvas, 'earth');
  await expectSurfaceResource(canvas, 'earth', 'earth-surface');
  await expectEarthEnvironmentResources(canvas);
  await expectEarthSurfacePixels(canvas);
  await expectEarthAtmospherePixels(canvas);
  await expectPausedCloudsAdvanceAfterOneHour(page, canvas);

  await page.getByRole('button', { name: '聚焦土星', exact: true }).click();
  await waitForCameraTransition(canvas, 'saturn');
  await expectSurfaceResource(canvas, 'saturn', 'saturn-surface');
  await expectSaturnRingPixels(canvas);

  expect(browserDiagnostics, 'M2 Task 3 桌面视觉流程存在 console warning/error').toEqual([]);
});

test('手机 WebGL2 回退保留真实地球环境和土星环影', async ({ page }) => {
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
  await page.getByRole('button', { name: '聚焦地球', exact: true }).click();
  await page.getByRole('button', { name: '关闭天体数据', exact: true }).click();
  await waitForCameraTransition(canvas, 'earth');
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
  await expectSurfaceResource(canvas, 'earth', 'earth-surface');
  await expectEarthEnvironmentResources(canvas);
  await expectEarthSurfacePixels(canvas);
  await expectEarthAtmospherePixels(canvas);

  await page.getByRole('button', { name: '天体目录', exact: true }).click();
  await page.getByRole('button', { name: '聚焦土星', exact: true }).click();
  await page.getByRole('button', { name: '关闭天体数据', exact: true }).click();
  await waitForCameraTransition(canvas, 'saturn');
  await expect(page.getByRole('complementary', { name: '天体数据' })).toBeHidden();
  await expectSurfaceResource(canvas, 'saturn', 'saturn-surface');
  await expectSaturnRingPixels(canvas);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width ?? 0).toBeGreaterThanOrEqual(390);
  expect(canvasBox?.height ?? 0).toBeGreaterThan(300);

  expect(browserDiagnostics, 'M2 Task 3 手机 WebGL2 流程存在 console warning/error').toEqual([]);
});

test('太阳到地球近景的曝光连续平滑收敛', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.goto('/?visualDiagnostics=1');

  await expectVisualFoundation(page);
  const canvas = page.locator('canvas[data-renderer-backend]');
  await page.getByRole('button', { name: '暂停模拟' }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await page.getByRole('button', { name: '聚焦太阳', exact: true }).click();
  await expect
    .poll(async () => (await readExposureState(canvas)).target, { timeout: 5_000 })
    .toBe(0.68);
  await expect
    .poll(async () => (await readExposureState(canvas)).settled, { timeout: 5_000 })
    .toBe(true);
  const settledSunExposure = await readExposureState(canvas);
  expect(settledSunExposure.target).toBe(0.68);
  expect(settledSunExposure.current).toBeCloseTo(0.68, 2);
  const startExposure = settledSunExposure.current;

  await page.getByRole('button', { name: '聚焦地球', exact: true }).click();
  await expect
    .poll(async () => (await readExposureState(canvas)).target, { timeout: 5_000 })
    .toBeGreaterThan(startExposure + 0.25);
  const samples: number[] = [];
  for (let index = 0; index < 18; index += 1) {
    await page.waitForTimeout(100);
    samples.push((await readExposureState(canvas)).current);
  }
  await expect
    .poll(async () => (await readExposureState(canvas)).settled, { timeout: 5_000 })
    .toBe(true);
  const finalExposure = await readExposureState(canvas);
  samples.push(finalExposure.current);

  expect(finalExposure.target - startExposure, '太阳到地球没有产生有效曝光跨度').toBeGreaterThan(
    0.25,
  );
  expect(
    new Set(samples.map((value) => value.toFixed(4))).size,
    '曝光缺少连续中间值',
  ).toBeGreaterThan(3);
  for (let index = 1; index < samples.length; index += 1) {
    expect(samples[index] ?? 0, '曝光切换过程中发生反向跳变').toBeGreaterThanOrEqual(
      (samples[index - 1] ?? 0) - 0.002,
    );
    expect(samples[index] ?? 0, '曝光切换过程中越过目标值').toBeLessThanOrEqual(
      finalExposure.target + 0.01,
    );
  }

  expect(browserDiagnostics, '曝光适应流程存在 console warning/error').toEqual([]);
});

test('地球纹理失败时保留可选择和可聚焦的程序化回退', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.route('**/assets/planetary/earth.webp', async (route) => {
    await route.fulfill({
      body: 'not an image',
      contentType: 'text/plain',
      status: 200,
    });
  });
  await page.goto('/?visualDiagnostics=1');

  await expectVisualFoundation(page);
  const canvas = page.locator('canvas[data-renderer-backend]');
  await page.getByRole('button', { name: '聚焦地球', exact: true }).click();
  await waitForCameraTransition(canvas, 'earth');
  await expect
    .poll(async () => {
      const resources = await readJsonAttribute<VisualResourceDiagnostic[]>(
        canvas,
        'data-visual-surface-resources',
      );
      return resources.find((resource) => resource.id === 'earth');
    })
    .toEqual({ assetId: 'earth-surface', bound: false, id: 'earth', state: 'fallback' });
  await expect(canvas).toHaveAttribute('data-render-scale-tier', 'surface');
  await expect(canvas).toHaveAttribute('data-visual-focused-marker-visible', 'false');
  await expect(page.getByRole('heading', { name: '地球', exact: true })).toBeVisible();
  await expectFallbackBodyPixels(canvas, 'earth');

  expect(browserDiagnostics, '纹理失败回退流程存在 console warning/error').toEqual([]);
});

test('地球云图失败时保留可移动的程序化云层', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.route('**/assets/planetary/earth-clouds.webp', async (route) => {
    await route.fulfill({
      body: 'not an image',
      contentType: 'text/plain',
      status: 200,
    });
  });
  await page.goto('/?visualDiagnostics=1');

  await expectVisualFoundation(page);
  const canvas = page.locator('canvas[data-renderer-backend]');
  await page.getByRole('button', { name: '聚焦地球', exact: true }).click();
  await waitForCameraTransition(canvas, 'earth');
  await expect(canvas).toHaveAttribute('data-render-scale-tier', 'surface');
  await expectSurfaceResource(canvas, 'earth', 'earth-surface');
  await expectEarthEnvironmentResources(canvas, 'fallback');
  await expectEarthSurfacePixels(canvas);
  await expectPausedCloudsAdvanceAfterOneHour(page, canvas, 'fallback');

  expect(browserDiagnostics, '云图失败回退流程存在 console warning/error').toEqual([]);
});

test('桌面默认后端创建并聚焦可辨识黑洞，重复尺度切换后资源稳定', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.goto('/?markerDiagnostics=1&visualDiagnostics=1');

  await expectVisualFoundation(page);
  const canvas = page.locator('canvas[data-renderer-backend]');
  const backend = await canvas.getAttribute('data-renderer-backend');
  expect(backend === 'webgpu' || backend === 'webgl2').toBe(true);
  const expectedMode: BlackHoleResourceDiagnostic['mode'] =
    backend === 'webgpu' ? 'webgpu-halo' : 'webgl2-ring';
  const blackHoleId = await createBlackHole(page);

  await waitForCameraTransition(canvas, blackHoleId);
  await expect(page.getByRole('button', { name: '聚焦黑洞 01', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const appearances = await readJsonAttribute<AppearanceDiagnostic[]>(
    canvas,
    'data-visual-appearance-kinds',
  );
  expect(appearances).toContainEqual({ id: blackHoleId, kind: 'black-hole' });
  const resource = await expectBlackHoleResource(canvas, blackHoleId, expectedMode);
  await expectBlackHoleOrigin(canvas, blackHoleId);
  await expectBlackHolePixels(canvas, blackHoleId, resource);

  await focusBodyByName(page, '地球', false);
  await waitForCameraTransition(canvas, 'earth');
  await expectSurfaceResource(canvas, 'earth', 'earth-surface');
  await focusBodyByName(page, '黑洞 01', false);
  await waitForCameraTransition(canvas, blackHoleId);
  await waitForSettledVisualResources(canvas);
  const stableResourceCounts = await readVisualResourceCounts(canvas);
  expect(stableResourceCounts.blackHoleEffects).toBe(1);
  expect(stableResourceCounts.blackHoleSprites).toBe(expectedMode === 'webgpu-halo' ? 2 : 1);
  expect(stableResourceCounts.textureCache.disposed).toBe(false);
  const firstFrameCount = Number(await canvas.getAttribute('data-render-frame-count'));

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await focusBodyByName(page, '地球', false);
    await waitForCameraTransition(canvas, 'earth');
    await focusBodyByName(page, '黑洞 01', false);
    await waitForCameraTransition(canvas, blackHoleId);
  }

  await waitForSettledVisualResources(canvas);
  await expect
    .poll(async () => await readVisualResourceCounts(canvas))
    .toEqual(stableResourceCounts);
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-render-frame-count')))
    .toBeGreaterThan(firstFrameCount + 20);
  await expectBlackHoleResource(canvas, blackHoleId, expectedMode);
  await expectBlackHoleOrigin(canvas, blackHoleId);

  expect(browserDiagnostics, '桌面黑洞视觉流程存在 console warning/error').toEqual([]);
});

test('手机 WebGL2 回退创建黑洞并保留暗核、光子环和稳定资源', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/?markerDiagnostics=1&visualDiagnostics=1');

  await expectVisualFoundation(page, 'webgl2');
  const canvas = page.locator('canvas[data-renderer-backend]');
  const blackHoleId = await createBlackHole(page);
  await closeMobileInspectorIfVisible(page);
  await waitForCameraTransition(canvas, blackHoleId);

  const resource = await expectBlackHoleResource(canvas, blackHoleId, 'webgl2-ring');
  expect(resource.haloVisible).toBe(false);
  await expectBlackHoleOrigin(canvas, blackHoleId);
  await expectBlackHolePixels(canvas, blackHoleId, resource);

  await focusBodyByName(page, '地球', true);
  await waitForCameraTransition(canvas, 'earth');
  await expectSurfaceResource(canvas, 'earth', 'earth-surface');
  await focusBodyByName(page, '黑洞 01', true);
  await waitForCameraTransition(canvas, blackHoleId);
  await waitForSettledVisualResources(canvas);
  const stableResourceCounts = await readVisualResourceCounts(canvas);
  expect(stableResourceCounts.blackHoleEffects).toBe(1);
  expect(stableResourceCounts.blackHoleSprites).toBe(1);
  expect(stableResourceCounts.textureCache.disposed).toBe(false);

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await focusBodyByName(page, '地球', true);
    await waitForCameraTransition(canvas, 'earth');
    await expectSurfaceResource(canvas, 'earth', 'earth-surface');
    await focusBodyByName(page, '黑洞 01', true);
    await waitForCameraTransition(canvas, blackHoleId);
  }

  await waitForSettledVisualResources(canvas);
  await expect
    .poll(async () => await readVisualResourceCounts(canvas))
    .toEqual(stableResourceCounts);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width ?? 0).toBeGreaterThanOrEqual(390);
  expect(canvasBox?.height ?? 0).toBeGreaterThan(300);
  await expectBlackHoleResource(canvas, blackHoleId, 'webgl2-ring');
  await expectBlackHoleOrigin(canvas, blackHoleId);

  expect(browserDiagnostics, '手机 WebGL2 黑洞回退流程存在 console warning/error').toEqual([]);
});
