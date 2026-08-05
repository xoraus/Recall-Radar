import React, { useEffect, useMemo, useState } from 'react';
import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { CardStats, PluginSettings } from '../lib/types';
import { getLastRebuildTime, getSettings, loadAllStats, saveSettings } from '../lib/storage';
import { rebuildAllStats, RebuildProgress } from '../lib/reviewTracker';
import {
  accuracyOverTime,
  computeOverallStats,
  difficultyDistribution,
  forgottenInWindow,
  mostImproved,
  recentMistakes,
  reviewHeatmap,
  topForgotten,
  weakestChapters,
  weakestSubjects,
} from '../lib/analytics';
import { exportStatsAsCSV, exportStatsAsJSON, exportWeakCardsAsCSV } from '../lib/exportData';
import { StatsCard } from '../components/StatsCard';
import { CardTable } from '../components/CardTable';
import { CardDetail } from '../components/CardDetail';
import { GroupBarChart, DifficultyDistributionChart, AccuracyOverTimeChart, MistakesOverTimeChart, ReviewHeatmap } from '../components/Charts';
import { BUILT_IN_FILTERS, isMastered, selectCardsForPractice } from '../lib/practice';
import { upsertCardStats } from '../lib/storage';
import { buildCardStats } from '../lib/stats';
import { QueueInteractionScore } from '@remnote/plugin-sdk';
import type { PracticeFilter } from '../lib/types';
import '../styles.css';

type SessionOutcome = 'again' | 'hard' | 'good' | 'easy';

function shuffledOptionIndexes(length: number, seed: string): number[] {
  // Deterministic per card within a session: choices move between cards but
  // never jump while the learner is deciding.
  let value = Array.from(seed).reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 2166136261);
  const indexes = Array.from({ length }, (_, index) => index);
  for (let index = indexes.length - 1; index > 0; index--) {
    value = (value * 1664525 + 1013904223) >>> 0;
    const target = value % (index + 1);
    [indexes[index], indexes[target]] = [indexes[target], indexes[index]];
  }
  return indexes;
}

const OUTCOME_SCORE: Record<SessionOutcome, QueueInteractionScore> = {
  again: QueueInteractionScore.AGAIN,
  hard: QueueInteractionScore.HARD,
  good: QueueInteractionScore.GOOD,
  easy: QueueInteractionScore.EASY,
};

