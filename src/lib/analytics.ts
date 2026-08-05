import { CardStats } from './types';

const DAY = 24 * 60 * 60 * 1000;

export interface OverallStats {
  totalCards: number;
  trackedCards: number; // cards with totalReviews > 0
  totalReviews: number;
  totalWrong: number;
  accuracy: number; // 0-100
  totalWeakCards: number;
  reviewsToday: number;
  reviewsThisWeek: number;
  reviewsThisMonth: number;
  averageMissRate: number; // 0-100
  longestWrongStreak: number;
  longestCorrectStreak: number;
}

export function computeOverallStats(all: CardStats[], weakThreshold: number, now = Date.now()): OverallStats {
  const tracked = all.filter((s) => s.totalReviews > 0);
  const totalReviews = tracked.reduce((sum, s) => sum + s.totalReviews, 0);
  const totalWrong = tracked.reduce((sum, s) => sum + s.misses, 0);
  const today = now - DAY;
  const week = now - 7 * DAY;
  const month = now - 30 * DAY;

  const reviewsInWindow = (since: number) =>
    tracked.reduce((sum, s) => sum + s.history.filter((h) => h.date >= since).length, 0);

  return {
    totalCards: all.length,
    trackedCards: tracked.length,
    totalReviews,
    totalWrong,
    accuracy: totalReviews > 0 ? Math.round(((totalReviews - totalWrong) / totalReviews) * 1000) / 10 : 0,
    totalWeakCards: tracked.filter((s) => s.misses >= weakThreshold).length,
    reviewsToday: reviewsInWindow(today),
    reviewsThisWeek: reviewsInWindow(week),
    reviewsThisMonth: reviewsInWindow(month),
    averageMissRate:
      tracked.length > 0
        ? Math.round((tracked.reduce((s, c) => s + (100 - c.accuracy), 0) / tracked.length) * 10) / 10
        : 0,
    longestWrongStreak: tracked.reduce((max, s) => Math.max(max, s.longestMissStreak), 0),
    longestCorrectStreak: tracked.reduce((max, s) => Math.max(max, s.longestCorrectStreak), 0),
  };
}

export function topForgotten(all: CardStats[], limit = 20): CardStats[] {
  return [...all]
    .filter((s) => s.totalReviews > 0)
    .sort((a, b) => b.misses - a.misses || b.weaknessScore - a.weaknessScore)
    .slice(0, limit);
}

export function recentMistakes(all: CardStats[], limit = 20): CardStats[] {
  return [...all]
    .filter((s) => s.lastWrongAt !== undefined)
    .sort((a, b) => (b.lastWrongAt ?? 0) - (a.lastWrongAt ?? 0))
    .slice(0, limit);
}

export function forgottenInWindow(all: CardStats[], sinceMs: number, now = Date.now()): CardStats[] {
  return all.filter((s) => s.lastWrongAt !== undefined && now - s.lastWrongAt <= sinceMs);
}

export interface GroupStat {
  name: string;
  totalReviews: number;
  misses: number;
  accuracy: number;
  averageWeakness: number;
  cardCount: number;
}

/** Groups cards by a key (e.g. notebook, parentText, or a tag) and ranks by weakness. */
export function groupByWeakness(
  all: CardStats[],
  keyOf: (s: CardStats) => string | undefined,
  limit = 10
): GroupStat[] {
  const groups = new Map<string, CardStats[]>();
  for (const s of all) {
    if (s.totalReviews === 0) continue;
    const key = keyOf(s) ?? 'Untitled';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const result: GroupStat[] = [];
  for (const [name, cards] of groups) {
    const totalReviews = cards.reduce((s, c) => s + c.totalReviews, 0);
    const misses = cards.reduce((s, c) => s + c.misses, 0);
    result.push({
      name,
      totalReviews,
      misses,
      accuracy: totalReviews > 0 ? Math.round(((totalReviews - misses) / totalReviews) * 1000) / 10 : 0,
      averageWeakness: Math.round((cards.reduce((s, c) => s + c.weaknessScore, 0) / cards.length) * 10) / 10,
      cardCount: cards.length,
    });
  }
  return result.sort((a, b) => b.averageWeakness - a.averageWeakness).slice(0, limit);
}

export function weakestSubjects(all: CardStats[], limit = 10): GroupStat[] {
  return groupByWeakness(all, (s) => s.notebook, limit);
}

export function weakestChapters(all: CardStats[], limit = 10): GroupStat[] {
  return groupByWeakness(all, (s) => s.parentText, limit);
}

/** "Most improved": cards whose most-recent reviews trend correct after a rough start. */
export function mostImproved(all: CardStats[], limit = 10): CardStats[] {
  return [...all]
    .filter((s) => s.history.length >= 4)
    .map((s) => {
      const half = Math.floor(s.history.length / 2);
      const firstHalf = s.history.slice(0, half);
      const secondHalf = s.history.slice(half);
      const rate = (pts: typeof s.history) => (pts.length ? pts.filter((p) => p.correct).length / pts.length : 0);
      return { stats: s, improvement: rate(secondHalf) - rate(firstHalf) };
    })
    .filter((x) => x.improvement > 0)
    .sort((a, b) => b.improvement - a.improvement)
    .slice(0, limit)
    .map((x) => x.stats);
}

/** Daily accuracy series for the "Accuracy over time" chart. */
export function accuracyOverTime(all: CardStats[], days = 30, now = Date.now()) {
  const buckets = new Map<number, { correct: number; total: number }>();
  const start = now - days * DAY;
  for (const s of all) {
    for (const h of s.history) {
      if (h.date < start) continue;
      const b = buckets.get(h.date) ?? { correct: 0, total: 0 };
      b.total++;
      if (h.correct) b.correct++;
      buckets.set(h.date, b);
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([date, b]) => ({
      date,
      accuracy: b.total > 0 ? Math.round((b.correct / b.total) * 1000) / 10 : 0,
      reviews: b.total,
      mistakes: b.total - b.correct,
    }));
}

/** Review-activity heatmap: reviews per day. */
export function reviewHeatmap(all: CardStats[], days = 182, now = Date.now()) {
  const buckets = new Map<number, number>();
  const start = now - days * DAY;
  for (const s of all) {
    for (const h of s.history) {
      if (h.date < start) continue;
      buckets.set(h.date, (buckets.get(h.date) ?? 0) + 1);
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([date, count]) => ({ date, count }));
}

export function difficultyDistribution(all: CardStats[]) {
  const buckets = [
    { label: '0-9', min: 0, max: 10, count: 0 },
    { label: '10-24', min: 10, max: 25, count: 0 },
    { label: '25-49', min: 25, max: 50, count: 0 },
    { label: '50-99', min: 50, max: 100, count: 0 },
    { label: '100+', min: 100, max: Infinity, count: 0 },
  ];
  for (const s of all) {
    if (s.totalReviews === 0) continue;
    const b = buckets.find((b) => s.weaknessScore >= b.min && s.weaknessScore < b.max);
    if (b) b.count++;
  }
  return buckets;
}
