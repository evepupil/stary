import { expect, test, type Locator, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const CELESTIAL_NAMES = [
  '太阳',
  '水星',
  '金星',
  '地球',
  '月球',
  '火星',
  '木星',
  '土星',
  '天王星',
  '海王星',
] as const;

const OUTER_PLANET_NAMES = {
  jupiter: '木星',
  neptune: '海王星',
  saturn: '土星',
  uranus: '天王星',
} as const;

interface VisibleBodyMarker {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

interface CameraState {
  readonly mode: 'focus' | 'overview';
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
}

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

async function expectCelestialDirectory(page: Page): Promise<void> {
  const directory = page.locator('aside[aria-label="天体目录"]');
  await expect(directory.locator('.panel-heading span')).toHaveText('10');
  await expect(directory.locator('[role="listitem"]')).toHaveCount(CELESTIAL_NAMES.length);

  for (const name of CELESTIAL_NAMES) {
    await expect(directory.getByText(name, { exact: true })).toHaveCount(1);
  }
}

async function captureRenderedCanvas(page: Page): Promise<{
  readonly canvas: Locator;
  readonly screenshot: PNG;
}> {
  const canvas = page.locator('canvas[data-renderer-backend]');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width ?? 0).toBeGreaterThan(300);
  expect(canvasBox?.height ?? 0).toBeGreaterThan(300);

  return {
    canvas,
    screenshot: PNG.sync.read(await canvas.screenshot({ animations: 'disabled' })),
  };
}

async function expectRenderedCanvas(page: Page): Promise<void> {
  const { screenshot } = await captureRenderedCanvas(page);
  const startX = Math.floor(screenshot.width * 0.24);
  const endX = Math.ceil(screenshot.width * 0.76);
  const startY = Math.floor(screenshot.height * 0.16);
  const endY = Math.ceil(screenshot.height * 0.76);
  let visiblePixelCount = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = (y * screenshot.width + x) * 4;
      const red = screenshot.data[index] ?? 0;
      const green = screenshot.data[index + 1] ?? 0;
      const blue = screenshot.data[index + 2] ?? 0;
      const distanceFromBackground = Math.abs(red - 3) + Math.abs(green - 5) + Math.abs(blue - 6);
      if (distanceFromBackground > 18 && (screenshot.data[index + 3] ?? 0) > 0) {
        visiblePixelCount += 1;
      }
    }
  }

  expect(visiblePixelCount, '画布中央区域缺少可见场景像素').toBeGreaterThan(96);
}

async function expectSelectedOrbitPixels(page: Page): Promise<void> {
  const { canvas, screenshot } = await captureRenderedCanvas(page);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox === null) {
    return;
  }

  const markers = await readVisibleBodyMarkers(canvas);
  const scaleX = screenshot.width / canvasBox.width;
  const scaleY = screenshot.height / canvasBox.height;
  const markerExclusionRadiusPixels = 30 * Math.max(scaleX, scaleY);
  const startX = Math.floor(screenshot.width * 0.18);
  const endX = Math.ceil(screenshot.width * 0.82);
  const startY = Math.floor(screenshot.height * 0.16);
  const endY = Math.ceil(screenshot.height * 0.8);
  let selectedOrbitPixelCount = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const insideMarker = markers.some((marker) =>
        isWithinRadius(x, y, marker.x * scaleX, marker.y * scaleY, markerExclusionRadiusPixels),
      );
      if (insideMarker) {
        continue;
      }

      const index = (y * screenshot.width + x) * 4;
      const red = screenshot.data[index] ?? 0;
      const green = screenshot.data[index + 1] ?? 0;
      const blue = screenshot.data[index + 2] ?? 0;
      if (green >= 45 && green - red >= 22 && green - blue >= 6) {
        selectedOrbitPixelCount += 1;
      }
    }
  }

  expect(selectedOrbitPixelCount, '聚焦海王星后缺少青绿色选中轨道像素').toBeGreaterThan(
    Math.ceil(Math.min(screenshot.width, screenshot.height) * 0.15),
  );
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

async function readVisibleBodyMarkers(canvas: Locator): Promise<readonly VisibleBodyMarker[]> {
  const serialized = await canvas.getAttribute('data-visible-body-markers');
  if (serialized === null) {
    return [];
  }

  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new Error('data-visible-body-markers 必须是数组');
  }

  return parsed.map((candidate) => {
    if (!isVisibleBodyMarker(candidate)) {
      throw new Error('data-visible-body-markers 包含无效条目');
    }
    return candidate;
  });
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

