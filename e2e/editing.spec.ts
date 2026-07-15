import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function expectSynchronizedEditingSnapshot(
  observatory: Locator,
  operation: 'edit' | 'delete',
): Promise<string> {
  await expect(observatory).toHaveAttribute('data-editing-active', 'true');
  await expect(observatory).toHaveAttribute('data-editing-operation', operation);
  await expect
    .poll(async () => {
      const simulationTime = await observatory.getAttribute('data-simulation-time-seconds');
      const snapshotTime = await observatory.getAttribute('data-body-snapshot-time-seconds');
      return simulationTime !== null && simulationTime === snapshotTime;
    })
    .toBe(true);

  const frozenTime = await observatory.getAttribute('data-simulation-time-seconds');
  if (frozenTime === null) {
    throw new Error('观测台缺少暂停后的模拟时间');
  }
  return frozenTime;
}

test('桌面编辑会冻结时间、校验输入、接受最终预览并原子提交', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.goto('/?markerDiagnostics=1');
  const observatory = page.locator('main.observatory-shell');
  const editButton = page.getByRole('button', { name: '编辑参数', exact: true });

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(observatory).toHaveAttribute('data-body-revision', '0');

  await editButton.click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expectSynchronizedEditingSnapshot(observatory, 'edit');
  await expect(page.locator('#body-edit-mass')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-editing-active', 'false');
  await expect(page.getByText('模拟运行中')).toBeVisible();
  await expect(observatory).toHaveAttribute('data-body-revision', '0');

  await editButton.click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  const frozenTime = await expectSynchronizedEditingSnapshot(observatory, 'edit');
  const massInput = page.locator('#body-edit-mass');
  const radiusInput = page.locator('#body-edit-radius');
  const confirmButton = page.getByRole('button', { name: '确认修改', exact: true });
  await expect(massInput).toBeVisible({ timeout: 30_000 });
  const originalMass = await massInput.inputValue();

  await massInput.fill('0');
  await expect(massInput).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('质量必须大于 0', { exact: true })).toBeVisible();
  await expect(confirmButton).toBeDisabled();
  await expect(observatory).toHaveAttribute('data-editing-accepted-preview-revision', 'none');

  await massInput.fill(originalMass);
  await radiusInput.fill('6400');
  await radiusInput.fill('6500');
  await radiusInput.fill('6600');
  await expect(radiusInput).toHaveValue('6600');
  await expect(observatory).toHaveAttribute('data-simulation-time-seconds', frozenTime);
  await expect(observatory).toHaveAttribute('data-editing-phase', 'ready', { timeout: 30_000 });
  await expect(confirmButton).toBeEnabled();
  const candidateRevision = await observatory.getAttribute('data-editing-candidate-revision');
  const acceptedPreviewRevision = await observatory.getAttribute(
    'data-editing-accepted-preview-revision',
  );
  expect(acceptedPreviewRevision).not.toBe('none');
  expect(acceptedPreviewRevision).toBe(candidateRevision);

  await confirmButton.click();
  await expect(observatory).toHaveAttribute('data-editing-active', 'false');
  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(observatory).toHaveAttribute('data-simulation-time-seconds', frozenTime);
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expect(page.getByRole('complementary', { name: '天体参数编辑' })).toBeHidden();
  await expect(page.getByText('6,600 km', { exact: true })).toBeVisible();

  expect(browserDiagnostics, '桌面编辑流程存在 console warning/error').toEqual([]);
});

test('删除聚焦月球后回退选择并聚焦地球', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.goto('/?markerDiagnostics=1');
  const observatory = page.locator('main.observatory-shell');
  const directory = page.getByRole('complementary', { name: '天体目录' });
  const moonButton = page.getByRole('button', { name: '聚焦月球', exact: true });

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await moonButton.click();
  await expect(moonButton).toHaveAttribute('aria-current', 'true');
  await expect(observatory).toHaveAttribute('data-view-mode', 'focus');
  await page.getByRole('button', { name: '删除天体', exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: '删除 月球？', exact: true });
  const cancelButton = dialog.getByRole('button', { name: '取消删除', exact: true });
  const confirmButton = dialog.getByRole('button', { name: '确认删除', exact: true });
  await expect(dialog).toBeVisible();
  await expect(cancelButton).toBeFocused();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  const frozenTime = await expectSynchronizedEditingSnapshot(observatory, 'delete');
  await expect(confirmButton).toBeEnabled();
  await page.keyboard.press('Shift+Tab');
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancelButton).toBeFocused();

  await confirmButton.click();
  await expect(dialog).toBeHidden();
  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(observatory).toHaveAttribute('data-simulation-time-seconds', frozenTime);
  await expect(directory.locator('[role="listitem"]')).toHaveCount(9);
  await expect(moonButton).toHaveCount(0);
  const earthButton = page.getByRole('button', { name: '聚焦地球', exact: true });
  await expect(earthButton).toHaveAttribute('data-selected', 'true');
  await expect(earthButton).toHaveAttribute('aria-current', 'true');
  await expect(observatory).toHaveAttribute('data-view-mode', 'focus');
  await expect(page.getByRole('button', { name: '删除天体', exact: true })).toBeFocused();

  expect(browserDiagnostics, '月球删除流程存在 console warning/error').toEqual([]);
});

