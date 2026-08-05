import { Card, QueueInteractionScore, Rem, RNPlugin } from '@remnote/plugin-sdk';
import { CardStats, HistoryPoint, MAX_HISTORY_POINTS, RawRepetition, WeaknessWeights } from './types';
import { richTextToPlain } from './richtext';
import { computeWeaknessScore } from './score';

/**
 * RemNote's public SDK does not expose an MCQ object.  Native MCQs are stored
 * as a card with option Rems beneath it; by default option A is correct.  The
 * answer text may contain an explicit letter/number (or option text), so use
 * that when it is available and otherwise retain RemNote's A-is-correct rule.
 */
function findCorrectOptionIndexes(answer: string, options: string[]): number[] {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return [0];

  const byText = options
    .map((option, index) => ({ option: option.trim().toLowerCase(), index }))
    .filter(({ option }) => option === normalized)
    .map(({ index }) => index);
  if (byText.length) return byText;

  const matches = Array.from(normalized.matchAll(/(?:^|[\s,;/])([a-z]|\d+)(?:[).:]|$)/g));
  const indexes = matches
    .map((match) => {
      const token = match[1];
      const number = /^\d+$/.test(token) ? Number(token) - 1 : token.charCodeAt(0) - 97;
      return number >= 0 && number < options.length ? number : -1;
    })
    .filter((index) => index >= 0);
  return indexes.length ? Array.from(new Set(indexes)) : [0];
}

const MULTIPLE_CHOICE_POWERUP = 'mc';

async function findMultipleChoiceContainer(
  plugin: RNPlugin,
  rem: Rem,
  remScope?: Rem[]
): Promise<Rem | undefined> {
  const remById = new Map((remScope ?? []).map((candidate) => [candidate._id, candidate]));
  let candidate: Rem | undefined = rem;
  for (let depth = 0; candidate && depth < 5; depth++) {
    if (typeof candidate.hasPowerup === 'function') {
      if (await candidate.hasPowerup('mc')) return candidate;
      if (await candidate.hasPowerup('multiplechoice-card')) return candidate;
      if (await candidate.hasPowerup('q')) {
        // It's a flashcard, check if it has multiple choice tag
        let tagRems: Rem[] = [];
        if (typeof candidate.getTagRems === 'function') {
          tagRems = await candidate.getTagRems();
        } else {
          const fullRem = await plugin.rem.findOne(candidate._id);
          if (fullRem) tagRems = await fullRem.getTagRems();
        }
        for (const tag of tagRems) {
          const text = await richTextToPlain(plugin, tag.text, 50);
          if (text && text.toLowerCase().replace(/[\s-]/g, '').includes('multiplechoice')) {
            return candidate;
          }
        }
      }
    }
    
    // Also check tags generally
    let tagRems: Rem[] = [];
    if (typeof candidate.getTagRems === 'function') {
      tagRems = await candidate.getTagRems();
    } else {
      const fullRem = await plugin.rem.findOne(candidate._id);
      if (fullRem) tagRems = await fullRem.getTagRems();
    }
    for (const tag of tagRems) {
      const text = await richTextToPlain(plugin, tag.text, 50);
      if (text && text.toLowerCase().replace(/[\s-]/g, '').includes('multiplechoice')) {
        return candidate;
      }
    }

    candidate = candidate.parent
      ? remById.get(candidate.parent) ?? await plugin.rem.findOne(candidate.parent)
      : typeof candidate.getParentRem === 'function' ? await candidate.getParentRem() : undefined;
  }
  return undefined;
}

/**
 * Native MCQ choices are descendants of the container. In standard RemNote,
 * they are typically the direct children of the multiple choice question Rem.
 */
