import {
  generateTrajectoryPreview,
  type CreateTrajectoryPreviewSimulation,
} from './generate-trajectory-preview';
import {
  ORBIT_PREVIEW_PROTOCOL_VERSION,
  trajectoryPreviewErrorSchema,
  trajectoryPreviewRequestSchema,
  trajectoryPreviewResultSchema,
  type TrajectoryPreviewError,
  type TrajectoryPreviewResponse,
} from './schemas';

export interface OrbitPreviewRuntimeOptions {
  readonly closeWorker: () => void;
  readonly createSimulation: CreateTrajectoryPreviewSimulation;
  readonly postMessage: (message: TrajectoryPreviewResponse) => void;
}

export class OrbitPreviewRuntime {
  readonly #closeWorker: () => void;
  readonly #createSimulation: CreateTrajectoryPreviewSimulation;
  readonly #postMessage: (message: TrajectoryPreviewResponse) => void;
  #handled = false;

  constructor(options: OrbitPreviewRuntimeOptions) {
    this.#closeWorker = options.closeWorker;
    this.#createSimulation = options.createSimulation;
    this.#postMessage = options.postMessage;
  }

  async receive(input: unknown): Promise<void> {
    if (this.#handled) {
      return;
    }
    this.#handled = true;

    const parsed = trajectoryPreviewRequestSchema.safeParse(input);
    if (!parsed.success) {
      try {
        this.#respondWithError({
          version: ORBIT_PREVIEW_PROTOCOL_VERSION,
          type: 'trajectoryPreviewError',
          requestId: null,
          draftRevision: null,
          code: 'invalidRequest',
          message: '轨道预览请求未通过协议校验',
        });
      } finally {
        this.#closeWorker();
      }
      return;
    }

    try {
      const result = await generateTrajectoryPreview(parsed.data, this.#createSimulation);
      this.#postMessage(trajectoryPreviewResultSchema.parse(result));
    } catch (error) {
      this.#respondWithError({
        version: ORBIT_PREVIEW_PROTOCOL_VERSION,
        type: 'trajectoryPreviewError',
        requestId: parsed.data.requestId,
        draftRevision: parsed.data.draftRevision,
        code: 'previewFailed',
        message: describeError(error),
      });
    } finally {
      this.#closeWorker();
    }
  }

  reportMessageError(): void {
    if (this.#handled) {
      return;
    }
    this.#handled = true;
    try {
      this.#respondWithError({
        version: ORBIT_PREVIEW_PROTOCOL_VERSION,
        type: 'trajectoryPreviewError',
        requestId: null,
        draftRevision: null,
        code: 'messageError',
        message: '轨道预览 Worker 收到无法反序列化的消息',
      });
    } finally {
      this.#closeWorker();
    }
  }

  #respondWithError(error: TrajectoryPreviewError): void {
    this.#postMessage(trajectoryPreviewErrorSchema.parse(error));
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知轨道预览错误';
  return message.slice(0, 1_024) || '未知轨道预览错误';
}