test('手机编辑面板保留画布、支持滚动并隐藏时间控制', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/?markerDiagnostics=1');
  const observatory = page.locator('main.observatory-shell');

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '天体数据', exact: true }).click();
  await page.getByRole('button', { name: '编辑参数', exact: true }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expectSynchronizedEditingSnapshot(observatory, 'edit');

  const panel = page.getByRole('complementary', { name: '天体参数编辑' });
  const canvas = page.locator('canvas[data-renderer-backend]');
  const massInput = page.locator('#body-edit-mass');
  await expect(massInput).toBeVisible({ timeout: 30_000 });
  const panelBounds = await panel.boundingBox();
  const canvasBounds = await canvas.boundingBox();
  expect(panelBounds).not.toBeNull();
  expect(canvasBounds).not.toBeNull();
  if (panelBounds !== null && canvasBounds !== null) {
    expect(panelBounds.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(390);
    expect(panelBounds.y).toBeGreaterThan(844 * 0.38);
    expect(panelBounds.y + panelBounds.height).toBeLessThanOrEqual(844);
    expect(canvasBounds.y).toBeLessThan(panelBounds.y);
  }
  await expect(page.getByRole('region', { name: '时间控制' })).toBeHidden();

  await massInput.fill('0');
  await page.locator('#body-edit-radius').fill('-1');
  await page.locator('#body-edit-position-x').fill('');
  await expect(page.getByText('X 位置不能为空', { exact: true })).toBeVisible();
  const scrollMetrics = await panel.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  await panel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () => await panel.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '取消编辑', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-editing-active', 'false');
  await expect(page.getByText('模拟运行中')).toBeVisible();
  expect(browserDiagnostics, '手机编辑流程存在 console warning/error').toEqual([]);
});

test('WebGL2 编辑冲突会保留字段，重同步后可成功提交', async ({ page }) => {
  const browserDiagnostics = collectBrowserDiagnostics(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });

    const NativeWorker = window.Worker;
    let injectRevisionConflict = true;
    const TrackingWorker = new Proxy(NativeWorker, {
      construct(target, argumentsList) {
        const worker = Reflect.construct(target, argumentsList, target) as Worker;
        const workerUrl: unknown = argumentsList[0];
        if (String(workerUrl).includes('physics.worker')) {
          const postMessage = worker.postMessage.bind(worker);
          worker.postMessage = (message: unknown): void => {
            let submittedMessage = message;
            if (
              injectRevisionConflict &&
              typeof message === 'object' &&
              message !== null &&
              (message as { readonly type?: unknown }).type === 'replaceBodies'
            ) {
              const expectedBodyRevision = (message as { readonly expectedBodyRevision?: unknown })
                .expectedBodyRevision;
              if (typeof expectedBodyRevision === 'number') {
                injectRevisionConflict = false;
                submittedMessage = { ...message, expectedBodyRevision: expectedBodyRevision + 1 };
              }
            }
            postMessage(submittedMessage);
          };
        }
        return worker;
      },
    });
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: TrackingWorker,
      writable: true,
    });
  });
  await page.goto('/?markerDiagnostics=1');
  const observatory = page.locator('main.observatory-shell');
  const canvas = page.locator('canvas[data-renderer-backend]');
  const radiusInput = page.locator('#body-edit-radius');
  const confirmButton = page.getByRole('button', { name: '确认修改', exact: true });

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgl2');
  await page.getByRole('button', { name: '编辑参数', exact: true }).click();
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  const frozenTime = await expectSynchronizedEditingSnapshot(observatory, 'edit');
  await expect(radiusInput).toBeVisible({ timeout: 30_000 });
  await radiusInput.fill('6600');
  await expect(observatory).toHaveAttribute('data-editing-phase', 'ready', { timeout: 30_000 });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(observatory).toHaveAttribute('data-editing-phase', 'conflicted');
  await expect(observatory).toHaveAttribute('data-body-revision', '0');
  await expect(observatory).toHaveAttribute('data-simulation-time-seconds', frozenTime);
  await expect(radiusInput).toHaveValue('6600');
  await expect(radiusInput).toBeDisabled();
  await expect(confirmButton).toBeDisabled();
  await expect(page.getByText('正式状态已经变化', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '重新同步', exact: true }).click();
  await expect(radiusInput).toHaveValue('6600');
  await expect(observatory).toHaveAttribute('data-editing-phase', 'ready', { timeout: 30_000 });
  const candidateRevision = await observatory.getAttribute('data-editing-candidate-revision');
  const acceptedPreviewRevision = await observatory.getAttribute(
    'data-editing-accepted-preview-revision',
  );
  expect(acceptedPreviewRevision).not.toBe('none');
  expect(acceptedPreviewRevision).toBe(candidateRevision);
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(observatory).toHaveAttribute('data-editing-active', 'false');
  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(observatory).toHaveAttribute('data-simulation-time-seconds', frozenTime);
  await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgl2');
  await expect(page.getByText('6,600 km', { exact: true })).toBeVisible();
  expect(browserDiagnostics, 'WebGL2 编辑冲突恢复流程存在 console warning/error').toEqual([]);
});

test('WebGPU 不可用时可在 WebGL2 中删除天体', async ({ page }) => {
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

  await expect(page.getByText('模拟运行中')).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgl2');
  await page.getByRole('button', { name: '删除天体', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '删除 地球？', exact: true });
  const confirmButton = dialog.getByRole('button', { name: '确认删除', exact: true });
  await expect(page.getByText('模拟已暂停')).toBeVisible();
  await expectSynchronizedEditingSnapshot(observatory, 'delete');
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(dialog).toBeHidden();
  await expect(observatory).toHaveAttribute('data-body-revision', '1');
  await expect(canvas).toHaveAttribute('data-renderer-backend', 'webgl2');
  expect(browserDiagnostics, 'WebGL2 删除流程存在 console warning/error').toEqual([]);
});
