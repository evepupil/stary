import { expect, test, type Locator, type Page } from '@playwright/test';

const SAMPLE_DURATION_MILLISECONDS = 5_000;
const SAMPLE_COUNT = 3;
const WARMUP_RENDER_FRAMES = 60;
const M1_WORKER_STATE_FREQUENCY_PER_SECOND = 33.36;
const MINIMUM_RAF_FREQUENCY_PER_SECOND = 48;
const MINIMUM_RENDER_FREQUENCY_PER_SECOND = 48;
const MINIMUM_WORKER_STATE_FREQUENCY_PER_SECOND = M1_WORKER_STATE_FREQUENCY_PER_SECOND * 0.8;

interface TextureCacheSnapshot {
  readonly disposed: boolean;
  readonly loading: number;
  readonly ready: number;
  readonly references: number;
  readonly waiters: number;
}

interface VisualResourceCounts {
  readonly atmosphereShells: number;
  readonly blackHoleEffects: number;
  readonly blackHoleSprites: number;
  readonly cloudLayers: number;
  readonly cloudShadows: number;
  readonly planetaryRingMeshes: number;
  readonly textureCache: TextureCacheSnapshot;
}

interface ResourceSnapshot {
  readonly activeLights: number;
  readonly lod: { readonly high: number; readonly low: number; readonly medium: number };
  readonly visual: VisualResourceCounts;
}

interface PerformanceMeasurement {
  readonly durationMilliseconds: number;
  readonly rafFrames: number;
  readonly renderFrameAdvance: number;
  readonly stateSequenceAdvance: number;
}

interface PerformanceSample extends PerformanceMeasurement {
  readonly index: number;
  readonly rafFramesPerSecond: number;
  readonly renderFramesPerSecond: number;
  readonly resourcesAfter: ResourceSnapshot;
  readonly resourcesBefore: ResourceSnapshot;
  readonly stateSequenceAdvancePerSecond: number;
}

interface MetricSummary {
  readonly maximum: number;
  readonly median: number;
  readonly minimum: number;
}

interface PerformanceScenarioDefinition {
  readonly focusBodyName: string | null;
  readonly forceWebGl2: boolean;
  readonly id: string;
  readonly mobile: boolean;
  readonly viewport: { readonly height: number; readonly width: number };
}

interface PerformanceScenarioResult {
  readonly browserVersion: string;
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly metrics: {
    readonly durationMilliseconds: MetricSummary;
    readonly rafFramesPerSecond: MetricSummary;
    readonly renderFramesPerSecond: MetricSummary;
    readonly stateSequenceAdvancePerSecond: MetricSummary;
  };
  readonly renderScaleTier: string;
  readonly rendererBackend: string;
  readonly resourceBaseline: ResourceSnapshot;
  readonly resourceFinal: ResourceSnapshot;
  readonly samples: readonly PerformanceSample[];
  readonly view: 'focus' | 'overview';
  readonly viewport: { readonly height: number; readonly width: number };
  readonly webGpuAvailable: boolean;
}

const PERFORMANCE_SCENARIOS: readonly PerformanceScenarioDefinition[] = [
  {
    focusBodyName: null,
    forceWebGl2: false,
    id: 'desktop-overview-default',
    mobile: false,
    viewport: { height: 900, width: 1_440 },
  },
  {
    focusBodyName: '地球',
    forceWebGl2: false,
    id: 'desktop-earth-default',
    mobile: false,
    viewport: { height: 900, width: 1_440 },
  },
  {
    focusBodyName: '地球',
    forceWebGl2: true,
    id: 'desktop-earth-webgl2',
    mobile: false,
    viewport: { height: 900, width: 1_440 },
  },
  {
    focusBodyName: '地球',
    forceWebGl2: true,
    id: 'mobile-earth-webgl2',
    mobile: true,
    viewport: { height: 844, width: 390 },
  },
];

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

