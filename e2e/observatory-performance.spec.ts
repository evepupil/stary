import { expect, test } from '@playwright/test';

const SAMPLE_DURATION_MILLISECONDS = 2_000;

interface PerformanceSample {
  readonly browserVersion: string;
  readonly durationMilliseconds: number;
  readonly rafFrames: number;
  readonly rafFramesPerSecond: number;
  readonly rendererBackend: string;
  readonly stateSequenceAdvance: number;
  readonly stateSequenceAdvancePerSecond: number;
  readonly viewport: { readonly height: number; readonly width: number };
}

test('记录当前观测台两秒画面和 Worker 状态频率', async ({ browserName, page }) => {
  await page.goto('/');

  const observatory = page.locator('main.observatory-shell');
  const canvas = page.locator('canvas[data-renderer-backend]');
  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => Number(await observatory.getAttribute('data-worker-state-sequence')))
    .toBeGreaterThan(0);

  const measured = await page.evaluate(async (sampleDurationMilliseconds) => {
    const root = document.querySelector<HTMLElement>('main.observatory-shell');
    if (root === null) {
      throw new Error('观测台根节点缺失');
    }

    const readStateSequence = () => {
      const value = Number(root.dataset.workerStateSequence);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Worker state sequence 无效：${String(value)}`);
      }
      return value;
    };

    const startSequence = readStateSequence();
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

    const durationMilliseconds = performance.now() - startedAt;
    return {
      durationMilliseconds,
      rafFrames,
      stateSequenceAdvance: readStateSequence() - startSequence,
    };
  }, SAMPLE_DURATION_MILLISECONDS);

  expect(measured.durationMilliseconds).toBeGreaterThanOrEqual(SAMPLE_DURATION_MILLISECONDS);
  expect(measured.rafFrames).toBeGreaterThan(0);
  expect(measured.stateSequenceAdvance).toBeGreaterThan(0);

  const rendererBackend = await canvas.getAttribute('data-renderer-backend');
  expect(rendererBackend).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const browserVersion = page.context().browser()?.version() ?? `${browserName} unknown`;
  const durationSeconds = measured.durationMilliseconds / 1_000;
  const sample: PerformanceSample = {
    browserVersion,
    durationMilliseconds: Number(measured.durationMilliseconds.toFixed(2)),
    rafFrames: measured.rafFrames,
    rafFramesPerSecond: Number((measured.rafFrames / durationSeconds).toFixed(2)),
    rendererBackend: rendererBackend ?? 'unknown',
    stateSequenceAdvance: measured.stateSequenceAdvance,
    stateSequenceAdvancePerSecond: Number(
      (measured.stateSequenceAdvance / durationSeconds).toFixed(2),
    ),
    viewport: viewport ?? { height: 0, width: 0 },
  };

  process.stdout.write(`\nOBSERVATORY_PERFORMANCE_SAMPLE ${JSON.stringify(sample)}\n`);
});
