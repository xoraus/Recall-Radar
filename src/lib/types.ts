/**
 * Core data model for Recall Radar.
 *
 * IMPORTANT ARCHITECTURAL NOTE:
 * RemNote already stores a per-card `repetitionHistory: RepetitionStatus[]`
 * (see `plugin.card.getAll()` / the `Card` object in `@remnote/plugin-sdk`).
 * Each entry has `{ date, score, responseTime?, isCram? }` where `score` is a
 * `QueueInteractionScore` (AGAIN / HARD / GOOD / EASY / ...).
 *
 * Rather than duplicating that review log in plugin storage (which the brief
 * warns against — "avoid excessive storage growth" / "avoid writing
 * excessively"), Recall Radar treats `repetitionHistory` as the single
 * source of truth and *derives* `CardStats` from it on demand. We only cache
 * the derived, compact result (this file's `CardStats`), not the raw log.
 * This is both more storage-efficient and can never drift out of sync with
 * RemNote's own scheduler data.
 */

/** One row of RemNote's native repetition history, re-exported for clarity. */
export interface RawRepetition {
  date: number | Date;
  score: number; // QueueInteractionScore
  responseTime?: number;
  isCram?: boolean;
}

/** A single day's outcome, used for the compact history sparkline. */
export interface HistoryPoint {
  date: number; // ms epoch, truncated to day
  correct: boolean;
}

/** Derived, cached statistics for a single flashcard. */
export interface CardStats {
  cardId: string;
  remId: string;
  /** Plain-text rendering of the card's front, truncated for display. */
  promptText: string;
  /** Plain-text rendering of the card's back, truncated for display. */
  answerText: string;
  /** Present only for text-based RemNote multiple-choice cards. */
  multipleChoice?: {
    options: string[];
    /** Zero-based indices in `options` that are correct. */
    correctOptionIndexes: number[];
  };
  /** Source Rem timestamp used to invalidate cached card content. */
  contentUpdatedAt?: number;

  totalReviews: number;
  correct: number;
  misses: number;
  consecutiveMisses: number;
  consecutiveCorrect: number;
  longestMissStreak: number;
  longestCorrectStreak: number;

  /** 0-100 */
  accuracy: number;
  /** Higher = weaker. See lib/score.ts for the formula. */
  weaknessScore: number;

  averageResponseTimeMs?: number;
  lastReviewedAt?: number;
  lastCorrectAt?: number;
  lastWrongAt?: number;
  createdAt: number;

  /** Deck / top-level ancestor document name, best-effort. */
  notebook?: string;
  /** Immediate parent Rem's plain text, best-effort. */
  parentText?: string;
  /** Names of Rem tags applied to the card's Rem. */
  tags: string[];

  /** Trimmed to the most recent N entries (see MAX_HISTORY_POINTS). */
  history: HistoryPoint[];
}

export const MAX_HISTORY_POINTS = 60;

/** Weights for the configurable weakness-score formula. */
export interface WeaknessWeights {
  missWeight: number;
  consecutiveMissWeight: number;
  accuracyWeight: number;
  daysSinceCorrectWeight: number;
  daysSinceCorrectCap: number;
}

export const DEFAULT_WEIGHTS: WeaknessWeights = {
  missWeight: 5,
  consecutiveMissWeight: 10,
  accuracyWeight: 1,
  daysSinceCorrectWeight: 1,
  daysSinceCorrectCap: 30,
};

export interface PluginSettings {
  weights: WeaknessWeights;
  minMissCountForWeak: number;
  minAccuracyThresholdPct: number;
  maxHistoryLength: number;
  masteryConsecutiveCorrect: number;
  masteryWeaknessThreshold: number;
  feedPracticeResultsToScheduler: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  weights: DEFAULT_WEIGHTS,
  minMissCountForWeak: 1,
  minAccuracyThresholdPct: 80,
  maxHistoryLength: MAX_HISTORY_POINTS,
  masteryConsecutiveCorrect: 2,
  masteryWeaknessThreshold: 5,
  feedPracticeResultsToScheduler: false,
};

/** A filter that produces a list of card IDs to practice. */
export interface PracticeFilter {
  label: string;
  kind:
    | 'missed-today'
    | 'missed-yesterday'
    | 'missed-this-week'
    | 'missed-this-month'
    | 'top-n-weakest'
    | 'accuracy-below'
    | 'missed-more-than'
    | 'tag'
    | 'search'
    | 'all-weak';
  n?: number;
  accuracyBelow?: number;
  missedMoreThan?: number;
  tag?: string;
  search?: string;
}

export type SortKey = 'weaknessScore' | 'misses' | 'accuracy' | 'lastWrongAt' | 'totalReviews';
