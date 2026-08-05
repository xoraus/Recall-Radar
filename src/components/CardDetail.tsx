import React from 'react';
import { CardStats } from '../lib/types';

export function CardDetail({ stats, onClose }: { stats: CardStats; onClose: () => void }) {
  return (
    <div className="wct-modal-backdrop" onClick={onClose}>
      <div className="wct-modal" onClick={(e) => e.stopPropagation()}>
        <button className="wct-modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
        <h3>Card Detail</h3>
        <div className="wct-detail-grid">
          <div>
            <div className="wct-detail-label">Question</div>
            <div className="wct-detail-value">{stats.promptText || '(empty)'}</div>
          </div>
          <div>
            <div className="wct-detail-label">Answer</div>
            <div className="wct-detail-value">{stats.answerText || '(empty)'}</div>
          </div>
        </div>

        <div className="wct-detail-stats">
          <div>
            Accuracy: <strong>{stats.accuracy}%</strong>
          </div>
          <div>
            Misses: <strong>{stats.misses}</strong>
          </div>
          <div>
            Correct: <strong>{stats.correct}</strong>
          </div>
          <div>
            Weakness score: <strong>{stats.weaknessScore}</strong>
          </div>
          <div>
            Longest miss streak: <strong>{stats.longestMissStreak}</strong>
          </div>
          <div>
            Longest correct streak: <strong>{stats.longestCorrectStreak}</strong>
          </div>
        </div>

        <div className="wct-detail-meta">
          {stats.notebook && (
            <div>
              Notebook: <em>{stats.notebook}</em>
            </div>
          )}
          {stats.parentText && (
            <div>
              Parent Rem: <em>{stats.parentText}</em>
            </div>
          )}
          {stats.tags.length > 0 && (
            <div>
              Tags: <em>{stats.tags.join(', ')}</em>
            </div>
          )}
        </div>

        <div className="wct-detail-label" style={{ marginTop: 12 }}>
          Review Timeline
        </div>
        <div className="wct-timeline">
          {stats.history.length === 0 && <span>No reviews yet.</span>}
          {stats.history.map((h, i) => (
            <span key={i} className={h.correct ? 'wct-tick-ok' : 'wct-tick-bad'} title={new Date(h.date).toLocaleDateString()}>
              {h.correct ? '\u2705' : '\u274c'}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
