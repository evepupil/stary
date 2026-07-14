import { Pause, Play, StepForward } from 'lucide-react';

interface TimeControlsProps {
  readonly commandPending: boolean;
  readonly onPause: () => void;
  readonly onSetTimeScale: (value: number) => void;
  readonly onStart: () => void;
  readonly onStep: (stepSeconds?: number) => void;
  readonly runState: 'idle' | 'initialized' | 'paused' | 'running';
  readonly timeScale: number;
}

const timeScaleOptions = [
  { label: '实时', value: 1 },
  { label: '1 小时/秒', value: 3_600 },
  { label: '1 天/秒', value: 86_400 },
  { label: '1 周/秒', value: 604_800 },
] as const;

export function TimeControls({
  commandPending,
  onPause,
  onSetTimeScale,
  onStart,
  onStep,
  runState,
  timeScale,
}: TimeControlsProps) {
  const running = runState === 'running';
  const disabled = commandPending || runState === 'idle';

  return (
    <section aria-label="时间控制" className="time-controls">
      <button
        aria-label={running ? '暂停模拟' : '开始模拟'}
        className="primary-time-control"
        disabled={disabled}
        onClick={() => {
          if (running) {
            onPause();
          } else {
            onStart();
          }
        }}
        title={running ? '暂停模拟' : '开始模拟'}
        type="button"
      >
        {running ? <Pause aria-hidden="true" size={19} /> : <Play aria-hidden="true" size={19} />}
      </button>
      <button
        aria-label="单步推进一小时"
        disabled={disabled || running}
        onClick={() => {
          onStep(3_600);
        }}
        title="单步推进一小时"
        type="button"
      >
        <StepForward aria-hidden="true" size={18} />
      </button>
      <span className="control-divider" />
      <label>
        <span>时间倍率</span>
        <select
          aria-label="时间倍率"
          disabled={disabled}
          onChange={(event) => {
            onSetTimeScale(Number(event.target.value));
          }}
          value={String(timeScale)}
        >
          {timeScaleOptions.map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
          {timeScaleOptions.every((option) => option.value !== timeScale) ? (
            <option
              value={String(timeScale)}
            >{`${Math.round(timeScale).toLocaleString()}×`}</option>
          ) : null}
        </select>
      </label>
      <output aria-live="polite">{`${Math.round(timeScale).toLocaleString()}×`}</output>
    </section>
  );
}