async function readJsonAttribute<T>(locator: Locator, name: string): Promise<T> {
  const serialized = await locator.getAttribute(name);
  if (serialized === null) {
    throw new Error(`性能诊断缺少 ${name}`);
  }
  return JSON.parse(serialized) as T;
}

async function readResourceSnapshot(canvas: Locator): Promise<ResourceSnapshot> {
  const activeLights = Number(await canvas.getAttribute('data-visual-active-light-count'));
  if (!Number.isSafeInteger(activeLights) || activeLights < 0) {
    throw new Error(`活跃灯光计数无效：${String(activeLights)}`);
  }
  return {
    activeLights,
    lod: await readJsonAttribute<ResourceSnapshot['lod']>(canvas, 'data-visual-lod-counts'),
    visual: await readJsonAttribute<VisualResourceCounts>(canvas, 'data-visual-resource-counts'),
  };
}

async function waitForStableResources(canvas: Locator): Promise<ResourceSnapshot> {
  let previous = await readResourceSnapshot(canvas);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const current = await readResourceSnapshot(canvas);
    const textureCacheSettled =
      current.visual.textureCache.loading === 0 && current.visual.textureCache.waiters === 0;
    if (textureCacheSettled && JSON.stringify(current) === JSON.stringify(previous)) {
      return current;
    }
    previous = current;
  }
  throw new Error('视觉资源在预热窗口内没有达到稳定平台');
}

async function focusRepresentativeBody(
  page: Page,
  canvas: Locator,
  definition: PerformanceScenarioDefinition,
): Promise<void> {
  if (definition.focusBodyName === null) {
    await expect(page.locator('main.observatory-shell')).toHaveAttribute(
      'data-view-mode',
      'overview',
    );
    await expect(canvas).toHaveAttribute('data-render-scale-tier', 'system');
    return;
  }

  if (definition.mobile) {
    await page.getByRole('button', { name: '天体目录', exact: true }).click();
  }
  await page.getByRole('button', { name: `聚焦${definition.focusBodyName}`, exact: true }).click();
  if (definition.mobile) {
    await page.getByRole('button', { name: '关闭天体数据', exact: true }).click();
  }

  await expect(page.locator('main.observatory-shell')).toHaveAttribute('data-view-mode', 'focus');
  await expect
    .poll(async () => {
      const camera = await readJsonAttribute<{ readonly transitionActive: boolean }>(
        canvas,
        'data-visual-camera-state',
      );
      return camera.transitionActive;
    })
    .toBe(false);
  if (definition.mobile) {
    await expect
      .poll(async () => await canvas.getAttribute('data-render-scale-tier'))
      .not.toBe('system');
  } else {
    await expect(canvas).toHaveAttribute('data-render-scale-tier', 'surface');
  }
}

