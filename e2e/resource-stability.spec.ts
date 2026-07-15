import { expect, test, type Locator, type Page } from '@playwright/test';

interface TextureCacheSnapshot {
  readonly disposed: boolean;
  readonly loading: number;
  readonly ready: number;
  readonly references: number;
  readonly waiters: number;
}

interface BlackHoleTexturePoolSnapshot {
  readonly entries: number;
  readonly references: number;
}

interface SceneResourceCounts {
  readonly geometries: number;
  readonly lights: number;
  readonly materials: number;
  readonly objects: number;
  readonly renderTargets: number;
  readonly textures: number;
}

interface RenderLifecycleSnapshot {
  readonly activeRenderers: number;
  readonly activeScenes: number;
  readonly renderersCreated: number;
  readonly renderersDisposed: number;
  readonly scenesCreated: number;
  readonly scenesDisposed: number;
}

interface VisualResourceSnapshot {
  readonly atmosphereShells: number;
  readonly blackHoleEffects: number;
  readonly blackHoleSprites: number;
  readonly blackHoleTexturePool: BlackHoleTexturePoolSnapshot;
  readonly cloudLayers: number;
  readonly cloudShadows: number;
  readonly lifecycle: RenderLifecycleSnapshot;
  readonly planetaryRingMeshes: number;
  readonly sceneGraph: SceneResourceCounts;
  readonly textureCache: TextureCacheSnapshot;
}

interface BrowserHealth {
  readonly consoleMessages: string[];
  readonly pageErrors: string[];
  readonly requestFailures: { readonly errorText: string; readonly url: string }[];
}

function collectBrowserHealth(page: Page): BrowserHealth {
  const health: BrowserHealth = {
    consoleMessages: [],
    pageErrors: [],
    requestFailures: [],
  };
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      health.consoleMessages.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    health.pageErrors.push(error.message);
  });
  page.on('requestfailed', (request) => {
    health.requestFailures.push({
      errorText: request.failure()?.errorText ?? 'unknown request failure',
      url: request.url(),
    });
  });
  return health;
}

async function readResourceSnapshot(canvas: Locator): Promise<VisualResourceSnapshot> {
  const serialized = await canvas.getAttribute('data-visual-resource-counts');
  if (serialized === null) {
    throw new Error('画布缺少 data-visual-resource-counts');
  }
  return JSON.parse(serialized) as VisualResourceSnapshot;
}

async function readRenderFrameCount(canvas: Locator): Promise<number> {
  const count = Number(await canvas.getAttribute('data-render-frame-count'));
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`场景帧计数无效：${String(count)}`);
  }
  return count;
}

async function waitForRenderFrames(canvas: Locator, minimumAdvance = 3): Promise<void> {
  const initial = await readRenderFrameCount(canvas);
  await expect
    .poll(async () => await readRenderFrameCount(canvas))
    .toBeGreaterThanOrEqual(initial + minimumAdvance);
}

async function waitForFocus(canvas: Locator, bodyId: string | null): Promise<void> {
  await expect
    .poll(async () => {
      const cameraSerialized = await canvas.getAttribute('data-visual-camera-state');
      const originSerialized = await canvas.getAttribute('data-visual-origin-state');
      if (cameraSerialized === null || originSerialized === null) {
        return null;
      }
      const camera = JSON.parse(cameraSerialized) as { readonly transitionActive: boolean };
      const origin = JSON.parse(originSerialized) as { readonly bodyId: string | null };
      return { bodyId: origin.bodyId, transitionActive: camera.transitionActive };
    })
    .toEqual({ bodyId, transitionActive: false });
}

async function focusBody(page: Page, canvas: Locator, name: string, bodyId: string): Promise<void> {
  await page.getByRole('button', { name: `聚焦${name}`, exact: true }).click();
  await waitForFocus(canvas, bodyId);
}

async function showOverview(page: Page, canvas: Locator): Promise<void> {
  await page.getByRole('button', { name: '返回太阳系全景', exact: true }).click();
  await waitForFocus(canvas, null);
}

async function waitForLoadedWarmupAssets(canvas: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await readResourceSnapshot(canvas);
      return (
        snapshot.textureCache.loading === 0 &&
        snapshot.textureCache.waiters === 0 &&
        snapshot.textureCache.ready >= 4 &&
        snapshot.textureCache.references === snapshot.textureCache.ready
      );
    })
    .toBe(true);
}

