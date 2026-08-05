import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { GroupStat } from '../lib/analytics';

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function AccuracyOverTimeChart({
  data,
}: {
  data: { date: number; accuracy: number; mistakes: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data.map((d) => ({ ...d, label: fmtDate(d.date) }))}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={32} />
        <Tooltip />
        <Line type="monotone" dataKey="accuracy" stroke="#4f8cff" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function MistakesOverTimeChart({ data }: { data: { date: number; mistakes: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data.map((d) => ({ ...d, label: fmtDate(d.date) }))}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} width={32} />
        <Tooltip />
        <Bar dataKey="mistakes" fill="#ff6b6b" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function GroupBarChart({ data }: { data: GroupStat[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ left: 12 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis type="number" tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} />
        <Tooltip />
        <Bar dataKey="averageWeakness" fill="#f6a623" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DifficultyDistributionChart({
  data,
}: {
  data: { label: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} width={32} />
        <Tooltip />
        <Bar dataKey="count" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Simple GitHub-style review-activity heatmap without extra chart deps. */
export function ReviewHeatmap({ data }: { data: { date: number; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="rr-heatmap">
      {data.map((d) => {
        const intensity = d.count === 0 ? 0 : Math.min(4, Math.ceil((d.count / max) * 4));
        return (
          <div
            key={d.date}
            className={`rr-heatmap-cell rr-heat-${intensity}`}
            title={`${new Date(d.date).toLocaleDateString()}: ${d.count} reviews`}
          />
        );
      })}
    </div>
  );
}
