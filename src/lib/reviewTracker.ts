import { Card, RNPlugin } from '@remnote/plugin-sdk';
import { buildCardStats } from './stats';
import { getSettings, getSingleCardStats, loadAllStats, saveAllStats, upsertCardStats } from './storage';

/**
 * ASSUMPTION / KNOWN LIMITATION (flagged per the "do not invent APIs"
 * requirement): `AppEvents.QueueCompleteCard` fires once per answered card,
 * but its callback payload shape is not published in the SDK's type
 * definitions, and the installed SDK version (0.0.30) does not expose a
 * `plugin.queue.getCurrentCard()` getter to fall back on. We therefore read
 * `data?.cardId` (or `data?.card?._id`) defensively and no-op if neither is
 * present, rather than guessing at an unstable/undocumented API.
 *
 * If you confirm the actual payload shape (e.g. by logging `data` in dev
 * mode), update this function accordingly — it's the single place this
 * assumption lives. A fully robust alternative that doesn't depend on the
 * event payload at all would be to periodically diff `plugin.card.getAll()`
 * against the cache (see `rebuildAllStats`), trading immediacy for
 * certainty; that's a reasonable fallback if `cardId` turns out to be
 * unavailable in practice.
 */
export async function resolveCompletedCardId(
  _plugin: RNPlugin,
  ...args: any[]
): Promise<string | undefined> {
  const eventData = args[0];
  
  if (typeof eventData === 'string') {
    // If the event payload is just strings, it might be (remId, cardId) or just (cardId).
    // We'll guess the last string argument is the cardId just in case.
    const lastString = args.reverse().find(a => typeof a === 'string');
    return lastString;
  }

  const data = eventData as { cardId?: string; card?: { _id?: string } } | undefined;
  return data?.cardId ?? data?.card?._id;
}

/** Recomputes and caches stats for exactly one card. Cheap: O(1) storage I/O. */
export async function updateSingleCardStats(plugin: RNPlugin, cardId: string): Promise<void> {
  const [card, settings] = await Promise.all([plugin.card.findOne(cardId), getSettings(plugin)]);
  if (!card) return;
  const rem = await card.getRem();
  if (!rem) return;

  const previous = await getSingleCardStats(plugin, cardId);
  const stats = await buildCardStats(plugin, card, rem, { weights: settings.weights }, previous);
  await upsertCardStats(plugin, stats);
}

export interface RebuildProgress {
  processed: number;
  total: number;
  phase?: string;
}

/**
 * Rebuilds the entire stats cache from RemNote's own `repetitionHistory`.
 * Processes cards in batches with a `setTimeout(0)` yield between batches so
 * the UI thread is never blocked for long, per the "never freeze the UI" /
 * "support 50,000+ cards" requirement.
 */
export async function rebuildAllStats(
  plugin: RNPlugin,
  onProgress?: (p: RebuildProgress) => void,
  batchSize = 200
): Promise<void> {
  const [settings, previousStats] = await Promise.all([
    getSettings(plugin),
    loadAllStats(plugin),
  ]);

  // plugin.rem.getAll() and plugin.card.getAll() are completely deprecated in newer SDKs
  // and will throw an internal API error to prevent DB-wide scanning.
  // Instead, we must scan from the currently focused document/folder.
  const focusedRem = await plugin.focus.getFocusedRem();
  
  if (!focusedRem) {
    throw new Error('Please open a Document or Folder containing your flashcards before clicking Rebuild. RemNote no longer allows scanning the entire database at once.');
  }

  const allRems = await focusedRem.getDescendants();
  // Include the focused rem itself in case it's a flashcard
  allRems.push(focusedRem);
  
  const allCards: Card[] = [];

  // Notify initial progress
  onProgress?.({ processed: 0, total: allRems.length, phase: 'Discovered Rems' });

  // Fetch cards in chunks to avoid overwhelming the IPC bridge
  for (let i = 0; i < allRems.length; i += batchSize) {
    const chunk = allRems.slice(i, i + batchSize);
    const cardsList = await Promise.all(chunk.map((r) => r.getCards().catch(() => [])));
    for (const cards of cardsList) {
      if (cards && cards.length > 0) {
        allCards.push(...cards);
      }
    }
    onProgress?.({ processed: Math.min(i + batchSize, allRems.length), total: allRems.length, phase: 'Fetching cards' });
  }

  const results: Awaited<ReturnType<typeof buildCardStats>>[] = [];
  for (let i = 0; i < allCards.length; i += batchSize) {
    const batch = allCards.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (card) => {
        const rem = await card.getRem();
        if (!rem) return undefined;
        return buildCardStats(
          plugin,
          card,
          rem,
          { weights: settings.weights, remScope: allRems },
          previousStats[card._id]
        );
      })
    );
    for (const r of batchResults) if (r) results.push(r);
    onProgress?.({ processed: Math.min(i + batchSize, allCards.length), total: allCards.length, phase: 'Processing cards' });
    // Yield to the event loop so RemNote's UI stays responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await saveAllStats(plugin, results);
  onProgress?.({
    processed: allCards.length,
    total: allCards.length,
    phase: `Found ${results.filter((stat) => stat.multipleChoice).length} multiple-choice cards`,
  });
}
