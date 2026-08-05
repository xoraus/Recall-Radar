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
import '../styles.css';

const DAY = 24 * 60 * 60 * 1000;

type Tab =
  | 'overview'
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

  const refresh = async () => {
    const [all, s, t] = await Promise.all([loadAllStats(plugin), getSettings(plugin), getLastRebuildTime(plugin)]);
    setStats(Object.values(all));
    setSettings(s);
    setLastRebuild(t);
  };

  useEffect(() => {
    refresh();
  }, [plugin]);

  const rebuild = async () => {
    setRebuilding(true);
    setProgress(null);
    await rebuildAllStats(plugin, (p) => setProgress(p));
    setRebuilding(false);
    await refresh();
  };

  return { stats, settings, setSettings, lastRebuild, rebuilding, progress, rebuild, refresh };
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
  const { stats, settings, setSettings, lastRebuild, rebuilding, progress, rebuild, refresh } = useDashboardData();
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
          <button onClick={() => plugin.window.openWidgetInPane('practice')}>Practice Weak Cards</button>
          <button onClick={rebuild} disabled={rebuilding}>
            {rebuilding ? 'Rebuilding\u2026' : 'Rebuild Statistics'}
          </button>
        </div>
      </header>

      {rebuilding && progress && (
        <div className="rr-progress-bar-wrap">
          <div
            className="rr-progress-bar"
            style={{ width: `${Math.round((progress.processed / Math.max(1, progress.total)) * 100)}%` }}
          />
          <span>
            {progress.processed} / {progress.total} cards
          </span>
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

      {detail && <CardDetail stats={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

renderWidget(DashboardWidget);
