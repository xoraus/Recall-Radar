# Recall Radar

A RemNote plugin that continuously tracks review outcomes for every
flashcard, computes a configurable "weakness score," and lets you practice
only the cards you keep getting wrong — "Anki Stats + Targeted Practice"
inside RemNote.

This README covers architecture, setup, how scoring/storage work, and the
explicit assumptions/limitations called out where the RemNote Plugin API
docs didn't give a definitive answer. Everything below was verified against
`@remnote/plugin-sdk@0.0.30`'s actual type definitions and the live docs at
https://plugins.remnote.com — nothing here is guessed.

## Install / development setup

```bash
npm install
npm run dev      # webpack-dev-server on :8080, for local plugin development
npm run build     # production build -> dist/
npm run check-types
```

To load it in RemNote during development, follow RemNote's standard
"install a local/dev plugin" flow (Settings → Plugins → Develop), pointing
at `http://localhost:8080` while `npm run dev` is running.

`npm run build` produces `dist/`, with one JS/CSS/HTML bundle per file in
`src/widgets/` (this mirrors the official plugin template's convention:
each widget file becomes an independent bundle registered via
`plugin.app.registerWidget`).

## Architecture

```
src/
  widgets/
    index.tsx      Plugin entrypoint: registers widgets, commands,
                    settings, and the QueueCompleteCard/QueueExit listeners.
                    Not itself a rendered widget.
    dashboard.tsx   Main dashboard: overview, tables, charts, search,
                    settings, export. Registered at WidgetLocation.Pane.
    practice.tsx    Practice session UI: filter picker + flashcard drill
                    loop. Registered at WidgetLocation.Pane.
    sidebar.tsx     Compact at-a-glance widget for WidgetLocation.RightSidebar.
  lib/
    types.ts        CardStats / PluginSettings / PracticeFilter types.
    stats.ts         Derives CardStats from a RemNote Card + Rem.
    score.ts         The weakness-score formula (isolated, easy to tune).
    storage.ts       Sharded local-storage cache + synced settings.
    reviewTracker.ts Incremental per-review update + full rebuild routine.
    practice.ts      Built-in practice filters + "until mastered" logic.
    analytics.ts     Dashboard aggregations (top forgotten, weakest
                      subjects/chapters, most improved, heatmap data, etc).
    exportData.ts    JSON/CSV export.
    richtext.ts      RichText -> plain text via plugin.richText.toString().
  components/        Shared React pieces (StatsCard, Charts, CardTable, CardDetail).
  styles.css         Plugin styles; follows RemNote's `.dark` convention
                      for dark mode (see "Custom CSS" in the plugin docs).
```

## Key architectural decision: no duplicate review log

The brief's suggested `CardStats` shape implies tracking every review event
yourself. **We deliberately did not do that.** RemNote's own `Card` object
(`plugin.card.getAll()` / `plugin.card.findOne()`) already exposes
`repetitionHistory: { date, score, responseTime?, isCram? }[]` — the
authoritative review log RemNote's own scheduler uses.

So `lib/stats.ts` *derives* `CardStats` (misses, streaks, accuracy,
weakness score, per-day history) from `Card.repetitionHistory` on demand,
and `lib/storage.ts` caches only the compact, derived result — not a
second copy of the raw log. This satisfies the brief's own "avoid
excessive storage growth" / "avoid writing excessively" requirements better
than a bolted-on tracker would, and it can never drift out of sync with
RemNote's real scheduling data.

**Assumption (explicitly flagged):** `RepetitionStatus.score` doesn't carry
an explicit "correct/incorrect" flag. We treat `AGAIN` as incorrect and
`HARD`/`GOOD`/`EASY`/`VIEWED_AS_LEECH` as correct, and exclude `TOO_EARLY`
and `RESET` entries from accuracy math entirely (they aren't genuine recall
attempts). This mapping lives in one place — `lib/stats.ts`,
`isScoredAttempt`/`isCorrectAttempt` — if you want to change it.

## Weakness score

```
weakness = misses × missWeight
         + consecutiveMisses × consecutiveMissWeight
         + (100 − accuracy) × accuracyWeight
         + min(daysSinceCorrect, cap) × daysSinceCorrectWeight
```

All four weights (and the cap) are user-configurable from the Dashboard's
Settings tab, stored in RemNote's **Synced** storage (`lib/storage.ts`) so
they follow you across devices. The formula lives in a single function
(`lib/score.ts::computeWeaknessScore`) so it's trivial to replace with a
different model later.

## Storage

- **Derived stats cache** (`CardStats` per card): RemNote **Local** storage,
  sharded into 64 fixed-size chunks (`lib/storage.ts`). A single review
  only rewrites the one chunk containing that card (`upsertCardStats`),
  not the whole cache — this is what keeps normal reviews fast even with
  50,000+ cards. Reading all stats for the dashboard is a fixed 64 reads,
  not one-per-card.
