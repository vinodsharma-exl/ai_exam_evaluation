/**
 * Two small SVG charts for the class view, both single-series, so one colour (--series-1) and no
 * legend box (the card title names what's plotted):
 *   ColumnChart: marks distribution (students per percentage band)
 *   HBarChart:   average % per question (where the class struggled)
 * Marks follow the dataviz spec: bars ≤24px with a 4px rounded data-end and a square baseline,
 * solid hairline grid lines, selective direct labels, and a hover/focus tooltip on every bar.
 * Every chart has a table twin (ChartCard's "Table" toggle), so no value hides behind a hover.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { Card, cx } from './ui';

/** Column with a rounded top (data end) and square base. */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Horizontal bar with a rounded right end (data end) and square left base. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (w <= 0) return '';
  const r = Math.min(4, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

/** Clean integer ticks for counts: 0..max in steps of 1, 2, 5, 10… (at most ~5 ticks). */
function countTicks(max: number): number[] {
  const top = Math.max(1, max);
  const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => top / s <= 5) ?? Math.ceil(top / 5);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step - 1 && ticks.length < 7; v += step) ticks.push(v);
  return ticks;
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md dark:border-slate-700 dark:bg-slate-800"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      {tip.content}
    </div>
  );
}

export function ColumnChart({ data, valueLabel }: { data: Array<{ label: string; value: number; detail?: string }>; valueLabel: (v: number) => string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const W = 560;
  const H = 220; // includes the x-axis band, so the card never needs a nested scroll
  const pad = { l: 30, r: 8, t: 18, b: 40 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const max = Math.max(...data.map((d) => d.value), 0);
  const ticks = countTicks(max);
  const top = ticks[ticks.length - 1]!;
  const band = plotW / data.length;
  const barW = Math.min(24, band - 2);
  const peak = data.findIndex((d) => d.value === max && max > 0);
  const y = (v: number) => pad.t + plotH - (v / top) * plotH;

  return (
    <div className="viz relative" onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Marks distribution: number of students in each percentage band">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx0 = pad.l + band * i + band / 2;
          const h = plotH - (y(d.value) - pad.t);
          const show = (el: SVGGElement) => {
            const box = el.ownerSVGElement!.getBoundingClientRect();
            const scale = box.width / W;
            setTip({ x: cx0 * scale, y: y(d.value) * scale, content: <><strong>{d.label}</strong>: {valueLabel(d.value)}{d.detail && <div className="text-slate-500">{d.detail}</div>}</> });
          };
          return (
            <g key={d.label} tabIndex={0} role="listitem" aria-label={`${d.label}: ${valueLabel(d.value)}`} className="outline-none focus-visible:[&>rect]:fill-slate-200/40" onMouseEnter={(e) => show(e.currentTarget)} onFocus={(e) => show(e.currentTarget)} onBlur={() => setTip(null)}>
              {/* Hit target: the whole band, taller than the bar. */}
              <rect x={pad.l + band * i} y={pad.t} width={band} height={plotH} fill="transparent" />
              <path d={columnPath(cx0 - barW / 2, y(d.value), barW, h)} fill="var(--series-1)" />
              {i === peak && (
                <text x={cx0} y={y(d.value) - 5} textAnchor="middle" className="fill-slate-700 text-[11px] font-semibold dark:fill-slate-200">{d.value}</text>
              )}
              <text x={cx0} y={H - pad.b + 14} textAnchor="middle" className="fill-slate-500 text-[9.5px]">{d.label.replace('%', '')}</text>
            </g>
          );
        })}
        <text x={pad.l + plotW / 2} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[10px]">Percentage of total marks</text>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export function HBarChart({ data }: { data: Array<{ label: string; percent: number | null; detail: string }> }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const rows = data.filter((d) => d.percent !== null) as Array<{ label: string; percent: number; detail: string }>;
  const rowH = 26;
  const pad = { l: 52, r: 44, t: 8, b: 26 };
  const W = 560;
  const H = pad.t + rows.length * rowH + pad.b;
  const plotW = W - pad.l - pad.r;
  const x = (p: number) => pad.l + (p / 100) * plotW;
  // Label only the extremes: where the class did best and where it struggled.
  const { lo, hi } = useMemo(() => {
    if (rows.length < 2) return { lo: -1, hi: -1 };
    let lo = 0;
    let hi = 0;
    rows.forEach((r, i) => {
      if (r.percent < rows[lo]!.percent) lo = i;
      if (r.percent > rows[hi]!.percent) hi = i;
    });
    return { lo, hi };
  }, [rows]);

  if (rows.length === 0) return <p className="py-6 text-center text-sm text-slate-500">No graded answers yet.</p>;
  return (
    <div className="viz relative" onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Average score per question, as a percentage of its max marks">
        {[0, 25, 50, 75, 100].map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={pad.t} y2={H - pad.b} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
            <text x={x(t)} y={H - pad.b + 14} textAnchor="middle" className="fill-slate-500 text-[10px] tabular-nums">{t}%</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const yy = pad.t + i * rowH;
          const barH = 14;
          const show = (el: SVGGElement) => {
            const box = el.ownerSVGElement!.getBoundingClientRect();
            const scale = box.width / W;
            setTip({ x: x(r.percent) * scale, y: (yy + 4) * scale, content: <><strong>Q{r.label}</strong>: {Math.round(r.percent)}% average<div className="text-slate-500">{r.detail}</div></> });
          };
          return (
            <g key={r.label} tabIndex={0} role="listitem" aria-label={`Question ${r.label}: ${Math.round(r.percent)} percent average. ${r.detail}`} className="outline-none" onMouseEnter={(e) => show(e.currentTarget)} onFocus={(e) => show(e.currentTarget)} onBlur={() => setTip(null)}>
              <rect x={0} y={yy} width={W} height={rowH} fill="transparent" />
              <text x={pad.l - 8} y={yy + rowH / 2} dy="0.32em" textAnchor="end" className="fill-slate-600 text-[11px] dark:fill-slate-300">Q{r.label}</text>
              <path d={barPath(pad.l, yy + (rowH - barH) / 2, x(r.percent) - pad.l, barH)} fill="var(--series-1)" />
              {(i === lo || i === hi) && (
                <text x={x(r.percent) + 6} y={yy + rowH / 2} dy="0.32em" className="fill-slate-700 text-[11px] font-semibold dark:fill-slate-200">{Math.round(r.percent)}%</text>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Card with a Chart/Table toggle: the table is the accessible twin of the chart. */
export function ChartCard({ title, subtitle, chart, table, actions }: { title: string; subtitle?: string; chart: ReactNode; table: ReactNode; actions?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card
      title={
        <span>
          {title}
          {subtitle && <span className="ml-2 text-xs font-normal text-slate-500">{subtitle}</span>}
        </span>
      }
      actions={
        <>
          {actions}
          <div className="inline-flex rounded-md border border-slate-200 p-0.5 dark:border-slate-700" role="group" aria-label="View">
            {[
              { v: false, icon: <BarChart3 className="h-3.5 w-3.5" />, label: 'Chart' },
              { v: true, icon: <Table2 className="h-3.5 w-3.5" />, label: 'Table' },
            ].map((o) => (
              <button key={o.label} type="button" aria-pressed={asTable === o.v} onClick={() => setAsTable(o.v)} className={cx('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs', asTable === o.v ? 'bg-slate-100 font-medium dark:bg-slate-800' : 'text-slate-500')}>
                {o.icon}
                {o.label}
              </button>
            ))}
          </div>
        </>
      }
    >
      {asTable ? table : chart}
    </Card>
  );
}
