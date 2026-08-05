import { CardStats, PracticeFilter, PluginSettings } from './types';

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Applies a PracticeFilter against the cached stats map and returns matching cards. */
export function selectCardsForPractice(
  allStats: Record<string, CardStats>,
  filter: PracticeFilter,
  settings: PluginSettings,
  now: number = Date.now()
): CardStats[] {
  const values = Object.values(allStats);
  const today = startOfDay(now);

  let matched: CardStats[];
  switch (filter.kind) {
    case 'missed-today':
      matched = values.filter((s) => s.lastWrongAt !== undefined && startOfDay(s.lastWrongAt) === today);
      break;
    case 'missed-yesterday': {
      const yesterday = today - DAY;
      matched = values.filter((s) => s.lastWrongAt !== undefined && startOfDay(s.lastWrongAt) === yesterday);
      break;
    }
    case 'missed-this-week':
      matched = values.filter((s) => s.lastWrongAt !== undefined && now - s.lastWrongAt <= 7 * DAY);
      break;
    case 'missed-this-month':
      matched = values.filter((s) => s.lastWrongAt !== undefined && now - s.lastWrongAt <= 30 * DAY);
      break;
    case 'top-n-weakest':
      matched = values.filter((s) => s.misses >= settings.minMissCountForWeak);
      break;
    case 'accuracy-below':
      matched = values.filter((s) => s.totalReviews > 0 && s.accuracy < (filter.accuracyBelow ?? 80));
      break;
    case 'missed-more-than':
      matched = values.filter((s) => s.misses > (filter.missedMoreThan ?? 5));
      break;
    case 'tag':
      matched = values.filter((s) => (filter.tag ? s.tags.includes(filter.tag) : false));
      break;
    case 'search': {
      const q = (filter.search ?? '').toLowerCase().trim();
      matched = q
        ? values.filter(
            (s) => s.promptText.toLowerCase().includes(q) || s.answerText.toLowerCase().includes(q)
          )
        : [];
      break;
    }
    case 'all-weak':
    default:
      matched = values.filter(
        (s) => s.misses >= settings.minMissCountForWeak || s.accuracy < settings.minAccuracyThresholdPct
      );
      break;
  }

  matched.sort((a, b) => b.weaknessScore - a.weaknessScore);
  if (filter.kind === 'top-n-weakest') {
    matched = matched.slice(0, filter.n ?? 20);
  }
  return matched;
}

/**
 * "Practice Until Mastered" exit condition: a card leaves the session once
 * it has `masteryConsecutiveCorrect` correct answers in a row *within this
 * session*, OR its live weakness score (recomputed after each answer) drops
 * below `masteryWeaknessThreshold`.
 */
export function isMastered(
  sessionConsecutiveCorrect: number,
  liveWeaknessScore: number,
  settings: PluginSettings
): boolean {
  return (
    sessionConsecutiveCorrect >= settings.masteryConsecutiveCorrect ||
    liveWeaknessScore <= settings.masteryWeaknessThreshold
  );
}

export const BUILT_IN_FILTERS: PracticeFilter[] = [
  { label: 'Missed Today', kind: 'missed-today' },
  { label: 'Missed Yesterday', kind: 'missed-yesterday' },
  { label: 'Missed This Week', kind: 'missed-this-week' },
  { label: 'Missed This Month', kind: 'missed-this-month' },
  { label: 'Top 20 Weakest', kind: 'top-n-weakest', n: 20 },
  { label: 'Top 50 Weakest', kind: 'top-n-weakest', n: 50 },
  { label: 'Accuracy Below 80%', kind: 'accuracy-below', accuracyBelow: 80 },
  { label: 'Accuracy Below 60%', kind: 'accuracy-below', accuracyBelow: 60 },
  { label: 'Missed More Than 5 Times', kind: 'missed-more-than', missedMoreThan: 5 },
  { label: 'All Weak Cards', kind: 'all-weak' },
];