async function getMultipleChoiceOptions(plugin: RNPlugin, container: Rem, remScope?: Rem[]): Promise<string[]> {
  let descendants: Rem[];
  if (remScope?.length) {
    const childrenByParent = new Map<string, Rem[]>();
    for (const rem of remScope) {
      if (!rem.parent) continue;
      const children = childrenByParent.get(rem.parent) ?? [];
      children.push(rem);
      childrenByParent.set(rem.parent, children);
    }
    descendants = childrenByParent.get(container._id) ?? [];
  } else {
    descendants = typeof container.getChildrenRem === 'function' ? await container.getChildrenRem() : [];
  }
  return (await Promise.all(descendants.map((child) => richTextToPlain(plugin, child.text, 500)))).filter(Boolean);
}

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
    let parent: Rem | undefined;
    if (typeof current.getParentRem === 'function') {
      parent = await current.getParentRem();
    } else if ((current as any).parent) {
      parent = await plugin.rem.findOne((current as any).parent);
    }
    
    if (!parent) break;
    current = parent;
    guard++;
  }
  if (!current || current._id === rem._id) return undefined;
  return await richTextToPlain(plugin, current.text, 80);
}

export interface BuildStatsOptions {
  weights: WeaknessWeights;
  maxHistoryLength?: number;
  now?: number;
  /** Complete descendant list from the current rebuild's focused document. */
  remScope?: Rem[];
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
  let multipleChoice = previous?.multipleChoice;
  let notebook = previous?.notebook;
  let parentText = previous?.parentText;
  let tags = previous?.tags;

  // Old cache records have no contentUpdatedAt, deliberately forcing one
  // migration pass. This is essential for MCQs: the original cache only kept
  // flattened prompt/answer strings and therefore cannot contain options.
  const contentChanged = !previous || previous.remId !== rem._id || previous.contentUpdatedAt !== rem.updatedAt;
  if (contentChanged || promptText === undefined) {
    multipleChoice = undefined;
    promptText = await richTextToPlain(plugin, rem.text, 140);
    answerText = await richTextToPlain(plugin, rem.backText, 140);
    
    // Native MCQs have the `mc` power-up on their container and answer
    // card-item descendants. This is deliberately independent of backText:
    // RemNote uses no conventional back for an MCQ.
    let mcqContainer = await findMultipleChoiceContainer(plugin, rem, opts.remScope);
    if (!mcqContainer) {
      // Fallback: If the user only uses MCQs, and the rem itself has children, treat it as the MCQ container.
      mcqContainer = rem;
    }

    if (mcqContainer) {
      const options = await getMultipleChoiceOptions(plugin, mcqContainer, opts.remScope);
      if (options.length >= 2) {
        multipleChoice = {
          options,
          correctOptionIndexes: findCorrectOptionIndexes(answerText ?? '', options),
        };
        // The native queue does not reveal a conventional answer before an
        // MCQ selection, so keep this empty until the practice UI grades it.
        answerText = '';
      }
    }
    let parentRem: Rem | undefined;
    if (typeof rem.getParentRem === 'function') {
      parentRem = await rem.getParentRem();
    } else if ((rem as any).parent) {
      parentRem = await plugin.rem.findOne((rem as any).parent);
    }
    
    let tagRems: Rem[] | undefined;
    if (typeof rem.getTagRems === 'function') {
      tagRems = await rem.getTagRems();
    } else {
      // The SDK doesn't expose tagIds easily on the raw object, so we might need a workaround or just fetch the fully wrapped Rem
      const fullRem = await plugin.rem.findOne(rem._id);
      tagRems = (fullRem && typeof fullRem.getTagRems === 'function') ? await fullRem.getTagRems() : [];
    }

    const notebookName = await getNotebookName(plugin, rem);

    parentText = parentRem ? await richTextToPlain(plugin, parentRem.text, 80) : undefined;
    notebook = notebookName;
    tags = tagRems ? await Promise.all(tagRems.map((t) => richTextToPlain(plugin, t.text, 40))) : [];
  }

  return {
    cardId: card._id,
    remId: rem._id,
    promptText: promptText ?? '',
    answerText: answerText ?? '',
    multipleChoice,
    contentUpdatedAt: rem.updatedAt,
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