function FilterPicker({
  onStart,
  tags,
}: {
  onStart: (filter: PracticeFilter) => void;
  tags: string[];
}) {
  const [customTag, setCustomTag] = useState('');
  const [search, setSearch] = useState('');

  return (
    <div className="rr-practice-picker">
      <h2>Practice Weak Cards</h2>
      <p className="rr-muted">Choose what to drill. Cards are ordered by weakness score, weakest first.</p>

      <div className="rr-filter-grid">
        {BUILT_IN_FILTERS.map((f) => (
          <button key={f.label} className="rr-filter-btn" onClick={() => onStart(f)}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="rr-custom-filters">
        <div className="rr-custom-row">
          <input
            placeholder="Search question/answer text\u2026"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            disabled={!search.trim()}
            onClick={() => onStart({ label: `Search: ${search}`, kind: 'search', search })}
          >
            Practice matches
          </button>
        </div>
        {tags.length > 0 && (
          <div className="rr-custom-row">
            <select value={customTag} onChange={(e) => setCustomTag(e.target.value)}>
              <option value="">Choose a tag\u2026</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              disabled={!customTag}
              onClick={() => onStart({ label: `Tag: ${customTag}`, kind: 'tag', tag: customTag })}
            >
              Practice tag
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PracticeSession({
  cards,
  settings,
  onFinish,
}: {
  cards: CardStats[];
  settings: PluginSettings;
  onFinish: () => void;
}) {
  const plugin = usePlugin();
  const [queue, setQueue] = useState<CardStats[]>(cards);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<number[]>([]);
  const [sessionCorrectStreak, setSessionCorrectStreak] = useState<Record<string, number>>({});
  const [summary, setSummary] = useState({ seen: 0, correct: 0 });
  const [activeRating, setActiveRating] = useState<SessionOutcome | null>(null);

  const current = queue[index];
  const isMultipleChoice = Boolean(current?.multipleChoice);
  const optionIndexes = useMemo(
    () => current?.multipleChoice ? shuffledOptionIndexes(current.multipleChoice.options.length, current.cardId) : [],
    [current?.cardId, current?.multipleChoice]
  );
  const mcqCorrect = current?.multipleChoice
    ? selectedOptions.length === current.multipleChoice.correctOptionIndexes.length &&
      selectedOptions.every((option) => current.multipleChoice!.correctOptionIndexes.includes(option))
    : false;

  function selectOption(optionIndex: number) {
    if (!current?.multipleChoice || revealed) return;
    setSelectedOptions([optionIndex]);
    setRevealed(true);
  }

  function submitMultipleChoice() {
    if (!current?.multipleChoice || selectedOptions.length === 0) return;
    setRevealed(true);
  }

  useEffect(() => {
    if (!isMultipleChoice || !current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;

      const optionNumber = Number(event.key);
      if (!revealed && optionNumber >= 1 && optionNumber <= optionIndexes.length) {
        event.preventDefault();
        selectOption(optionIndexes[optionNumber - 1]);
      } else if (revealed && optionNumber >= 1 && optionNumber <= 4) {
        event.preventDefault();
        const outcomes: SessionOutcome[] = ['again', 'hard', 'good', 'easy'];
        void answer(outcomes[optionNumber - 1]);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (!revealed) submitMultipleChoice();
        else void answer(mcqCorrect ? 'hard' : 'again');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [current, isMultipleChoice, mcqCorrect, optionIndexes, revealed, selectedOptions]);

  async function answer(outcome: SessionOutcome) {
    if (!current || activeRating) return;
    setActiveRating(outcome);

    // Wait a brief moment so the user sees the button highlight
    await new Promise((resolve) => setTimeout(resolve, 200));

    const ok = outcome !== 'again';
    setSummary((s) => ({ seen: s.seen + 1, correct: s.correct + (ok ? 1 : 0) }));

    const streak = sessionCorrectStreak[current.cardId] ?? 0;
    const newStreak = ok ? streak + 1 : 0;
    setSessionCorrectStreak((m) => ({ ...m, [current.cardId]: newStreak }));

    if (settings.feedPracticeResultsToScheduler) {
      const card = await plugin.card.findOne(current.cardId);
      if (card) {
        await card.updateCardRepetitionStatus(OUTCOME_SCORE[outcome]);
        const rem = await card.getRem();
        if (rem) {
          const fresh = await buildCardStats(plugin, card, rem, { weights: settings.weights }, current);
          await upsertCardStats(plugin, fresh);
        }
      }
    }

    const mastered = isMastered(newStreak, current.weaknessScore, settings);
    setActiveRating(null);
    setRevealed(false);
    setSelectedOptions([]);

    if (mastered) {
      const nextQueue = queue.filter((c) => c.cardId !== current.cardId);
      setQueue(nextQueue);
      setIndex((i) => Math.min(i, Math.max(0, nextQueue.length - 1)));
    } else {
      setQueue((q) => {
        const rest = q.filter((_, i) => i !== index);
        return [...rest, current];
      });
      if (index >= queue.length - 1) setIndex(0);
    }
  }

  if (!current) {
    return (
      <div className="rr-session-done">
        <h2>Session complete \ud83c\udf89</h2>
        <p>
          Reviewed {summary.seen} card{summary.seen === 1 ? '' : 's'},{' '}
          {summary.seen > 0 ? Math.round((summary.correct / summary.seen) * 100) : 0}% correct this session.
        </p>
        <button onClick={onFinish}>Back to filters</button>
      </div>
    );
  }

  return (
    <div className="rr-session">
      <div className="rr-session-progress">
        {queue.length} card{queue.length === 1 ? '' : 's'} remaining &middot; weakness {current.weaknessScore}
      </div>
      <div className="rr-flashcard" key={current.cardId}>
        <div className="rr-flashcard-face">{current.promptText || '(empty front)'}</div>
        {isMultipleChoice && current.multipleChoice && (
          <div className="rr-mcq-options" role="group" aria-label="Answer choices">
            {optionIndexes.map((optionIndex, displayIndex) => {
              const selected = selectedOptions.includes(optionIndex);
              const correct = current.multipleChoice!.correctOptionIndexes.includes(optionIndex);
              const feedback = revealed ? (correct ? ' is-correct' : selected ? ' is-incorrect' : '') : '';
              return (
                <button
                  key={optionIndex}
                  className={`rr-mcq-option${selected ? ' is-selected' : ''}${feedback}`}
                  onClick={() => selectOption(optionIndex)}
                  disabled={revealed}
                  aria-pressed={selected}
                >
                  <span className="rr-mcq-option-radio" />
                  <span className="rr-mcq-option-text">{current.multipleChoice!.options[optionIndex]}</span>
                  {revealed && correct && <span className="rr-mcq-feedback">Correct</span>}
                  {revealed && selected && !correct && <span className="rr-mcq-feedback">Incorrect</span>}
                  <span className="rr-mcq-option-number">{displayIndex + 1}</span>
                </button>
              );
            })}
          </div>
        )}
        {revealed && !isMultipleChoice && <div className="rr-flashcard-answer">{current.answerText || '(empty back)'}</div>}
      </div>

      {isMultipleChoice && !revealed ? (
        <button className="rr-reveal-btn" onClick={submitMultipleChoice} disabled={selectedOptions.length === 0}>
          Check answer
        </button>
      ) : !revealed ? (
        <button className="rr-reveal-btn" onClick={() => setRevealed(true)}>
          Show Answer
        </button>
      ) : (
        <div className="rr-answer-buttons">
          <button className={`rr-btn-again${isMultipleChoice && !mcqCorrect ? ' is-recommended' : ''}${activeRating === 'again' ? ' is-active' : ''}`} onClick={() => answer('again')} title="Press 1 for Again">
            Again
          </button>
          <button className={`rr-btn-hard${isMultipleChoice && mcqCorrect ? ' is-recommended' : ''}${activeRating === 'hard' ? ' is-active' : ''}`} onClick={() => answer('hard')} title="Press 2 for Hard">
            Hard
          </button>
          <button className={`rr-btn-good${activeRating === 'good' ? ' is-active' : ''}`} onClick={() => answer('good')} title="Press 3 for Good">
            Good
          </button>
          <button className={`rr-btn-easy${activeRating === 'easy' ? ' is-active' : ''}`} onClick={() => answer('easy')} title="Press 4 for Easy">
            Easy
          </button>
        </div>
      )}

      <div className="rr-session-actions" style={{ display: 'flex', gap: '8px' }}>
        <button className="rr-exit-btn" onClick={onFinish} style={{ flex: 1 }}>
          End session
        </button>
        <button 
          className="rr-native-btn" 
          onClick={async () => {
            const rem = await plugin.rem.findOne(current.remId);
            if (rem) {
              await plugin.window.openRem(rem);
            }
          }}
          title="Open this card natively in RemNote"
        >
          View Native Card
        </button>
      </div>
    </div>
  );
}

function DashboardPractice({ settings, stats }: { settings: PluginSettings, stats: CardStats[] }) {
  const [activeFilter, setActiveFilter] = useState<PracticeFilter | null>(null);

  const tags = useMemo(() => {
    const set = new Set<string>();
    stats.forEach((s) => s.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [stats]);

  const allStatsObj = useMemo(() => {
    const obj: Record<string, CardStats> = {};
    stats.forEach(s => obj[s.cardId] = s);
    return obj;
  }, [stats]);

  const selectedCards = useMemo(() => {
    if (!activeFilter) return [];
    return selectCardsForPractice(allStatsObj, activeFilter, settings);
  }, [allStatsObj, settings, activeFilter]);

  if (!activeFilter) {
    return <FilterPicker onStart={setActiveFilter} tags={tags} />;
  }

  if (selectedCards.length === 0) {
    return (
      <div className="rr-session-done">
        <h2>Nothing to practice</h2>
        <p>No cards currently match "{activeFilter.label}". Nice work!</p>
        <button onClick={() => setActiveFilter(null)}>Back to filters</button>
      </div>
    );
  }

  return <PracticeSession cards={selectedCards} settings={settings} onFinish={() => setActiveFilter(null)} />;
}

const DAY = 24 * 60 * 60 * 1000;

type Tab =
  | 'overview'
  | 'practice'
  | 'top-forgotten'
  | 'weakest-subjects'
  | 'weakest-chapters'
  | 'improved'
  | 'recent-mistakes'
  | 'search'
  | 'charts'
  | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'practice', label: 'Practice' },
  { id: 'top-forgotten', label: 'Top Forgotten' },
  { id: 'weakest-subjects', label: 'Weakest Subjects' },
  { id: 'weakest-chapters', label: 'Weakest Chapters' },
  { id: 'improved', label: 'Most Improved' },
  { id: 'recent-mistakes', label: 'Recent Mistakes' },
  { id: 'search', label: 'Search & Filter' },
  { id: 'charts', label: 'Charts' },
  { id: 'settings', label: 'Settings' },
];

function useDashboardData() {
  const plugin = usePlugin();
  const [stats, setStats] = useState<CardStats[] | null>(null);
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [lastRebuild, setLastRebuild] = useState<number | undefined>(undefined);
  const [rebuilding, setRebuilding] = useState(false);
  const [progress, setProgress] = useState<RebuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const [all, s, t] = await Promise.all([loadAllStats(plugin), getSettings(plugin), getLastRebuildTime(plugin)]);
    setStats(Object.values(all));
    setSettings(s);
    setLastRebuild(t);
  };

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [plugin]);

  const rebuild = async () => {
    setError(null);
    setRebuilding(true);
    setProgress(null);
    try {
      await rebuildAllStats(plugin, (p) => setProgress(p));
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRebuilding(false);
    }
  };

  return { stats, settings, setSettings, lastRebuild, rebuilding, progress, error, rebuild, refresh };
}

function SettingsPanel({
  settings,
  onSave,
}: {
  settings: PluginSettings;
  onSave: (s: PluginSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);

  return (
    <div className="rr-settings">
      <h3>Weakness Formula Weights</h3>
      <p className="rr-muted rr-small">
        weakness = misses&times;missWeight + consecutiveMisses&times;consecutiveMissWeight + (100 -
        accuracy)&times;accuracyWeight + min(daysSinceCorrect, cap)&times;daysSinceCorrectWeight
      </p>
      <div className="rr-settings-grid">
        <label>
          Miss weight
          <input
            type="number"
            value={draft.weights.missWeight}
            onChange={(e) => setDraft({ ...draft, weights: { ...draft.weights, missWeight: Number(e.target.value) } })}
          />
        </label>
        <label>
          Consecutive miss weight
          <input
            type="number"
            value={draft.weights.consecutiveMissWeight}
            onChange={(e) =>
              setDraft({ ...draft, weights: { ...draft.weights, consecutiveMissWeight: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          Accuracy weight
          <input
            type="number"
            value={draft.weights.accuracyWeight}
            onChange={(e) =>
              setDraft({ ...draft, weights: { ...draft.weights, accuracyWeight: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          Days-since-correct weight
          <input
            type="number"
            value={draft.weights.daysSinceCorrectWeight}
            onChange={(e) =>
              setDraft({ ...draft, weights: { ...draft.weights, daysSinceCorrectWeight: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          Days-since-correct cap
          <input
            type="number"
            value={draft.weights.daysSinceCorrectCap}
            onChange={(e) =>
              setDraft({ ...draft, weights: { ...draft.weights, daysSinceCorrectCap: Number(e.target.value) } })
            }
          />
        </label>
      </div>

      <h3>Weak-Card Thresholds</h3>
      <div className="rr-settings-grid">
        <label>
          Minimum miss count
          <input
            type="number"
            value={draft.minMissCountForWeak}
            onChange={(e) => setDraft({ ...draft, minMissCountForWeak: Number(e.target.value) })}
          />
        </label>
        <label>
          Minimum accuracy threshold %
          <input
            type="number"
            value={draft.minAccuracyThresholdPct}
            onChange={(e) => setDraft({ ...draft, minAccuracyThresholdPct: Number(e.target.value) })}
          />
        </label>
      </div>

      <h3>Practice Until Mastered</h3>
      <div className="rr-settings-grid">
        <label>
          Consecutive correct required
          <input
            type="number"
            value={draft.masteryConsecutiveCorrect}
            onChange={(e) => setDraft({ ...draft, masteryConsecutiveCorrect: Number(e.target.value) })}
          />
        </label>
        <label>
          Weakness threshold to auto-graduate
          <input
            type="number"
            value={draft.masteryWeaknessThreshold}
            onChange={(e) => setDraft({ ...draft, masteryWeaknessThreshold: Number(e.target.value) })}
          />
        </label>
      </div>

      <label className="rr-checkbox-row">
        <input
          type="checkbox"
          checked={draft.feedPracticeResultsToScheduler}
          onChange={(e) => setDraft({ ...draft, feedPracticeResultsToScheduler: e.target.checked })}
        />
        Also update RemNote's real SRS schedule during practice sessions (off by default so drills don't
        reschedule your normal reviews)
      </label>

      <button className="rr-primary-btn" onClick={() => onSave(draft)}>
        Save Settings
      </button>
    </div>
  );
}

function DashboardWidget() {
  const { stats, settings, setSettings, lastRebuild, rebuilding, progress, error, rebuild, refresh } = useDashboardData();
  const [tab, setTab] = useState<Tab>('overview');
  const [detail, setDetail] = useState<CardStats | null>(null);
  const [search, setSearch] = useState('');
  const plugin = usePlugin();

  const filtered = useMemo(() => {
    if (!stats) return [];
    const q = search.toLowerCase().trim();
    if (!q) return stats;
    return stats.filter((s) => s.promptText.toLowerCase().includes(q) || s.answerText.toLowerCase().includes(q));
  }, [stats, search]);

  if (!stats || !settings) {
    return <div className="rr-loading">Loading Recall Radar\u2026</div>;
  }

  const overall = computeOverallStats(stats, settings.minMissCountForWeak);

  return (
    <div className="rr-dashboard">
      <header className="rr-header">
        <h1>Recall Radar</h1>
        <div className="rr-header-actions">
          <button
            onClick={rebuild}
            disabled={rebuilding}
            className="rr-rebuild-btn"
            title="Force a complete rescan of all cards in your workspace. This can take a while."
          >
            {rebuilding ? 'Rebuilding\u2026' : 'Rebuild Statistics'}
          </button>
        </div>
      </header>

      {progress && (
        <div className="rr-progress-bar">
          <div
            className="rr-progress-fill"
            style={{ width: `${(progress.processed / Math.max(1, progress.total)) * 100}%` }}
          ></div>
          <div className="rr-progress-text">
            {progress.phase ? `${progress.phase}: ` : ''}{progress.processed} / {progress.total}
          </div>
        </div>
      )}

      {error && (
        <div className="rr-error-message" style={{ color: 'red', marginTop: '10px' }}>
          <strong>Error during rebuild:</strong> {error}
        </div>
      )}

      <div className="rr-muted rr-small">
        {lastRebuild ? `Last full rebuild: ${new Date(lastRebuild).toLocaleString()}` : 'Statistics not yet built.'}
      </div>

      <nav className="rr-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'rr-tab-active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="rr-overview">
          <div className="rr-stats-row">
            <StatsCard label="Total Reviews" value={overall.totalReviews} />
            <StatsCard label="Total Wrong" value={overall.totalWrong} />
            <StatsCard label="Accuracy" value={`${overall.accuracy}%`} />
            <StatsCard label="Weak Cards" value={overall.totalWeakCards} />
          </div>
          <div className="rr-stats-row">
            <StatsCard label="Total Cards" value={overall.totalCards} />
            <StatsCard label="Tracked Cards" value={overall.trackedCards} />
            <StatsCard label="Reviews Today" value={overall.reviewsToday} />
            <StatsCard label="Reviews This Week" value={overall.reviewsThisWeek} />
          </div>
          <div className="rr-stats-row">
            <StatsCard label="Reviews This Month" value={overall.reviewsThisMonth} />
            <StatsCard label="Avg Miss Rate" value={`${overall.averageMissRate}%`} />
            <StatsCard label="Longest Wrong Streak" value={overall.longestWrongStreak} />
            <StatsCard label="Longest Correct Streak" value={overall.longestCorrectStreak} />
          </div>

          <h3>Cards Forgotten Today / This Week / This Month</h3>
          <div className="rr-stats-row">
            <StatsCard label="Forgotten Today" value={forgottenInWindow(stats, DAY).length} />
            <StatsCard label="Forgotten This Week" value={forgottenInWindow(stats, 7 * DAY).length} />
            <StatsCard label="Forgotten This Month" value={forgottenInWindow(stats, 30 * DAY).length} />
          </div>
        </div>
      )}

      {tab === 'top-forgotten' && <CardTable rows={topForgotten(stats, 100)} onOpenCard={setDetail} />}

      {tab === 'weakest-subjects' && (
        <>
          <GroupBarChart data={weakestSubjects(stats, 12)} />
          <table className="rr-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Cards</th>
                <th>Accuracy</th>
                <th>Avg Weakness</th>
              </tr>
            </thead>
            <tbody>
              {weakestSubjects(stats, 20).map((g) => (
                <tr key={g.name}>
                  <td>{g.name}</td>
                  <td>{g.cardCount}</td>
                  <td>{g.accuracy}%</td>
                  <td>{g.averageWeakness}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === 'weakest-chapters' && (
        <>
          <GroupBarChart data={weakestChapters(stats, 12)} />
          <table className="rr-table">
            <thead>
              <tr>
                <th>Chapter</th>
                <th>Cards</th>
                <th>Accuracy</th>
                <th>Avg Weakness</th>
              </tr>
            </thead>
            <tbody>
              {weakestChapters(stats, 20).map((g) => (
                <tr key={g.name}>
                  <td>{g.name}</td>
                  <td>{g.cardCount}</td>
                  <td>{g.accuracy}%</td>
                  <td>{g.averageWeakness}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === 'improved' && <CardTable rows={mostImproved(stats, 50)} onOpenCard={setDetail} />}

      {tab === 'recent-mistakes' && <CardTable rows={recentMistakes(stats, 100)} onOpenCard={setDetail} />}

      {tab === 'search' && (
        <div>
          <input
            className="rr-search-input"
            placeholder="Search question or answer text\u2026"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <CardTable rows={filtered.sort((a, b) => b.weaknessScore - a.weaknessScore)} onOpenCard={setDetail} />
        </div>
      )}

      {tab === 'charts' && (
        <div className="rr-charts">
          <h3>Accuracy Over Time</h3>
          <AccuracyOverTimeChart data={accuracyOverTime(stats, 30)} />
          <h3>Mistakes Over Time</h3>
          <MistakesOverTimeChart data={accuracyOverTime(stats, 30)} />
          <h3>Difficulty Distribution</h3>
          <DifficultyDistributionChart data={difficultyDistribution(stats)} />
          <h3>Review Activity (last 6 months)</h3>
          <ReviewHeatmap data={reviewHeatmap(stats, 182)} />
        </div>
      )}

      {tab === 'settings' && (
        <div>
          <SettingsPanel
            settings={settings}
            onSave={async (s) => {
              await saveSettings(plugin, s);
              setSettings(s);
              await refresh();
            }}
          />
          <h3>Export</h3>
          <div className="rr-export-row">
            <button onClick={() => exportStatsAsJSON(stats)}>Export All Stats (JSON)</button>
            <button onClick={() => exportStatsAsCSV(stats)}>Export All Stats (CSV)</button>
            <button onClick={() => exportWeakCardsAsCSV(stats, settings.minMissCountForWeak)}>
              Export Weak Cards (CSV)
            </button>
          </div>
        </div>
      )}

      {tab === 'practice' && (
        <DashboardPractice settings={settings} stats={stats} />
      )}

      {detail && <CardDetail stats={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

renderWidget(DashboardWidget);
