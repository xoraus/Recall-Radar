import { CardStats } from './types';

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportStatsAsJSON(stats: CardStats[]): void {
  download('wrong-card-tracker-stats.json', JSON.stringify(stats, null, 2), 'application/json');
}

const CSV_COLUMNS: (keyof CardStats)[] = [
  'cardId',
  'remId',
  'promptText',
  'answerText',
  'totalReviews',
  'correct',
  'misses',
  'accuracy',
  'weaknessScore',
  'consecutiveMisses',
  'consecutiveCorrect',
  'lastReviewedAt',
  'lastWrongAt',
  'lastCorrectAt',
  'notebook',
  'parentText',
];

function csvEscape(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function exportStatsAsCSV(stats: CardStats[]): void {
  const header = CSV_COLUMNS.join(',');
  const rows = stats.map((s) => CSV_COLUMNS.map((c) => csvEscape((s as any)[c])).join(','));
  download('wrong-card-tracker-stats.csv', [header, ...rows].join('\n'), 'text/csv');
}

export function exportWeakCardsAsCSV(stats: CardStats[], minMisses: number): void {
  exportStatsAsCSV(stats.filter((s) => s.misses >= minMisses));
}