- **Settings**: RemNote **Synced** storage (small, so cross-device sync is
  cheap and useful here).
- **Full rebuild**: `lib/reviewTracker.ts::rebuildAllStats` walks
  `plugin.card.getAll()` in batches of 200, yielding to the event loop
  (`setTimeout(0)`) between batches so the UI never freezes, per the
  "never freeze the UI" / "support 50,000+ cards" requirement. It runs
  automatically on first install and is also available as a manual command
  and dashboard button.

## Automatic review tracking — a flagged limitation

`AppEvents.QueueCompleteCard` is confirmed (via the SDK's own event
constants) to fire once per answered card. What is **not** documented
anywhere (docs site or the installed SDK's type definitions) is the shape
of its callback payload. We read `data?.cardId ?? data?.card?._id`
defensively (`lib/reviewTracker.ts::resolveCompletedCardId`) and no-op if
neither is present, rather than calling an undocumented API to guess the
current card.

As a **robustness fallback that does not depend on this assumption at
all**, `index.tsx` also triggers a full background `rebuildAllStats()` on
`AppEvents.QueueExit` (end of each queue session). Because rebuilds are
derived straight from `Card.repetitionHistory` and yield to the UI thread,
this is safe to run automatically and guarantees your stats are eventually
correct even if the per-review fast-path payload assumption turns out to
be wrong. If you confirm the actual payload shape in your RemNote version,
`resolveCompletedCardId` is the one place to tighten it up.

## Practice sessions and the real SRS schedule

Practice sessions (`widgets/practice.tsx`) are a *separate* drill loop, not
the built-in RemNote queue. By default, answering a card in a practice
session does **not** touch RemNote's real spaced-repetition schedule — it
only affects the "until mastered" exit condition for that session. This is
a deliberate default: a targeted drill on your weakest cards shouldn't
silently reschedule when they're "really" due next.

If you'd rather have practice answers count as real reviews (so they also
reschedule the card and appear in `repetitionHistory`/your derived stats),
turn on **Settings → "Also update RemNote's real SRS schedule during
practice sessions"**. When enabled, we call the officially supported
`Card.updateCardRepetitionStatus(score)` for each answer.

We did *not* implement a separate practice-only outcome log as a way to
have it both ways ("practice affects displayed weakness, but not real
scheduling") — that would reintroduce the duplicate-storage problem this
plugin's core design avoids. This is a deliberate scope trade-off, not an
oversight.

## Feature coverage vs. the original spec

Implemented: automatic tracking (derived from `repetitionHistory`),
persistent stats, configurable weakness score, full dashboard (overview,
top forgotten, weakest subjects/chapters, most improved, recent mistakes,
cards forgotten today/week/month, search/filter, charts, settings, export),
all listed practice modes (missed today/yesterday/week/month, top-N
weakest, accuracy thresholds, missed-more-than, tag, search, practice until
mastered), card detail view with timeline, JSON/CSV export, sharded/batched
storage, lazy-paginated tables, right-sidebar quick view.

Simplified/deferred (clearly scoped out rather than half-implemented):

- **Card front/back rendering** uses a plain-text flattening of the Rem's
  `text`/`backText` via `plugin.richText.toString()`, not full rich
  formatting (LaTeX, images, cloze rendering). Swapping in RemNote's
  `RichText`/`RemViewer` React components for full-fidelity rendering is
  the natural next step and doesn't require touching the data layer.
- **Injecting weak cards into RemNote's actual queue UI** (rather than a
  separate in-plugin drill screen) would require the undocumented
  `SpecialPluginCallback.GetNextCard` global queue override, which replaces
  next-card logic queue-wide for all sessions, not just a scoped practice
  session. Given the risk of interfering with normal queue behavior, this
  plugin uses a self-contained practice screen instead — functionally
  equivalent for "practice only weak cards," without touching the shared
  callback.
- AI explanations, OCR, image cards, study planner, and cloud sync (listed
  under "Future-Proofing" in the spec) are intentionally out of scope for
  this version; the modular `lib/` structure (especially `analytics.ts` and
  `practice.ts`) is meant to make adding them later straightforward.

## Extending

- New weak-card filters: add a case to `lib/practice.ts::selectCardsForPractice`.
- New dashboard metrics: add a function to `lib/analytics.ts` and a tab in
  `widgets/dashboard.tsx`.
- Different weakness formula: edit `lib/score.ts` only.
- New settings: extend `PluginSettings` in `lib/types.ts`, update the
  defaults, and add a control in `SettingsPanel` (`widgets/dashboard.tsx`).
