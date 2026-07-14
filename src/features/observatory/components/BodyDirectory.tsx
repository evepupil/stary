import type { BodyState } from '../../../physics/protocol/schemas';
import {
  CELESTIAL_GROUPS,
  celestialColorToCss,
  getCelestialCatalogEntry,
  type CelestialGroupId,
} from '../catalog';

interface BodyDirectoryProps {
  readonly bodies: readonly BodyState[];
  readonly focusedBodyId: string | null;
  readonly onSelectBody: (bodyId: string) => void;
  readonly selectedBodyId: string | null;
}

type DirectoryGroupId = CelestialGroupId | 'other';

const directoryGroups: readonly {
  readonly id: DirectoryGroupId;
  readonly label: string;
  readonly order: number;
}[] = [...CELESTIAL_GROUPS, { id: 'other', label: '其他', order: Number.MAX_SAFE_INTEGER }];

export function BodyDirectory({
  bodies,
  focusedBodyId,
  onSelectBody,
  selectedBodyId,
}: BodyDirectoryProps) {
  const sortedBodies = bodies.toSorted((left, right) => {
    const leftOrder = getCelestialCatalogEntry(left.id)?.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = getCelestialCatalogEntry(right.id)?.order ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });

  return (
    <div className="panel-content body-directory-content">
      <div className="panel-heading">
        <p>天体目录</p>
        <span>{String(bodies.length).padStart(2, '0')}</span>
      </div>
      <div className="body-groups">
        {directoryGroups.map((group) => {
          const groupBodies = sortedBodies.filter(
            (body) => (getCelestialCatalogEntry(body.id)?.group ?? 'other') === group.id,
          );
          if (groupBodies.length === 0) {
            return null;
          }

          return (
            <section className="body-directory-group" key={group.id}>
              <h3>
                <span>{group.label}</span>
                <small>{groupBodies.length}</small>
              </h3>
              <div className="body-list" role="list">
                {groupBodies.map((body) => {
                  const metadata = getCelestialCatalogEntry(body.id);
                  const name = metadata?.name ?? body.id;
                  return (
                    <div key={body.id} role="listitem">
                      <button
                        aria-current={focusedBodyId === body.id ? 'true' : undefined}
                        aria-describedby={`body-list-state-${body.id}`}
                        aria-label={`聚焦${name}`}
                        className="body-list-item"
                        data-selected={selectedBodyId === body.id ? 'true' : undefined}
                        onClick={() => {
                          onSelectBody(body.id);
                        }}
                        type="button"
                      >
                        <span
                          className="body-swatch"
                          style={{
                            backgroundColor: celestialColorToCss(metadata?.color ?? 0xaeb8bd),
                          }}
                        />
                        <span>
                          <strong>{name}</strong>
                          <small>{metadata?.type ?? '未知天体'}</small>
                        </span>
                        <span className="body-list-state" id={`body-list-state-${body.id}`}>
                          {focusedBodyId === body.id
                            ? '聚焦中'
                            : selectedBodyId === body.id
                              ? '已查看'
                              : '查看'}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
