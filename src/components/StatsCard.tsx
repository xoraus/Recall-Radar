import React from 'react';

export function StatsCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="wct-stat-card">
      <div className="wct-stat-value">{value}</div>
      <div className="wct-stat-label">{label}</div>
      {sub && <div className="wct-stat-sub">{sub}</div>}
    </div>
  );
}
