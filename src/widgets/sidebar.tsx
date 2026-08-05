import React, { useEffect, useState } from 'react';
import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { CardStats, PluginSettings } from '../lib/types';
import { getSettings, loadAllStats } from '../lib/storage';
import { computeOverallStats, topForgotten } from '../lib/analytics';
import '../styles.css';

function SidebarWidget() {
  const plugin = usePlugin();
  const [stats, setStats] = useState<CardStats[] | null>(null);
  const [settings, setSettings] = useState<PluginSettings | null>(null);

  useEffect(() => {
    (async () => {
      const [all, s] = await Promise.all([loadAllStats(plugin), getSettings(plugin)]);
      setStats(Object.values(all));
      setSettings(s);
    })();
  }, [plugin]);

  if (!stats || !settings) {
    return <div className="rr-loading rr-small">Loading\u2026</div>;
  }

  const overall = computeOverallStats(stats, settings.minMissCountForWeak);
  const worst = topForgotten(stats, 5);

  return (
    <div className="rr-sidebar">
      <h4>Recall Radar</h4>
      <div className="rr-sidebar-stats">
        <div>
          Accuracy: <strong>{overall.accuracy}%</strong>
        </div>
        <div>
          Weak cards: <strong>{overall.totalWeakCards}</strong>
        </div>
        <div>
          Reviews today: <strong>{overall.reviewsToday}</strong>
        </div>
      </div>

      <h5>Top Forgotten</h5>
      <ul className="rr-sidebar-list">
        {worst.map((s) => (
          <li key={s.cardId} title={s.promptText}>
            {s.promptText.slice(0, 40) || '(empty)'} <span className="rr-muted">&times;{s.misses}</span>
          </li>
        ))}
        {worst.length === 0 && <li className="rr-muted">No missed cards yet.</li>}
      </ul>

      <button className="rr-primary-btn" onClick={() => plugin.window.openWidgetInPane('dashboard')}>
        Practice Now
      </button>
      <button onClick={() => plugin.window.openWidgetInPane('dashboard')}>Open Dashboard</button>
    </div>
  );
}

renderWidget(SidebarWidget);
