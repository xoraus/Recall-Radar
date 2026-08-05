import React, { useEffect, useMemo, useState } from 'react';
import { QueueInteractionScore, renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { CardStats, PluginSettings } from '../lib/types';
import { getSettings, loadAllStats, upsertCardStats } from '../lib/storage';
import { buildCardStats } from '../lib/stats';
import { BUILT_IN_FILTERS, isMastered, selectCardsForPractice } from '../lib/practice';
import type { PracticeFilter } from '../lib/types';
import '../styles.css';

type SessionOutcome = 'again' | 'hard' | 'good' | 'easy';

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

      <p className="rr-muted rr-small">
        Every session runs in "practice until mastered" mode: a card leaves the queue once you've gotten it
        right twice in a row, or its live weakness score drops below your configured threshold.
      </p>
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
  const [sessionCorrectStreak, setSessionCorrectStreak] = useState<Record<string, number>>({});
  const [summary, setSummary] = useState({ seen: 0, correct: 0 });

  const current = queue[index];

  async function answer(outcome: SessionOutcome) {
    if (!current) return;
    const ok = outcome !== 'again';
    setSummary((s) => ({ seen: s.seen + 1, correct: s.correct + (ok ? 1 : 0) }));

    const streak = sessionCorrectStreak[current.cardId] ?? 0;
    const newStreak = ok ? streak + 1 : 0;
    setSessionCorrectStreak((m) => ({ ...m, [current.cardId]: newStreak }));

    // Optionally feed the outcome back into RemNote's real SRS schedule.
    // Off by default (see PluginSettings.feedPracticeResultsToScheduler) so
    // a targeted drill session doesn't silently reschedule the card's next
    // "real" review date. When on, this is the officially supported way to
    // record a review: Card.updateCardRepetitionStatus(). RemNote appends
    // to repetitionHistory and our derived stats pick it up automatically.
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
    setRevealed(false);

    if (mastered) {
      const nextQueue = queue.filter((c) => c.cardId !== current.cardId);
      setQueue(nextQueue);
      setIndex((i) => Math.min(i, Math.max(0, nextQueue.length - 1)));
    } else {
      // Not mastered yet: cycle this card to the back of the queue so it
      // comes up again later in the same session.
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
      <div className="rr-flashcard">
        <div className="rr-flashcard-face">{current.promptText || '(empty front)'}</div>
        {revealed && <div className="rr-flashcard-answer">{current.answerText || '(empty back)'}</div>}
      </div>

      {!revealed ? (
        <button className="rr-reveal-btn" onClick={() => setRevealed(true)}>
          Show Answer
        </button>
      ) : (
        <div className="rr-answer-buttons">
          <button className="rr-btn-again" onClick={() => answer('again')}>
            Again
          </button>
          <button className="rr-btn-hard" onClick={() => answer('hard')}>
            Hard
          </button>
          <button className="rr-btn-good" onClick={() => answer('good')}>
            Good
          </button>
          <button className="rr-btn-easy" onClick={() => answer('easy')}>
            Easy
          </button>
        </div>
      )}

      <button className="rr-exit-btn" onClick={onFinish}>
        End session
      </button>
    </div>
  );
}

function PracticeWidget() {
  const plugin = usePlugin();
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [allStats, setAllStats] = useState<Record<string, CardStats> | null>(null);
  const [activeFilter, setActiveFilter] = useState<PracticeFilter | null>(null);

  useEffect(() => {
    (async () => {
      const [s, stats] = await Promise.all([getSettings(plugin), loadAllStats(plugin)]);
      setSettings(s);
      setAllStats(stats);
    })();
  }, [plugin]);

  const tags = useMemo(() => {
    if (!allStats) return [];
    const set = new Set<string>();
    Object.values(allStats).forEach((s) => s.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [allStats]);

  const selectedCards = useMemo(() => {
    if (!allStats || !settings || !activeFilter) return [];
    return selectCardsForPractice(allStats, activeFilter, settings);
  }, [allStats, settings, activeFilter]);

  if (!settings || !allStats) {
    return <div className="rr-loading">Loading practice data\u2026</div>;
  }

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

renderWidget(PracticeWidget);
