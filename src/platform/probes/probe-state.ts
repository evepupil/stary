export type ProbeStatus = 'loading' | 'ready' | 'error';

export interface ProbeState {
  readonly message: string;
  readonly status: ProbeStatus;
}

export function createProbeState(status: ProbeStatus, message: string): ProbeState {
  return { message, status };
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return '未知错误';
}