function isCameraState(candidate: unknown): candidate is CameraState {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    (record.mode === 'focus' || record.mode === 'overview') &&
    isFiniteVector(record.position) &&
    isFiniteVector(record.target)
  );
}

function isFiniteVector(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return [record.x, record.y, record.z].every(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
}

function vectorDistance(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function isVisibleBodyMarker(candidate: unknown): candidate is VisibleBodyMarker {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.x === 'number' &&
    Number.isFinite(record.x) &&
    typeof record.y === 'number' &&
    Number.isFinite(record.y)
  );
}

function isWithinRadius(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  radius: number,
): boolean {
  return Math.hypot(x - centerX, y - centerY) <= radius;
}

function findIsolatedOuterPlanet(
  markers: readonly VisibleBodyMarker[],
  canvasWidth: number,
  canvasHeight: number,
): VisibleBodyMarker | null {
  const outerPlanetIds = new Set(Object.keys(OUTER_PLANET_NAMES));
  const candidates = markers.filter(
    (marker) =>
      marker.id !== 'neptune' &&
      outerPlanetIds.has(marker.id) &&
      marker.x > 300 &&
      marker.x < canvasWidth - 300 &&
      marker.y > 120 &&
      marker.y < canvasHeight - 120,
  );

  const ranked = candidates
    .map((candidate) => ({
      marker: candidate,
      nearestDistance: Math.min(
        ...markers
          .filter((marker) => marker.id !== candidate.id)
          .map((marker) => Math.hypot(marker.x - candidate.x, marker.y - candidate.y)),
      ),
    }))
    .filter((candidate) => candidate.nearestDistance >= 40)
    .toSorted((left, right) => right.nearestDistance - left.nearestDistance);

  return ranked[0]?.marker ?? null;
}

async function expectVisibleMarkerRing(
  canvas: Locator,
  marker: VisibleBodyMarker,
  canvasWidth: number,
  canvasHeight: number,
): Promise<void> {
  const screenshot = PNG.sync.read(await canvas.screenshot({ animations: 'disabled' }));
  const scaleX = screenshot.width / canvasWidth;
  const scaleY = screenshot.height / canvasHeight;
  const centerX = marker.x * scaleX;
  const centerY = marker.y * scaleY;
  const minimumRadius = 6 * Math.min(scaleX, scaleY);
  const maximumRadius = 14 * Math.max(scaleX, scaleY);
  let ringPixelCount = 0;

  const startX = Math.max(0, Math.floor(centerX - maximumRadius));
  const endX = Math.min(screenshot.width, Math.ceil(centerX + maximumRadius));
  const startY = Math.max(0, Math.floor(centerY - maximumRadius));
  const endY = Math.min(screenshot.height, Math.ceil(centerY + maximumRadius));

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const radius = Math.hypot(x - centerX, y - centerY);
      if (radius < minimumRadius || radius > maximumRadius) {
        continue;
      }
      const index = (y * screenshot.width + x) * 4;
      const red = screenshot.data[index] ?? 0;
      const green = screenshot.data[index + 1] ?? 0;
      const blue = screenshot.data[index + 2] ?? 0;
      if (green >= 25 && green - red >= 10 && blue - red >= 10) {
        ringPixelCount += 1;
      }
    }
  }

  expect(ringPixelCount, `${marker.id} 的实时坐标周围缺少可见定位环`).toBeGreaterThan(4);
}

async function clickIsolatedOuterPlanet(page: Page): Promise<{
  readonly id: keyof typeof OUTER_PLANET_NAMES;
  readonly name: (typeof OUTER_PLANET_NAMES)[keyof typeof OUTER_PLANET_NAMES];
}> {
  const canvas = page.locator('canvas[data-renderer-backend]');
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox === null) {
    throw new Error('画布没有可点击区域');
  }

  await expect
    .poll(async () => {
      const markers = await readVisibleBodyMarkers(canvas);
      return findIsolatedOuterPlanet(markers, canvasBox.width, canvasBox.height) !== null;
    })
    .toBe(true);

  const marker = findIsolatedOuterPlanet(
    await readVisibleBodyMarkers(canvas),
    canvasBox.width,
    canvasBox.height,
  );
  if (marker === null || !(marker.id in OUTER_PLANET_NAMES)) {
    throw new Error('没有找到屏幕上孤立且可点击的外行星');
  }

  await expectVisibleMarkerRing(canvas, marker, canvasBox.width, canvasBox.height);
  const id = marker.id as keyof typeof OUTER_PLANET_NAMES;
  await canvas.click({ position: { x: marker.x, y: marker.y } });
  return { id, name: OUTER_PLANET_NAMES[id] };
}

