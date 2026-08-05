import { RNPlugin } from '@remnote/plugin-sdk';
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
  eventData: unknown
): Promise<string | undefined> {
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
  const [allCards, settings, previousStats] = await Promise.all([
    plugin.card.getAll(),
    getSettings(plugin),
    loadAllStats(plugin),
  ]);

  const results: Awaited<ReturnType<typeof buildCardStats>>[] = [];
  for (let i = 0; i < allCards.length; i += batchSize) {
    const batch = allCards.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (card) => {
        const rem = await card.getRem();
        if (!rem) return undefined;
        return buildCardStats(plugin, card, rem, { weights: settings.weights }, previousStats[card._id]);
      })
    );
    for (const r of batchResults) if (r) results.push(r);
    onProgress?.({ processed: Math.min(i + batchSize, allCards.length), total: allCards.length });
    // Yield to the event loop so RemNote's UI stays responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await saveAllStats(plugin, results);
}