async function measurePerformance(page: Page): Promise<PerformanceMeasurement> {
  return page.evaluate(async (sampleDurationMilliseconds) => {
    const root = document.querySelector<HTMLElement>('main.observatory-shell');
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-renderer-backend]');
    if (root === null || canvas === null) {
      throw new Error('性能采样缺少观测台或画布');
    }

    const readSafeSequence = (value: string | undefined, label: string): number => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${label} 无效：${String(value)}`);
      }
      return parsed;
    };
    const readStateSequence = (): number =>
      readSafeSequence(root.dataset.workerStateSequence, 'Worker state sequence');
    const readRenderFrameCount = (): number =>
      readSafeSequence(canvas.dataset.renderFrameCount, 'render frame count');

    const startSequence = readStateSequence();
    const startRenderFrameCount = readRenderFrameCount();
    const startedAt = performance.now();
    let rafFrames = 0;

    await new Promise<void>((resolve) => {
      const sampleFrame = (timestamp: number) => {
        rafFrames += 1;
        if (timestamp - startedAt >= sampleDurationMilliseconds) {
          resolve();
          return;
        }
        requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
    });

    return {
      durationMilliseconds: performance.now() - startedAt,
      rafFrames,
      renderFrameAdvance: readRenderFrameCount() - startRenderFrameCount,
      stateSequenceAdvance: readStateSequence() - startSequence,
    };
  }, SAMPLE_DURATION_MILLISECONDS);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function summarize(values: readonly number[]): MetricSummary {
  if (values.length === 0) {
    throw new Error('性能汇总缺少样本');
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return {
    maximum: round(sorted.at(-1) ?? 0),
    median: round(median),
    minimum: round(sorted[0] ?? 0),
  };
}

function summarizeScenario(
  definition: PerformanceScenarioDefinition,
  browserVersion: string,
  rendererBackend: string,
  renderScaleTier: string,
  diagnostics: readonly string[],
  webGpuAvailable: boolean,
  resourceBaseline: ResourceSnapshot,
  samples: readonly PerformanceSample[],
): PerformanceScenarioResult {
  return {
    browserVersion,
    diagnostics,
    id: definition.id,
    metrics: {
      durationMilliseconds: summarize(samples.map((sample) => sample.durationMilliseconds)),
      rafFramesPerSecond: summarize(samples.map((sample) => sample.rafFramesPerSecond)),
      renderFramesPerSecond: summarize(samples.map((sample) => sample.renderFramesPerSecond)),
      stateSequenceAdvancePerSecond: summarize(
        samples.map((sample) => sample.stateSequenceAdvancePerSecond),
      ),
    },
    renderScaleTier,
    rendererBackend,
    resourceBaseline,
    resourceFinal: samples.at(-1)?.resourcesAfter ?? resourceBaseline,
    samples,
    view: definition.focusBodyName === null ? 'overview' : 'focus',
    viewport: definition.viewport,
    webGpuAvailable,
  };
}

test('记录 M2 预热后四场景五秒性能矩阵', async ({ baseURL, browser, browserName }) => {
  test.setTimeout(150_000);
  if (baseURL === undefined) {
    throw new Error('Playwright 配置缺少 baseURL');
  }

  const browserVersion = browser.version() || `${browserName} unknown`;
  const scenarioResults: PerformanceScenarioResult[] = [];

  for (const definition of PERFORMANCE_SCENARIOS) {
    const context = await browser.newContext({ baseURL, viewport: definition.viewport });
    if (definition.forceWebGl2) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: undefined,
        });
      });
    }
    const page = await context.newPage();
    const diagnostics = collectBrowserDiagnostics(page);

    try {
      await page.goto('/?visualDiagnostics=1');
      await expect(page).toHaveTitle('STARY');
      await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
      const canvas = page.locator('canvas[data-renderer-backend]');
      await expect(canvas).toBeVisible();
      const webGpuAvailable = await page.evaluate(async () => {
        if (!('gpu' in navigator)) {
          return false;
        }
        try {
          return (await navigator.gpu.requestAdapter()) !== null;
        } catch {
          return false;
        }
      });
      if (definition.forceWebGl2) {
        await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgl2');
      } else if (!definition.mobile && webGpuAvailable) {
        await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgpu');
      }
      await expect
        .poll(async () => Number(await canvas.getAttribute('data-render-frame-count')))
        .toBeGreaterThan(WARMUP_RENDER_FRAMES);
      await expect
        .poll(async () =>
          Number(
            await page.locator('main.observatory-shell').getAttribute('data-worker-state-sequence'),
          ),
        )
        .toBeGreaterThan(0);
      await focusRepresentativeBody(page, canvas, definition);
      const resourceBaseline = await waitForStableResources(canvas);
      const samples: PerformanceSample[] = [];

      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const resourcesBefore = await readResourceSnapshot(canvas);
        const measured = await measurePerformance(page);
        const resourcesAfter = await readResourceSnapshot(canvas);
        const durationSeconds = measured.durationMilliseconds / 1_000;
        samples.push({
          ...measured,
          index: index + 1,
          rafFramesPerSecond: round(measured.rafFrames / durationSeconds),
          renderFramesPerSecond: round(measured.renderFrameAdvance / durationSeconds),
          resourcesAfter,
          resourcesBefore,
          stateSequenceAdvancePerSecond: round(measured.stateSequenceAdvance / durationSeconds),
        });
      }

      scenarioResults.push(
        summarizeScenario(
          definition,
          browserVersion,
          (await canvas.getAttribute('data-renderer-backend')) ?? 'unknown',
          (await canvas.getAttribute('data-render-scale-tier')) ?? 'unknown',
          diagnostics,
          webGpuAvailable,
          resourceBaseline,
          samples,
        ),
      );
    } finally {
      await context.close();
    }
  }

  const matrix = {
    browserName,
    browserVersion,
    minimumRafFrequencyPerSecond: MINIMUM_RAF_FREQUENCY_PER_SECOND,
    minimumRenderFrequencyPerSecond: MINIMUM_RENDER_FREQUENCY_PER_SECOND,
    minimumWorkerStateFrequencyPerSecond: round(MINIMUM_WORKER_STATE_FREQUENCY_PER_SECOND),
    sampleCount: SAMPLE_COUNT,
    sampleDurationMilliseconds: SAMPLE_DURATION_MILLISECONDS,
    scenarios: scenarioResults,
    schemaVersion: 1,
    warmupRenderFrames: WARMUP_RENDER_FRAMES,
  };
  process.stdout.write(`\nOBSERVATORY_PERFORMANCE_MATRIX ${JSON.stringify(matrix)}\n`);

  expect(scenarioResults).toHaveLength(PERFORMANCE_SCENARIOS.length);
  for (const scenario of scenarioResults) {
    expect(scenario.samples).toHaveLength(SAMPLE_COUNT);
    expect(scenario.diagnostics, `${scenario.id} 存在 console warning/error`).toEqual([]);
    expect(scenario.resourceFinal, `${scenario.id} 资源计数未保持稳定`).toEqual(
      scenario.resourceBaseline,
    );
    expect(
      scenario.metrics.rafFramesPerSecond.median,
      `${scenario.id} 页面 RAF 中位频率低于 48 次/秒`,
    ).toBeGreaterThanOrEqual(MINIMUM_RAF_FREQUENCY_PER_SECOND);
    expect(
      scenario.metrics.renderFramesPerSecond.median,
      `${scenario.id} 实际场景帧中位频率低于 48 次/秒`,
    ).toBeGreaterThanOrEqual(MINIMUM_RENDER_FREQUENCY_PER_SECOND);
    expect(
      scenario.metrics.stateSequenceAdvancePerSecond.median,
      `${scenario.id} Worker state 中位频率低于 M1 基线的 80%`,
    ).toBeGreaterThanOrEqual(round(MINIMUM_WORKER_STATE_FREQUENCY_PER_SECOND));

    for (const sample of scenario.samples) {
      expect(sample.durationMilliseconds).toBeGreaterThanOrEqual(SAMPLE_DURATION_MILLISECONDS);
      expect(sample.rafFrames, `${scenario.id} 页面 RAF 停止`).toBeGreaterThan(0);
      expect(sample.renderFrameAdvance, `${scenario.id} 实际场景帧停止`).toBeGreaterThan(0);
      expect(sample.stateSequenceAdvance, `${scenario.id} Worker state 停止`).toBeGreaterThan(0);
      expect(
        sample.renderFrameAdvance / sample.rafFrames,
        `${scenario.id} 实际场景帧没有跟随页面 RAF`,
      ).toBeGreaterThanOrEqual(0.8);
      expect(sample.resourcesBefore, `${scenario.id} 样本期间资源计数发生变化`).toEqual(
        sample.resourcesAfter,
      );
    }
  }
});
