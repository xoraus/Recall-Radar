import { Card, QueueInteractionScore, Rem, RNPlugin } from '@remnote/plugin-sdk';
import { CardStats, HistoryPoint, MAX_HISTORY_POINTS, RawRepetition, WeaknessWeights } from './types';
import { richTextToPlain } from './richtext';
import { computeWeaknessScore } from './score';

/**
 * Repetition outcomes that count as a genuine recall attempt. TOO_EARLY
 * reviews (accidental/very-early clicks) are excluded from accuracy math
 * because they don't reflect memory strength. RESET is excluded because it
 * represents a manual scheduler reset, not a recall. This mirrors how a
 * human reading the review log would interpret these entries; there is no
 * documented "correct/incorrect" flag on RepetitionStatus itself, so this
 * mapping is our explicit, documented assumption.
 */
function isScoredAttempt(score: number): boolean {
  return score !== QueueInteractionScore.TOO_EARLY && score !== QueueInteractionScore.RESET;
}

function isCorrectAttempt(score: number): boolean {
  return score !== QueueInteractionScore.AGAIN;
}

function toMillis(date: number | Date): number {
  return typeof date === 'number' ? date : date.getTime();
}

function dayBucket(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Walks up the Rem tree to find the top-level ancestor (best-effort "notebook"). */
async function getNotebookName(plugin: RNPlugin, rem: Rem): Promise<string | undefined> {
  let current: Rem | undefined = rem;
  let guard = 0;
  while (current && guard < 50) {
    const parent: Rem | undefined = await current.getParentRem();
    if (!parent) break;
    current = parent;
    guard++;
  }
  if (!current || current._id === rem._id) return undefined;
  return richTextToPlain(plugin, current.text, 80);
}

export interface BuildStatsOptions {
  weights: WeaknessWeights;
  maxHistoryLength?: number;
  now?: number;
}

/**
 * Builds a full CardStats record for one Card + its owning Rem.
 * Pass a previously cached CardStats via `previous` to reuse expensive
 * lookups (notebook/parent/tags) when only the review history changed.
 */
export async function buildCardStats(
  plugin: RNPlugin,
  card: Card,
  rem: Rem,
  opts: BuildStatsOptions,
  previous?: CardStats
): Promise<CardStats> {
  const history = (card.repetitionHistory ?? []) as RawRepetition[];
  const scored = history.filter((h) => isScoredAttempt(h.score));

  let correct = 0;
  let misses = 0;
  let consecutiveMisses = 0;
  let consecutiveCorrect = 0;
  let longestMissStreak = 0;
  let longestCorrectStreak = 0;
  let lastCorrectAt: number | undefined;
  let lastWrongAt: number | undefined;
  let responseTimeSum = 0;
  let responseTimeCount = 0;
  const historyPoints: HistoryPoint[] = [];

  for (const rep of scored) {
    const ms = toMillis(rep.date);
    const ok = isCorrectAttempt(rep.score);
    if (ok) {
      correct++;
      consecutiveCorrect++;
      consecutiveMisses = 0;
      longestCorrectStreak = Math.max(longestCorrectStreak, consecutiveCorrect);
      lastCorrectAt = ms;
    } else {
      misses++;
      consecutiveMisses++;
      consecutiveCorrect = 0;
      longestMissStreak = Math.max(longestMissStreak, consecutiveMisses);
      lastWrongAt = ms;
    }
    if (typeof rep.responseTime === 'number') {
      responseTimeSum += rep.responseTime;
      responseTimeCount++;
    }
    historyPoints.push({ date: dayBucket(ms), correct: ok });
  }

  const totalReviews = scored.length;
  const accuracy = totalReviews > 0 ? Math.round((correct / totalReviews) * 1000) / 10 : 0;
  const maxHistory = opts.maxHistoryLength ?? MAX_HISTORY_POINTS;
  const trimmedHistory = historyPoints.slice(-maxHistory);

  const weaknessScore = computeWeaknessScore(
    { misses, consecutiveMisses, accuracy, lastCorrectAt, totalReviews },
    opts.weights,
    opts.now
  );

  // Reuse expensive Rem-graph lookups if we already have them and the Rem
  // hasn't changed since the last computation, to keep bulk rebuilds fast.
  let promptText = previous?.promptText;
  let answerText = previous?.answerText;
  let notebook = previous?.notebook;
  let parentText = previous?.parentText;
  let tags = previous?.tags;

  const remChanged = !previous || previous.remId !== rem._id;
  if (remChanged || promptText === undefined) {
    promptText = await richTextToPlain(plugin, rem.text, 140);
    answerText = await richTextToPlain(plugin, rem.backText, 140);
    const [parentRem, notebookName, tagRems] = await Promise.all([
      rem.getParentRem(),
      getNotebookName(plugin, rem),
      rem.getTagRems(),
    ]);
    parentText = parentRem ? await richTextToPlain(plugin, parentRem.text, 80) : undefined;
    notebook = notebookName;
    tags = await Promise.all(tagRems.map((t) => richTextToPlain(plugin, t.text, 40)));
  }

  return {
    cardId: card._id,
    remId: rem._id,
    promptText: promptText ?? '',
    answerText: answerText ?? '',
    totalReviews,
    correct,
    misses,
    consecutiveMisses,
    consecutiveCorrect,
    longestMissStreak,
    longestCorrectStreak,
    accuracy,
    weaknessScore,
    averageResponseTimeMs: responseTimeCount > 0 ? Math.round(responseTimeSum / responseTimeCount) : undefined,
    lastReviewedAt: scored.length ? toMillis(scored[scored.length - 1].date) : undefined,
    lastCorrectAt,
    lastWrongAt,
    createdAt: card.createdAt,
    notebook,
    parentText,
    tags: tags ?? [],
    history: trimmedHistory,
  };
}