async function createAndCancelDraft(page: Page, canvas: Locator): Promise<void> {
  const observatory = page.locator('main.observatory-shell');
  await page.getByRole('button', { name: '创造', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-mode', 'create');
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expect
    .poll(async () => {
      const simulationTime = await observatory.getAttribute('data-simulation-time-seconds');
      const snapshotTime = await observatory.getAttribute('data-body-snapshot-time-seconds');
      return simulationTime !== null && simulationTime === snapshotTime;
    })
    .toBe(true);
  await page.getByRole('radio', { name: '岩石行星 类地岩石行星' }).click();

  const bounds = await canvas.boundingBox();
  if (bounds === null) {
    throw new Error('创建草稿时无法读取画布边界');
  }
  const start = {
    x: bounds.x + bounds.width * 0.62,
    y: bounds.y + bounds.height * 0.45,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - Math.min(72, bounds.height * 0.1), { steps: 8 });
  await page.mouse.up();

  await expect(canvas).toHaveAttribute('data-creation-body-visual-count', '1');
  await expect(observatory).toHaveAttribute('data-creation-phase', 'ready', { timeout: 30_000 });
  await expect(canvas).toHaveAttribute('data-creation-trajectory-visual-count', '1');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-mode', 'observe');
  await expect(canvas).toHaveAttribute('data-creation-active', 'false');
  await expect(canvas).not.toHaveAttribute('data-creation-body-visual-count');
  await expect(canvas).not.toHaveAttribute('data-creation-trajectory-visual-count');
}

async function editAndCancel(page: Page): Promise<void> {
  const observatory = page.locator('main.observatory-shell');
  await page.getByRole('button', { name: '编辑参数', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-editing-active', 'true');
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  const radiusInput = page.locator('#body-edit-radius');
  await expect(radiusInput).toBeVisible({ timeout: 30_000 });
  const radius = Number(await radiusInput.inputValue());
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`编辑半径无效：${String(radius)}`);
  }
  await radiusInput.fill(String(radius + 1));
  await expect(observatory).toHaveAttribute('data-editing-phase', 'ready', { timeout: 30_000 });
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-editing-active', 'false');
}

async function expectResourcesReturnTo(
  canvas: Locator,
  expected: VisualResourceSnapshot,
): Promise<void> {
  await waitForRenderFrames(canvas);
  await expect.poll(async () => await readResourceSnapshot(canvas)).toEqual(expected);
}

async function waitForStableResourceSnapshot(
  page: Page,
  canvas: Locator,
): Promise<VisualResourceSnapshot> {
  let previous: VisualResourceSnapshot | null = null;
  let stableReads = 0;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await waitForRenderFrames(canvas, 2);
    await page.waitForTimeout(250);
    const current = await readResourceSnapshot(canvas);
    const cacheSettled = current.textureCache.loading === 0 && current.textureCache.waiters === 0;
    if (cacheSettled && previous !== null && JSON.stringify(current) === JSON.stringify(previous)) {
      stableReads += 1;
      if (stableReads >= 2) {
        return current;
      }
    } else {
      stableReads = 0;
    }
    previous = current;
  }
  throw new Error('完整资源快照没有达到稳定平台');
}

async function exerciseResourceCycle(
  page: Page,
  canvas: Locator,
  alternateViewport: { readonly height: number; readonly width: number },
): Promise<void> {
  await focusBody(page, canvas, '地球', 'earth');
  await focusBody(page, canvas, '土星', 'saturn');
  await showOverview(page, canvas);
  await createAndCancelDraft(page, canvas);
  await editAndCancel(page);
  await page.setViewportSize(alternateViewport);
  await waitForRenderFrames(canvas, 2);
  await page.setViewportSize({ height: 720, width: 1_280 });
}

test('重复观测、草稿取消、编辑取消和 resize 后资源回到稳定平台', async ({ page }) => {
  test.setTimeout(120_000);
  const health = collectBrowserHealth(page);
  await page.setViewportSize({ height: 720, width: 1_280 });
  await page.goto('/?visualDiagnostics=1&markerDiagnostics=1');

  const observatory = page.locator('main.observatory-shell');
  const canvas = page.locator('canvas[data-renderer-backend]');
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();

  await focusBody(page, canvas, '地球', 'earth');
  await focusBody(page, canvas, '土星', 'saturn');
  await waitForLoadedWarmupAssets(canvas);
  await showOverview(page, canvas);
  await exerciseResourceCycle(page, canvas, { height: 650, width: 1_140 });
  await waitForLoadedWarmupAssets(canvas);
  const baseline = await waitForStableResourceSnapshot(page, canvas);
  expect(baseline.lifecycle).toMatchObject({ activeRenderers: 1, activeScenes: 1 });

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await exerciseResourceCycle(page, canvas, {
      height: 660 + cycle * 10,
      width: 1_160 + cycle * 20,
    });

    await expectResourcesReturnTo(canvas, baseline);
    await expect(canvas).toHaveCount(1);
    await expect(observatory).toHaveAttribute('data-mode', 'observe');
  }

  expect(health.consoleMessages, '资源稳定流程存在 console warning/error').toEqual([]);
  expect(health.pageErrors, '资源稳定流程存在 pageerror').toEqual([]);
  expect(health.requestFailures, '资源稳定流程存在 requestfailed').toEqual([]);
});

