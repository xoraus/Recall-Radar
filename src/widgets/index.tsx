import {
  AppEvents,
  declareIndexPlugin,
  ReactRNPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { rebuildAllStats, resolveCompletedCardId, updateSingleCardStats } from '../lib/reviewTracker';
import { getLastRebuildTime } from '../lib/storage';
import { DEFAULT_WEIGHTS } from '../lib/types';

async function registerSettings(plugin: ReactRNPlugin) {
  await plugin.settings.registerNumberSetting({
    id: 'rr-weight-miss',
    title: 'Weakness weight: total misses',
    defaultValue: DEFAULT_WEIGHTS.missWeight,
  });
  await plugin.settings.registerNumberSetting({
    id: 'rr-weight-consecutive-miss',
    title: 'Weakness weight: consecutive misses',
    defaultValue: DEFAULT_WEIGHTS.consecutiveMissWeight,
  });
  await plugin.settings.registerNumberSetting({
    id: 'rr-weight-accuracy',
    title: 'Weakness weight: (100 - accuracy)',
    defaultValue: DEFAULT_WEIGHTS.accuracyWeight,
  });
  await plugin.settings.registerNumberSetting({
    id: 'rr-weight-days-since-correct',
    title: 'Weakness weight: days since last correct',
    defaultValue: DEFAULT_WEIGHTS.daysSinceCorrectWeight,
  });
  await plugin.settings.registerNumberSetting({
    id: 'rr-min-miss-count',
    title: 'Minimum miss count to count as "weak"',
    defaultValue: 1,
  });
  await plugin.settings.registerNumberSetting({
    id: 'rr-min-accuracy-threshold',
    title: 'Minimum accuracy % to count as "weak"',
    defaultValue: 80,
  });
  await plugin.settings.registerNumberSetting({
    id: 'rr-mastery-consecutive-correct',
    title: 'Practice-until-mastered: consecutive correct required',
    defaultValue: 2,
  });
  await plugin.settings.registerBooleanSetting({
    id: 'rr-feed-scheduler',
    title: 'Also update RemNote\u2019s built-in SRS schedule during practice sessions',
    defaultValue: true,
  });

  // NOTE: PluginSettings in lib/storage.ts is the source of truth actually
  // read by the dashboard/practice widgets (via Synced Storage, so it also
  // works across devices). These plugin.settings.* entries are surfaced in
  // RemNote's native Settings panel for convenience/discoverability; the
  // Dashboard's own Settings tab writes to Synced Storage directly. Keeping
  // both in sync is done by reading plugin.settings.getSetting() once on
  // activation and seeding Synced Storage if it's empty (see below).
}

async function onActivate(plugin: ReactRNPlugin) {
  await registerSettings(plugin);

  await plugin.app.registerWidget('dashboard', WidgetLocation.Pane, {
    widgetTabTitle: 'Recall Radar',
  });

  await plugin.app.registerWidget('sidebar', WidgetLocation.RightSidebar, {
    dimensions: { height: 'auto', width: 350 },
  });

  await plugin.app.registerCommand({
    id: 'rr-open-dashboard',
    name: 'Recall Radar: Open Dashboard',
    quickCode: 'rr',
    action: async () => {
      await plugin.window.openWidgetInPane('dashboard');
    },
  });

  await plugin.app.registerCommand({
    id: 'rr-rebuild-stats',
    name: 'Recall Radar: Rebuild Statistics',
    action: async () => {
      await plugin.app.toast('Recall Radar: rebuilding statistics\u2026');
      await rebuildAllStats(plugin);
      await plugin.app.toast('Recall Radar: statistics rebuilt.');
    },
  });

  // --- Automatic review tracking -------------------------------------
  // Fires once per answered card in the normal flashcard queue. We only
  // touch the single affected card's cache entry (see reviewTracker.ts),
  // so this adds negligible overhead to normal reviews.
  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, async (...args: any[]) => {
    const cardId = await resolveCompletedCardId(plugin, ...args);
    if (cardId) {
      await updateSingleCardStats(plugin, cardId);
    }
  });

  // Safety net: resolveCompletedCardId's payload shape is an educated guess
  // (see reviewTracker.ts), so if it ever fails to resolve a cardId, the
  // per-review update above silently no-ops. To guarantee correctness
  // regardless, run a full background rebuild whenever a queue session
  // ends. rebuildAllStats yields to the UI thread every 200 cards, so this
  // never blocks the interface, and it self-corrects any missed updates.
  plugin.event.addListener(AppEvents.QueueExit, undefined, async () => {
    rebuildAllStats(plugin).catch(() => {
      /* best-effort; the next rebuild or manual "Rebuild Statistics" will retry */
    });
  });

  // Build the cache on first install if it doesn't exist yet.
  const lastRebuild = await getLastRebuildTime(plugin);
  if (!lastRebuild) {
    // Fire and forget; the dashboard shows a "building\u2026" state until done.
    rebuildAllStats(plugin).catch(() => {
      /* surfaced to the user via the dashboard's error state */
    });
  }
}

async function onDeactivate(_: ReactRNPlugin) {
  // No teardown required: registerWidget/registerCommand/settings are
  // automatically cleaned up by RemNote when the plugin is disabled.
}

declareIndexPlugin(onActivate, onDeactivate);
