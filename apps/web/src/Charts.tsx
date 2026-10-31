/**
 * The dashboard's two charts, drawn as plain SVG in the theme's colours: what everything's worth over time (a running
 * total by the month things came in), and what it's worth by category (a donut). No chart library: FlyonUI's charts
 * use ApexCharts, which writes inline style attributes that Ferret's CSP doesn't allow — and it's ~130 KB.
 * Each has a screen-reader table of the same numbers.
 */
import { useState } from "react";

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;
const monthName = (month: string, withYear = true) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, withYear ? { month: "short", year: "numeric" } : { month: "short" });

function monthsBack(n: number) {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** A running total over the last two years (or since the first thing came in, if sooner — at least six months). */
export function WorthOverTime({ byMonth }: { byMonth: { month: string; valueCents: number }[] }) {
  const first = byMonth[0]?.month;
  const span = first ? Math.min(24, Math.max(6, monthsBetween(first) + 1)) : 6;
  const months = monthsBack(span);
  let running = byMonth.filter((m) => m.month < months[0]!).reduce((n, m) => n + m.valueCents, 0);
  const points = months.map((month) => {
    running += byMonth.find((m) => m.month === month)?.valueCents ?? 0;
    return { month, valueCents: running };
  });
  const max = Math.max(...points.map((p) => p.valueCents), 1);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 160;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - (v / max) * (H - 8);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.valueCents).toFixed(1)}`).join(" ");
  const yearAgo = points[Math.max(0, points.length - 13)]!.valueCents;
  const now = points[points.length - 1]!.valueCents;
  const shown = hover ?? points.length - 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-base-content/70">
          <span className="font-medium text-base-content">{monthName(points[shown]!.month)}</span>: {money(points[shown]!.valueCents)}
        </p>
        {points.length > 12 && now > yearAgo && <p className="text-sm text-success">+{money(now - yearAgo)} in a year</p>}
      </div>
      <div
        className="relative"
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(Math.round(((e.clientX - box.left) / box.width) * (points.length - 1)));
        }}
        onPointerLeave={() => setHover(null)}
        aria-hidden
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full overflow-visible text-primary">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="text-base-content/10" stroke="currentColor" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={`${line} L${W},${H} L0,${H} Z`} fill="currentColor" opacity="0.15" />
          <path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>
      <div className="flex justify-between text-xs text-base-content/70" aria-hidden>
        <span>{monthName(points[0]!.month)}</span>
        <span>{monthName(points[Math.floor(points.length / 2)]!.month)}</span>
        <span>Now</span>
      </div>
      <table className="sr-only">
        <caption>Worth at the end of each month</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.month}>
              <th scope="row">{monthName(p.month)}</th>
              <td>{money(p.valueCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function monthsBetween(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date();
  return (d.getFullYear() - y) * 12 + (d.getMonth() + 1 - m);
}

// Theme colours, in order; the last (neutral) is for "everything else".
const SLICE_COLOURS = ["text-primary", "text-info", "text-success", "text-warning", "text-secondary", "text-accent", "text-error"];

/** A donut of value by category: the biggest six, the rest together; a legend with amounts beside it. */
export function CategoryDonut({ groups, href }: { groups: { name: string; valueCents: number; items: number }[]; href?: (name: string) => string | undefined }) {
  const valued = groups.filter((g) => g.valueCents > 0);
  const top = valued.slice(0, 6);
  const rest = valued.slice(6).reduce((n, g) => n + g.valueCents, 0);
  const slices = [...top.map((g, i) => ({ ...g, colour: SLICE_COLOURS[i]! })), ...(rest ? [{ name: "Everything else", valueCents: rest, items: 0, colour: "text-base-content/30" }] : [])];
  const total = slices.reduce((n, s) => n + s.valueCents, 0) || 1;
  const [hover, setHover] = useState<string | null>(null);
  const R = 15.9155; // circumference 100, so dash lengths are percentages
  let offset = 25; // start at 12 o'clock

  return (
    <div className="flex flex-col items-center gap-5 @container sm:flex-row sm:items-center">
      <div className="relative size-40 shrink-0" aria-hidden>
        <svg viewBox="0 0 42 42" className="size-full -rotate-0">
          <circle cx="21" cy="21" r={R} fill="none" stroke="currentColor" strokeWidth="6" className="text-base-content/10" />
          {slices.map((s) => {
            const pct = (s.valueCents / total) * 100;
            const el = (
              <circle
                key={s.name}
                cx="21"
                cy="21"
                r={R}
                fill="none"
                stroke="currentColor"
                strokeWidth={hover === s.name ? 7.5 : 6}
                strokeDasharray={`${Math.max(0, pct - 0.6)} ${100 - Math.max(0, pct - 0.6)}`}
                strokeDashoffset={offset}
                className={`${s.colour} transition-[stroke-width] motion-reduce:transition-none`}
              />
            );
            offset -= pct;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xs text-base-content/70">{hover ?? "Total"}</span>
          <span className="font-semibold text-base-content">{money(hover ? slices.find((s) => s.name === hover)!.valueCents : total)}</span>
        </div>
      </div>
      <ul className="flex w-full min-w-0 flex-col gap-2">
        {slices.map((s) => {
          const link = s.name !== "Everything else" ? href?.(s.name) : undefined;
          const body = (
            <>
              <span className={`size-3 shrink-0 rounded-full bg-current ${s.colour}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-base-content">{s.name}</span>
              <span className="shrink-0 text-base-content/70">{Math.round((s.valueCents / total) * 100)}%</span>
              <span className="w-20 shrink-0 text-end font-medium text-base-content">{money(s.valueCents)}</span>
            </>
          );
          return (
            <li key={s.name} onPointerEnter={() => setHover(s.name)} onPointerLeave={() => setHover(null)}>
              {link ? (
                <a href={link} className="tap flex items-center gap-2 text-sm hover:[&>span:nth-child(2)]:text-primary">
                  {body}
                </a>
              ) : (
                <span className="flex items-center gap-2 text-sm">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
