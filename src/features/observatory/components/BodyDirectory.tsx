import type { BodyState } from '../../../physics/protocol/schemas';

interface BodyDirectoryProps {
  readonly bodies: readonly BodyState[];
  readonly onSelectBody: (bodyId: string) => void;
  readonly selectedBodyId: string | null;
}

const bodyMetadata: Record<string, { readonly name: string; readonly type: string }> = {
  sun: { name: '太阳', type: 'G2V 恒星' },
  earth: { name: '地球', type: '岩质行星' },
};

export function BodyDirectory({ bodies, onSelectBody, selectedBodyId }: BodyDirectoryProps) {
  return (
    <div className="panel-content">
      <div className="panel-heading">
        <p>天体目录</p>
        <span>{String(bodies.length).padStart(2, '0')}</span>
      </div>
      <div className="body-list" role="list">
        {bodies.map((body) => {
          const metadata = bodyMetadata[body.id] ?? { name: body.id, type: '未知天体' };
          return (
            <button
              aria-current={selectedBodyId === body.id ? 'true' : undefined}
              className="body-list-item"
              key={body.id}
              onClick={() => {
                onSelectBody(body.id);
              }}
              type="button"
            >
              <span className={`body-swatch body-swatch-${body.id}`} />
              <span>
                <strong>{metadata.name}</strong>
                <small>{metadata.type}</small>
              </span>
              <span className="body-list-state">追踪</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