async function readMobileLayout(page: Page) {
  return page.evaluate(() => {
    const controls = document.querySelector<HTMLElement>('.time-controls');
    const inspector = document.querySelector<HTMLElement>('aside[aria-label="天体数据"]');
    const tabs = document.querySelector<HTMLElement>('.mobile-panel-tabs');
    if (controls === null || inspector === null || tabs === null) {
      throw new Error('手机控制区域缺失');
    }
    const controlsBox = controls.getBoundingClientRect();
    const inspectorBox = inspector.getBoundingClientRect();
    const tabsBox = tabs.getBoundingClientRect();
    return {
      controlsBottom: controlsBox.bottom,
      controlsLeft: controlsBox.left,
      controlsRight: controlsBox.right,
      controlsTop: controlsBox.top,
      inspectorBottom: inspectorBox.bottom,
      scrollTop: document.scrollingElement?.scrollTop ?? 0,
      tabsBottom: tabsBox.bottom,
      tabsTop: tabsBox.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
}

test('场景模块延迟加载时保留用户的海王星聚焦请求', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.route('**/observatory-scene-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });

  await page.goto('/?markerDiagnostics=1');
  await page.getByRole('button', { name: '聚焦海王星' }).click();
  await expect(page.locator('main.observatory-shell')).toHaveAttribute('data-view-mode', 'focus');
  const canvas = page.locator('canvas[data-renderer-backend]');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await readCameraState(canvas)).mode).toBe('focus');
  await expect(page.locator('aside[aria-label="天体数据"]')).toContainText('海王星');
  expect(browserDiagnostics, '延迟场景加载存在 console warning/error').toEqual([]);
});

test('生产观测台渲染太阳系 10 体并完成聚焦和时间控制', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);

  await page.goto('/?markerDiagnostics=1');

  await expect(page).toHaveTitle('STARY');
  const observatory = page.locator('main.observatory-shell');
  await expect(observatory).toBeVisible();
  await expect(observatory).toHaveAttribute('data-view-mode', 'overview');
  await expect(page.getByText('STARY', { exact: true })).toBeVisible();
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expectCelestialDirectory(page);
  await expectRenderedCanvas(page);
  await expectInitializedRendererBackend(page);
  const diagnosticCanvas = page.locator('canvas[data-renderer-backend]');
  const overviewCameraState = await readCameraState(diagnosticCanvas);
  expect(overviewCameraState.mode).toBe('overview');

  await page.getByRole('button', { name: '暂停模拟' }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  const timeBeforeStep = Number(await observatory.getAttribute('data-simulation-time-seconds'));

  const neptuneButton = page.getByRole('button', { name: '聚焦海王星' });
  await neptuneButton.click();
  await expect(observatory).toHaveAttribute('data-view-mode', 'focus');
  await expect(neptuneButton).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('aside[aria-label="天体数据"]')).toContainText('海王星');
  await expect(page.getByRole('button', { name: '返回太阳系全景' })).toBeVisible();
  await expect.poll(async () => (await readCameraState(diagnosticCanvas)).mode).toBe('focus');
  const focusCameraState = await readCameraState(diagnosticCanvas);
  expect(vectorDistance(focusCameraState.target, overviewCameraState.target)).toBeGreaterThan(1);
  expect(
    Math.abs(
      vectorDistance(focusCameraState.position, focusCameraState.target) -
        vectorDistance(overviewCameraState.position, overviewCameraState.target),
    ),
  ).toBeGreaterThan(1);
  await expectSelectedOrbitPixels(page);

  await page.getByRole('button', { name: '返回太阳系全景' }).click();
  await expect(observatory).toHaveAttribute('data-view-mode', 'overview');
  await expect(page.getByRole('button', { name: '返回太阳系全景' })).toBeHidden();
  await expect(neptuneButton).not.toHaveAttribute('aria-current', 'true');
  await expect(neptuneButton).toContainText('已查看');
  await expect
    .poll(() =>
      neptuneButton
        .locator('.body-list-state')
        .evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe('1');
  await expect.poll(async () => (await readCameraState(diagnosticCanvas)).mode).toBe('overview');

  const clickedPlanet = await clickIsolatedOuterPlanet(page);
  await expect(observatory).toHaveAttribute('data-view-mode', 'focus');
  await expect(page.getByRole('button', { name: `聚焦${clickedPlanet.name}` })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.locator('aside[aria-label="天体数据"]')).toContainText(clickedPlanet.name);

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

test('手机视口可从滚动目录选择海王星并安全关闭数据抽屉', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/?markerDiagnostics=1');

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expectCelestialDirectory(page);
  await expectRenderedCanvas(page);

  await page.getByRole('button', { exact: true, name: '天体目录' }).click();
  const bodyPanel = page.locator('aside[aria-label="天体目录"]');
  await expect(bodyPanel).toHaveAttribute('data-mobile-open', 'true');
  await expect
    .poll(() =>
      bodyPanel.evaluate((element) => {
        const style = getComputedStyle(element);
        const transform =
          style.transform === 'none' ? null : new DOMMatrixReadOnly(style.transform);
        return Number(style.opacity) === 1 && Math.abs(transform?.m42 ?? 0) < 0.1;
      }),
    )
    .toBe(true);
  const directoryCloseButton = page.getByRole('button', { name: '关闭天体目录' });
  await expect(directoryCloseButton).toBeVisible();
  const directoryCloseBoxBeforeScroll = await directoryCloseButton.boundingBox();
  const bodyScroller = bodyPanel.locator('.body-groups');
  await bodyScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => bodyScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const scrollMetrics = await bodyScroller.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(scrollMetrics.scrollTop + scrollMetrics.clientHeight).toBeGreaterThanOrEqual(
    scrollMetrics.scrollHeight - 1,
  );

  const bodyPanelBox = await bodyPanel.boundingBox();
  const directoryCloseBox = await directoryCloseButton.boundingBox();
  expect(bodyPanelBox).not.toBeNull();
  expect(directoryCloseBoxBeforeScroll).not.toBeNull();
  expect(directoryCloseBox).not.toBeNull();
  if (
    bodyPanelBox !== null &&
    directoryCloseBoxBeforeScroll !== null &&
    directoryCloseBox !== null
  ) {
    expect(directoryCloseBox.y).toBeCloseTo(directoryCloseBoxBeforeScroll.y, 3);
    expect(directoryCloseBox.y).toBeGreaterThanOrEqual(bodyPanelBox.y);
    expect(directoryCloseBox.y + directoryCloseBox.height).toBeLessThanOrEqual(
      bodyPanelBox.y + bodyPanelBox.height,
    );
  }

  const neptuneButton = bodyPanel.getByRole('button', { name: '聚焦海王星' });
  await neptuneButton.scrollIntoViewIfNeeded();
  await neptuneButton.click();

  await expect(page.locator('main.observatory-shell')).toHaveAttribute('data-view-mode', 'focus');
  await expect(bodyPanel).toHaveAttribute('data-mobile-open', 'false');
  const inspectorPanel = page.locator('aside[aria-label="天体数据"]');
  await expect(inspectorPanel).toHaveAttribute('data-mobile-open', 'true');
  await expect(inspectorPanel.getByRole('heading', { name: '海王星' })).toBeVisible();

  await expect
    .poll(async () => {
      const currentLayout = await readMobileLayout(page);
      return (
        currentLayout.inspectorBottom <= currentLayout.tabsTop &&
        currentLayout.tabsBottom < currentLayout.controlsTop
      );
    })
    .toBe(true);
  const layout = await readMobileLayout(page);
  expect(layout.controlsLeft).toBeGreaterThanOrEqual(0);
  expect(layout.controlsRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.controlsBottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.inspectorBottom).toBeLessThanOrEqual(layout.tabsTop);
  expect(layout.tabsBottom).toBeLessThan(layout.controlsTop);
  expect(layout.scrollTop).toBe(0);

  await page.getByRole('button', { name: '关闭天体数据' }).click();
  await expect(inspectorPanel).toHaveAttribute('data-mobile-open', 'false');

  expect(browserDiagnostics, '手机页面存在 console warning/error 或未处理异常').toEqual([]);
});

test('WebGPU 不可用时真实回退到 WebGL2 太阳系场景', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expectCelestialDirectory(page);
  await expectRenderedCanvas(page);
  await expect(page.locator('canvas[data-renderer-backend]')).toHaveAttribute(
    'data-renderer-backend',
    'webgl2',
  );
  await expect(page.getByText('WEBGL2', { exact: true })).toBeVisible();

  expect(browserDiagnostics, 'WebGL2 回退存在 console warning/error 或未处理异常').toEqual([]);
});
