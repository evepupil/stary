import { Eye, FlaskConical, Plus } from 'lucide-react';

export type ObservatoryMode = 'observe' | 'create';

interface CreationModeSwitcherProps {
  readonly disabled?: boolean;
  readonly mode: ObservatoryMode;
  readonly onModeChange: (mode: ObservatoryMode) => void;
}

export function CreationModeSwitcher({
  disabled = false,
  mode,
  onModeChange,
}: CreationModeSwitcherProps) {
  return (
    <nav aria-label="模拟模式" className="mode-switcher">
      <button
        aria-pressed={mode === 'observe'}
        disabled={disabled}
        onClick={() => {
          onModeChange('observe');
        }}
        type="button"
      >
        <Eye aria-hidden="true" size={15} />
        <span>观察</span>
      </button>
      <button
        aria-pressed={mode === 'create'}
        disabled={disabled}
        onClick={() => {
          onModeChange('create');
        }}
        type="button"
      >
        <Plus aria-hidden="true" size={15} />
        <span>创造</span>
      </button>
      <button aria-label="实验模式将在后续里程碑开放" disabled title="后续开放" type="button">
        <FlaskConical aria-hidden="true" size={15} />
        <span>实验</span>
      </button>
    </nav>
  );
}
