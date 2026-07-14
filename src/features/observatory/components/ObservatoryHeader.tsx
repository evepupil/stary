import type { RendererBackend } from '../rendering';

interface ObservatoryHeaderProps {
  readonly backend: RendererBackend | null;
  readonly runState: 'idle' | 'initialized' | 'paused' | 'running';
  readonly simulationTime: string;
}

const runStateLabels = {
  idle: '等待物理核心',
  initialized: '已初始化',
  running: '模拟运行中',
  paused: '模拟已暂停',
} as const;

export function ObservatoryHeader({ backend, runState, simulationTime }: ObservatoryHeaderProps) {
  return (
    <header className="observatory-header">
      <div className="observatory-brand">
        <strong>STARY</strong>
        <span>太阳系多体观测台</span>
      </div>
      <div className="header-telemetry">
        <div>
          <span>模拟时间</span>
          <strong>{simulationTime}</strong>
        </div>
        <div>
          <span className={`status-dot status-dot-${runState}`} />
          <strong>{runStateLabels[runState]}</strong>
        </div>
        <div className="backend-label">{backend?.toUpperCase() ?? 'RENDERER'}</div>
      </div>
    </header>
  );
}
