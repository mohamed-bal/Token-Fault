/**
 * Event timeline: one tick per SSE event on a shared time axis, a lane of
 * inter-event gap bars (stalls and jitter stand out), and fault annotations.
 * Paths are batched per colour so thousands of events render as a few SVG
 * elements.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CapturedEvent, FaultAnnotation, Termination } from '@tokenfault/shared';
import { ms } from '../format';
import { eventStyle } from './kinds';

interface Props {
  events: readonly CapturedEvent[];
  annotations: readonly FaultAnnotation[];
  headersMs: number | null;
  termination: Termination | null;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
}

const HEIGHT = 118;
const PAD_X = 12;
const TICK_TOP = 16;
const TICK_BOTTOM = 44;
const GAP_LABEL_Y = 58;
const GAP_BASE = 102;
const GAP_MAX_H = 36;

export function Timeline({
  events,
  annotations,
  headersMs,
  termination,
  selectedSeq,
  onSelect,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(200, Math.floor(w)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const end = Math.max(
    termination?.atMs ?? 0,
    events.at(-1)?.atMs ?? 0,
    ...annotations.map((a) => a.atMs),
    headersMs ?? 0,
    1,
  );
  const x = (t: number): number => PAD_X + (t / end) * (width - PAD_X * 2);

  const { paths, gapPath, maxGap } = useMemo(() => {
    const byColor = new Map<string, string>();
    let gapD = '';
    let max = 0;
    for (let i = 1; i < events.length; i++)
      max = Math.max(max, events[i]!.atMs - events[i - 1]!.atMs);
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const xi = x(e.atMs).toFixed(1);
      const color = eventStyle(e).color;
      byColor.set(color, `${byColor.get(color) ?? ''}M${xi} ${TICK_TOP}V${TICK_BOTTOM}`);
      if (i > 0 && max > 0) {
        const gap = e.atMs - events[i - 1]!.atMs;
        const h = Math.max(1, (gap / max) * GAP_MAX_H);
        gapD += `M${xi} ${GAP_BASE}V${(GAP_BASE - h).toFixed(1)}`;
      }
    }
    return { paths: [...byColor.entries()], gapPath: gapD, maxGap: max };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- x depends on width/end only
  }, [events, width, end]);

  const selected = selectedSeq !== null ? events.find((e) => e.seq === selectedSeq) : undefined;

  const handleClick = (clientX: number, rect: DOMRect): void => {
    if (events.length === 0) return;
    const t = ((clientX - rect.left - PAD_X) / (width - PAD_X * 2)) * end;
    let best = events[0]!;
    for (const e of events) if (Math.abs(e.atMs - t) < Math.abs(best.atMs - t)) best = e;
    onSelect(best.seq);
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div ref={ref} className="w-full select-none">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Timeline of ${events.length} SSE events over ${ms(end)}${annotations.length > 0 ? `; ${annotations.length} injected fault${annotations.length === 1 ? '' : 's'} (amber markers)` : ''}${termination && termination.kind !== 'eof' && termination.kind !== 'replay-end' ? `; ended by ${termination.kind} at ${ms(termination.atMs)} (red line)` : ''}`}
        className="block cursor-crosshair"
        onClick={(e) => handleClick(e.clientX, e.currentTarget.getBoundingClientRect())}
      >
        <text x={PAD_X} y={11} className="fill-faint text-[10px]">
          SSE events
        </text>
        <text x={PAD_X} y={GAP_LABEL_Y} className="fill-faint text-[10px]">
          gap since previous event {maxGap > 0 ? `(max ${ms(maxGap)})` : ''}
        </text>
        {ticks.map((f) => (
          <g key={f}>
            <line
              x1={x(f * end)}
              x2={x(f * end)}
              y1={TICK_TOP - 4}
              y2={GAP_BASE}
              stroke="#262c35"
              strokeDasharray="2 3"
            />
            <text
              x={x(f * end)}
              y={HEIGHT - 2}
              textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}
              className="fill-faint font-mono text-[10px]"
            >
              {ms(f * end)}
            </text>
          </g>
        ))}
        <line x1={PAD_X} x2={width - PAD_X} y1={GAP_BASE} y2={GAP_BASE} stroke="#343b46" />
        {headersMs !== null && (
          <g>
            <title>{`response headers at ${ms(headersMs)}`}</title>
            <line
              x1={x(headersMs)}
              x2={x(headersMs)}
              y1={TICK_TOP - 6}
              y2={TICK_BOTTOM + 4}
              stroke="#8c95a3"
              strokeWidth={1.5}
            />
          </g>
        )}
        {paths.map(([color, d]) => (
          <path key={color} d={d} stroke={color} strokeWidth={1.5} fill="none" />
        ))}
        {gapPath && (
          <path d={gapPath} stroke="#7c9cff" strokeOpacity={0.55} strokeWidth={2} fill="none" />
        )}
        {selected && (
          <rect
            x={x(selected.atMs) - 3}
            y={TICK_TOP - 4}
            width={6}
            height={TICK_BOTTOM - TICK_TOP + 8}
            rx={2}
            fill="none"
            stroke="#e6e8eb"
          />
        )}
        {annotations.map((a, i) => (
          <g key={`${a.atMs}-${i}`}>
            <title>{`${a.faultType} @ ${ms(a.atMs)}: ${a.message}`}</title>
            <line
              x1={x(a.atMs)}
              x2={x(a.atMs)}
              y1={TICK_TOP - 6}
              y2={GAP_BASE}
              stroke="#fbbf24"
              strokeDasharray="3 2"
            />
            <path d={`M${x(a.atMs) - 4} 4 L${x(a.atMs) + 4} 4 L${x(a.atMs)} 11 Z`} fill="#fbbf24" />
          </g>
        ))}
        {termination && termination.kind !== 'eof' && termination.kind !== 'replay-end' && (
          <g>
            <title>{`${termination.kind} @ ${ms(termination.atMs)}${termination.detail ? `: ${termination.detail}` : ''}`}</title>
            <line
              x1={x(termination.atMs)}
              x2={x(termination.atMs)}
              y1={TICK_TOP - 6}
              y2={GAP_BASE}
              stroke="#f87171"
              strokeWidth={2}
            />
          </g>
        )}
      </svg>
      <ul
        className="flex flex-wrap gap-x-3 gap-y-0.5 px-1 pt-1 text-[10.5px] text-faint"
        aria-label="Timeline legend"
      >
        {LEGEND.map(([label, color]) => (
          <li key={label} className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-2.5 w-0.5" style={{ background: color }} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

const LEGEND: readonly (readonly [string, string])[] = [
  ['content delta', '#7c9cff'],
  ['tool-call delta', '#c084fc'],
  ['finish_reason', '#2dd4bf'],
  ['[DONE]', '#4ade80'],
  ['metadata only', '#5d6573'],
  ['unrecognised event', '#fbbf24'],
  ['invalid JSON', '#fb923c'],
  ['error event', '#f87171'],
  ['injected fault (marker)', '#fbbf24'],
  ['termination (line)', '#f87171'],
];
