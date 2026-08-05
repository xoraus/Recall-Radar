import { RNPlugin } from '@remnote/plugin-sdk';
import { CardStats, DEFAULT_SETTINGS, PluginSettings, WeaknessWeights } from './types';

/**
 * The stats cache is *derived* data (see stats.ts) so it lives in Local
 * (not Synced) storage — there's no need to push tens of thousands of
 * records through RemNote's cross-device sync, and it can always be
 * rebuilt from `plugin.card.getAll()` if it's missing or stale.
 *
 * To keep individual storage.setLocal() calls small and avoid rewriting one
 * giant blob on every single review, stats are sharded into fixed-size
 * chunks keyed by cardId hash. A lightweight index tracks which chunk each
 * card lives in and is the only thing rewritten on every single-card update
 * (see updateSingleCardStats in tracker/reviewTracker.ts).
 */
const CHUNK_COUNT = 64; // tune based on expected KB size; ~consistent 15-30k cards per chunk-set
const INDEX_KEY = 'wct:index:v1';
const CHUNK_KEY = (n: number) => `wct:chunk:v1:${n}`;
const SETTINGS_KEY = 'wct:settings:v1';
const REBUILD_META_KEY = 'wct:rebuilt-at:v1';

function chunkForCardId(cardId: string): number {
  let h = 0;
  for (let i = 0; i < cardId.length; i++) {
    h = (h * 31 + cardId.charCodeAt(i)) >>> 0;
  }
  return h % CHUNK_COUNT;
}

type ChunkMap = Record<string, CardStats>;

async function readChunk(plugin: RNPlugin, n: number): Promise<ChunkMap> {
  const chunk = await plugin.storage.getLocal<ChunkMap>(CHUNK_KEY(n));
  return chunk ?? {};
}

async function writeChunk(plugin: RNPlugin, n: number, chunk: ChunkMap): Promise<void> {
  await plugin.storage.setLocal(CHUNK_KEY(n), chunk);
}

/** Loads every card's cached stats. O(CHUNK_COUNT) reads, not O(cards). */
export async function loadAllStats(plugin: RNPlugin): Promise<Record<string, CardStats>> {
  const chunks = await Promise.all(Array.from({ length: CHUNK_COUNT }, (_, n) => readChunk(plugin, n)));
  const merged: Record<string, CardStats> = {};
  for (const chunk of chunks) Object.assign(merged, chunk);
  return merged;
}

/** Overwrites the entire cache. Used by the full rebuild routine. */
export async function saveAllStats(plugin: RNPlugin, stats: CardStats[]): Promise<void> {
  const buckets: ChunkMap[] = Array.from({ length: CHUNK_COUNT }, () => ({}));
  for (const s of stats) {
    buckets[chunkForCardId(s.cardId)][s.cardId] = s;
  }
  // Batch writes: one setLocal call per chunk instead of per card.
  await Promise.all(buckets.map((b, n) => writeChunk(plugin, n, b)));
  await plugin.storage.setLocal(INDEX_KEY, { cardCount: stats.length, updatedAt: Date.now() });
  await plugin.storage.setLocal(REBUILD_META_KEY, Date.now());
}

/** Reads one card's cached stats by loading only its chunk (not the whole cache). */
export async function getSingleCardStats(plugin: RNPlugin, cardId: string): Promise<CardStats | undefined> {
  const chunk = await readChunk(plugin, chunkForCardId(cardId));
  return chunk[cardId];
}

/** Updates (or inserts) a single card's stats without touching other chunks. */
export async function upsertCardStats(plugin: RNPlugin, stats: CardStats): Promise<void> {
  const n = chunkForCardId(stats.cardId);
  const chunk = await readChunk(plugin, n);
  chunk[stats.cardId] = stats;
  await writeChunk(plugin, n, chunk);
}

export async function getLastRebuildTime(plugin: RNPlugin): Promise<number | undefined> {
  return plugin.storage.getLocal<number>(REBUILD_META_KEY);
}

// ---------------------------------------------------------------------------
// Settings (small, so these use Synced storage to follow the user across
// devices, per the "Synced Storage" section of the RemNote storage docs).
// ---------------------------------------------------------------------------

export async function getSettings(plugin: RNPlugin): Promise<PluginSettings> {
  const stored = await plugin.storage.getSynced<PluginSettings>(SETTINGS_KEY);
  if (!stored) return DEFAULT_SETTINGS;
  // Shallow-merge so new fields added in future versions get sane defaults.
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    weights: { ...DEFAULT_SETTINGS.weights, ...(stored.weights ?? {}) },
  };
}

export async function saveSettings(plugin: RNPlugin, settings: PluginSettings): Promise<void> {
  await plugin.storage.setSynced(SETTINGS_KEY, settings);
}

export async function saveWeights(plugin: RNPlugin, weights: Partial<WeaknessWeights>): Promise<void> {
  const current = await getSettings(plugin);
  await saveSettings(plugin, { ...current, weights: { ...current.weights, ...weights } });
}
