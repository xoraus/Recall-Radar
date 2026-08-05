import { WeaknessWeights } from './types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * weakness = misses * missWeight
 *          + consecutiveMisses * consecutiveMissWeight
 *          + (100 - accuracy) * accuracyWeight
 *          + min(daysSinceCorrect, daysSinceCorrectCap) * daysSinceCorrectWeight
 *
 * All weights are user-configurable (see PluginSettings). This function is
 * intentionally the *only* place the formula lives so it's trivial to swap
 * out for a different model later (e.g. an Ebbinghaus-style forgetting
 * curve, or plugging in `Card.repetitionHistory[].responseTime`).
 */
export function computeWeaknessScore(
  args: {
    misses: number;
    consecutiveMisses: number;
    accuracy: number; // 0-100
    lastCorrectAt?: number;
    totalReviews: number;
  },
  weights: WeaknessWeights,
  now: number = Date.now()
): number {
  const { misses, consecutiveMisses, accuracy, lastCorrectAt, totalReviews } = args;

  // Cards with zero reviews aren't "weak" yet, they're simply unseen.
  if (totalReviews === 0) return 0;

  const daysSinceCorrect = lastCorrectAt
    ? Math.min((now - lastCorrectAt) / MS_PER_DAY, weights.daysSinceCorrectCap)
    : weights.daysSinceCorrectCap;

  const score =
    misses * weights.missWeight +
    consecutiveMisses * weights.consecutiveMissWeight +
    (100 - accuracy) * weights.accuracyWeight +
    daysSinceCorrect * weights.daysSinceCorrectWeight;

  return Math.round(score * 100) / 100;
}
