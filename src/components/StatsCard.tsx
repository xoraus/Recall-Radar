import React from 'react';

export function StatsCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rr-stat-card">
      <div className="rr-stat-value">{value}</div>
      <div className="rr-stat-label">{label}</div>
      {sub && <div className="rr-stat-sub">{sub}</div>}
    </div>
  );
}
