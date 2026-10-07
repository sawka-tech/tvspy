import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Server-side sort key; sortable when set. */
  sort?: string;
  align?: 'left' | 'right';
  className?: string;
}

/**
 * A plain table with sortable headers. While new data loads, the previous rows stay visible at reduced
 * opacity instead of flashing a skeleton.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  dir,
  onSort,
  onRowClick,
  loading = false,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  sort?: string;
  dir?: 'asc' | 'desc';
  onSort?: (sort: string) => void;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  caption?: string;
}) {
  return (
    <div className="relative overflow-x-auto">
      <table className={`w-full border-collapse text-sm transition-opacity ${loading ? 'opacity-60' : ''}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => {
              const active = c.sort !== undefined && c.sort === sort;
              const align = c.align === 'right' ? 'text-right' : 'text-left';
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={`px-3 py-2 text-xs font-medium whitespace-nowrap text-ink-2 ${align} ${c.className ?? ''}`}
                >
                  {c.sort && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.sort as string)}
                      className={`inline-flex items-center gap-1 hover:text-ink ${c.align === 'right' ? 'flex-row-reverse' : ''}`}
                    >
                      {c.header}
                      {active ? (
                        dir === 'asc' ? (
                          <ArrowUp className="size-3.5" aria-hidden />
                        ) : (
                          <ArrowDown className="size-3.5" aria-hidden />
                        )
                      ) : (
                        <ChevronsUpDown className="size-3.5 opacity-50" aria-hidden />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-line last:border-b-0 ${onRowClick ? 'cursor-pointer hover:bg-surface-2' : ''}`}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-3 py-2 align-middle ${c.align === 'right' ? 'tnum text-right' : ''} ${c.className ?? ''}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
