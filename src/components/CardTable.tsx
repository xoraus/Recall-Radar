import React, { useMemo, useState } from 'react';
import { CardStats } from '../lib/types';

const PAGE_SIZE = 50;

export function CardTable({
  rows,
  onOpenCard,
  columns = ['prompt', 'misses', 'accuracy', 'weakness', 'lastWrong'],
}: {
  rows: CardStats[];
  onOpenCard?: (stats: CardStats) => void;
  columns?: Array<'prompt' | 'misses' | 'accuracy' | 'weakness' | 'lastWrong' | 'reviews'>;
}) {
  const [page, setPage] = useState(0);
  // Lazy pagination keeps the DOM small even with tens of thousands of
  // matching cards, per the "lazy-load large datasets" requirement.
  const pageRows = useMemo(() => rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [rows, page]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  return (
    <div className="wct-table-wrap">
      <table className="wct-table">
        <thead>
          <tr>
            {columns.includes('prompt') && <th>Card</th>}
            {columns.includes('misses') && <th>Misses</th>}
            {columns.includes('reviews') && <th>Reviews</th>}
            {columns.includes('accuracy') && <th>Accuracy</th>}
            {columns.includes('weakness') && <th>Weakness</th>}
            {columns.includes('lastWrong') && <th>Last Wrong</th>}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((r) => (
            <tr key={r.cardId} onClick={() => onOpenCard?.(r)} className="wct-row-clickable">
              {columns.includes('prompt') && <td className="wct-prompt-cell">{r.promptText || '(empty)'}</td>}
              {columns.includes('misses') && <td>{r.misses}</td>}
              {columns.includes('reviews') && <td>{r.totalReviews}</td>}
              {columns.includes('accuracy') && <td>{r.accuracy}%</td>}
              {columns.includes('weakness') && <td>{r.weaknessScore}</td>}
              {columns.includes('lastWrong') && (
                <td>{r.lastWrongAt ? new Date(r.lastWrongAt).toLocaleDateString() : '\u2014'}</td>
              )}
            </tr>
          ))}
          {pageRows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="wct-empty-cell">
                No cards match this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="wct-pagination">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <span>
            Page {page + 1} / {totalPages} &middot; {rows.length} cards
          </span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