test('场景分块首次失败后重试只保留一个 Scene、Renderer 和 canvas', async ({ page }) => {
  test.setTimeout(60_000);
  const health = collectBrowserHealth(page);
  await page.setViewportSize({ height: 720, width: 1_280 });
  await page.addInitScript(() => {
    const trackedWindow = window as typeof window & {
      __staryCreatedCanvases: HTMLCanvasElement[];
    };
    trackedWindow.__staryCreatedCanvases = [];
    type CreateElement = (
      this: Document,
      localName: string,
      options?: ElementCreationOptions,
    ) => HTMLElement;
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'createElement');
    if (typeof descriptor?.value !== 'function') {
      throw new Error('无法追踪 Document.createElement');
    }
    const originalCreateElement = descriptor.value as CreateElement;
    Object.defineProperty(document, 'createElement', {
      configurable: true,
      value(this: Document, localName: string, options?: ElementCreationOptions) {
        const element = originalCreateElement.call(this, localName, options);
        if (element instanceof HTMLCanvasElement) {
          trackedWindow.__staryCreatedCanvases.push(element);
        }
        return element;
      },
    });
  });

  const sceneChunkPattern = '**/observatory-scene-*.js';
  let failedSceneChunkUrl: string | null = null;
  await page.route(sceneChunkPattern, async (route) => {
    failedSceneChunkUrl = route.request().url();
    await route.abort('failed');
  });
  await page.goto('/?visualDiagnostics=1&markerDiagnostics=1');

  await expect(page.getByText('模拟已安全暂停')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(page.locator('canvas[data-renderer-backend]')).toHaveCount(0);
  await page.unroute(sceneChunkPattern);
  await page.getByRole('button', { name: '重试', exact: true }).click();

  const canvas = page.locator('canvas[data-renderer-backend]');
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();
  await waitForRenderFrames(canvas);
  const resources = await readResourceSnapshot(canvas);
  expect(resources.lifecycle).toEqual({
    activeRenderers: 1,
    activeScenes: 1,
    renderersCreated: 2,
    renderersDisposed: 1,
    scenesCreated: 1,
    scenesDisposed: 0,
  });

  const canvasStates = await page.evaluate(() => {
    const trackedWindow = window as typeof window & {
      readonly __staryCreatedCanvases: readonly HTMLCanvasElement[];
    };
    return trackedWindow.__staryCreatedCanvases.map((createdCanvas) => ({
      connected: createdCanvas.isConnected,
      rendererBackend: createdCanvas.dataset.rendererBackend ?? null,
    }));
  });
  expect(canvasStates.length).toBeGreaterThanOrEqual(2);
  expect(canvasStates.filter((state) => state.connected)).toHaveLength(1);
  expect(canvasStates.at(-1)?.connected).toBe(true);
  expect(canvasStates.slice(0, -1).every((state) => !state.connected)).toBe(true);

  expect(failedSceneChunkUrl).not.toBeNull();
  expect(health.requestFailures).toHaveLength(1);
  expect(health.requestFailures[0]?.url).toBe(failedSceneChunkUrl);
  expect(health.requestFailures[0]?.errorText.length ?? 0).toBeGreaterThan(0);
  const expectedNetworkConsoleMessages = health.consoleMessages.filter((message) =>
    message.startsWith('console.error: Failed to load resource:'),
  );
  const unexpectedConsoleMessages = health.consoleMessages.filter(
    (message) => !expectedNetworkConsoleMessages.includes(message),
  );
  expect(expectedNetworkConsoleMessages.length).toBeLessThanOrEqual(health.requestFailures.length);
  expect(unexpectedConsoleMessages, '分块失败恢复产生额外 console warning/error').toEqual([]);
  expect(health.pageErrors, '分块失败恢复产生 pageerror').toEqual([]);
});
