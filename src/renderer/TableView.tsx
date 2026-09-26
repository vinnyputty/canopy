import React, { useRef } from 'react';
import type { RootView, TableColumn } from '../shared/types';
import {
  clampWidth,
  COLUMN_LABELS,
  columnBounds,
  DEFAULT_VIEW,
} from './table-view';

type ViewProps = {
  view: RootView;
  update: (patch: Partial<RootView>) => void;
};
export function ViewSettings({
  view,
  update,
  useDefault,
  reset,
  provider = 'jira',
}: ViewProps & {
  useDefault: () => void;
  reset: () => void;
  provider?: 'jira' | 'github' | 'demo';
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const move = (column: TableColumn, offset: number) => {
    const columns = [...view.columns];
    const index = columns.indexOf(column);
    if (index + offset < 1 || index + offset >= columns.length) return;
    columns.splice(index, 1);
    columns.splice(index + offset, 0, column);
    update({ columns });
  };
  return (
    <details
      className="view-settings"
      ref={details}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          details.current!.open = false;
          details.current!.querySelector('summary')?.focus();
        }
      }}
    >
      <summary className="tool-button">View</summary>
      <div className="view-panel" role="group" aria-label="Table view">
        <label>
          Sort by
          <select
            aria-label="Sort by"
            value={view.sort.column}
            onChange={(event) =>
              update({
                sort: {
                  column: event.target.value as RootView['sort']['column'],
                  direction: 'asc',
                },
              })
            }
          >
            <option value="rank">
              {provider === 'github' ? 'GitHub order' : 'Jira rank'}
            </option>
            {Object.entries(COLUMN_LABELS)
              .filter(([id]) => provider !== 'github' || id !== 'priority')
              .map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                  {id === 'issue' ? ' summary' : ''}
                </option>
              ))}
          </select>
        </label>
        {view.sort.column !== 'rank' && (
          <label>
            Direction
            <select
              aria-label="Sort direction"
              value={view.sort.direction}
              onChange={(event) =>
                update({
                  sort: {
                    ...view.sort,
                    direction: event.target.value as 'asc' | 'desc',
                  },
                })
              }
            >
              <option value="asc">
                {view.sort.column === 'priority'
                  ? 'Highest first'
                  : 'Ascending'}
              </option>
              <option value="desc">
                {view.sort.column === 'priority'
                  ? 'Lowest first'
                  : 'Descending'}
              </option>
            </select>
          </label>
        )}
        <label>
          Text size
          <select
            aria-label="Text size"
            value={view.textSize}
            onChange={(event) =>
              update({ textSize: event.target.value as RootView['textSize'] })
            }
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label>
          Row spacing
          <select
            aria-label="Row spacing"
            value={view.spacing}
            onChange={(event) =>
              update({ spacing: event.target.value as RootView['spacing'] })
            }
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </label>
        <fieldset>
          <legend>Columns</legend>
          {[
            ...view.columns,
            ...DEFAULT_VIEW.columns.filter(
              (column) => !view.columns.includes(column),
            ),
          ]
            .filter((column) => provider !== 'github' || column !== 'priority')
            .map((column) => (
              <div className="column-setting" key={column}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Show ${COLUMN_LABELS[column]} column`}
                    checked={view.columns.includes(column)}
                    disabled={column === 'issue'}
                    onChange={(event) =>
                      update({
                        columns: event.target.checked
                          ? [...view.columns, column]
                          : view.columns.filter((id) => id !== column),
                      })
                    }
                  />
                  {COLUMN_LABELS[column]}
                </label>
                {column !== 'issue' && view.columns.includes(column) && (
                  <>
                    <button
                      aria-label={`Move ${COLUMN_LABELS[column]} column left`}
                      disabled={view.columns.indexOf(column) === 1}
                      onClick={() => move(column, -1)}
                    >
                      ←
                    </button>
                    <button
                      aria-label={`Move ${COLUMN_LABELS[column]} column right`}
                      disabled={
                        view.columns.indexOf(column) === view.columns.length - 1
                      }
                      onClick={() => move(column, 1)}
                    >
                      →
                    </button>
                  </>
                )}
              </div>
            ))}
        </fieldset>
        <button className="view-action" onClick={useDefault}>
          Use as connection default
        </button>
        <button className="view-action" onClick={reset}>
          Reset this root to default
        </button>
        <p>
          Defaults include filters and apply to this{' '}
          {provider === 'github' ? 'GitHub' : 'Jira'} connection. Customized
          roots keep their own view.
        </p>
      </div>
    </details>
  );
}

export function TableHeader({ view, update }: ViewProps) {
  const dragged = useRef<TableColumn | null>(null);
  const resize = useRef<{
    column: TableColumn;
    x: number;
    width: number;
  } | null>(null);
  return (
    <div className="column-head">
      {view.columns.map((column) => (
        <div
          key={column}
          className="column-heading"
          data-column={column}
          onDragOver={(event) => {
            if (column !== 'issue' && dragged.current) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const source = dragged.current;
            if (!source || column === 'issue' || source === column) return;
            const columns = [...view.columns];
            columns.splice(columns.indexOf(source), 1);
            columns.splice(view.columns.indexOf(column), 0, source);
            update({ columns });
            dragged.current = null;
          }}
        >
          <button
            className="column-sort"
            draggable={column !== 'issue'}
            onDragStart={(event) => {
              dragged.current = column;
              event.dataTransfer.setData('text/plain', column);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              dragged.current = null;
            }}
            aria-label={`Sort by ${COLUMN_LABELS[column]}${column === 'issue' ? ' summary' : ''}`}
            title={
              column === 'issue'
                ? 'Sort by issue summary'
                : `Sort by ${COLUMN_LABELS[column]}; drag to move column`
            }
            onClick={() =>
              update({
                sort: {
                  column,
                  direction:
                    view.sort.column === column && view.sort.direction === 'asc'
                      ? 'desc'
                      : 'asc',
                },
              })
            }
          >
            {COLUMN_LABELS[column]}
            {view.sort.column === column && (
              <span
                aria-label={
                  view.sort.direction === 'asc' ? 'Ascending' : 'Descending'
                }
              >
                {view.sort.direction === 'asc' ? ' ↑' : ' ↓'}
              </span>
            )}
          </button>
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={`Resize ${COLUMN_LABELS[column]} column`}
            aria-valuemin={columnBounds(column)[0]}
            aria-valuemax={columnBounds(column)[1]}
            aria-valuenow={view.widths[column]}
            className="column-resizer"
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              resize.current = {
                column,
                x: event.clientX,
                width:
                  event.currentTarget.parentElement!.getBoundingClientRect()
                    .width,
              };
            }}
            onPointerMove={(event) => {
              if (resize.current?.column !== column) return;
              update({
                widths: {
                  ...view.widths,
                  [column]: clampWidth(
                    column,
                    resize.current.width + event.clientX - resize.current.x,
                  ),
                },
              });
            }}
            onPointerUp={(event) => {
              resize.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => {
              resize.current = null;
            }}
            onDoubleClick={() =>
              update({
                widths: {
                  ...view.widths,
                  [column]: DEFAULT_VIEW.widths[column],
                },
              })
            }
            onKeyDown={(event) => {
              const delta =
                event.key === 'ArrowLeft'
                  ? -10
                  : event.key === 'ArrowRight'
                    ? 10
                    : 0;
              if (!delta) return;
              event.preventDefault();
              update({
                widths: {
                  ...view.widths,
                  [column]: clampWidth(column, view.widths[column] + delta),
                },
              });
            }}
          />
        </div>
      ))}
      <span className="row-actions-head" />
    </div>
  );
}
