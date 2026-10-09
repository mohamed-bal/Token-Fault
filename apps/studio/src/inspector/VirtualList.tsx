/**
 * Fixed-row-height windowed list with keyboard navigation (↑/↓/PageUp/PageDown/Home/End).
 * Only visible rows are rendered, so sessions with tens of thousands of events stay fast.
 * Selectable lists are ARIA listboxes: focus stays on the list and `aria-activedescendant`
 * points at the selected option, with `aria-setsize`/`aria-posinset` because rows are windowed.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

interface Props<T> {
  items: readonly T[];
  rowHeight: number;
  height: number;
  selectedIndex: number | null;
  /** Omit for a read-only list (role="list"; the keyboard scrolls instead of selecting). */
  onSelect?: ((index: number) => void) | undefined;
  renderRow: (item: T, index: number, selected: boolean) => ReactNode;
  label: string;
  /** Keep the list scrolled to the end while new items arrive (until the user scrolls up). */
  follow?: boolean;
}

export function VirtualList<T>({
  items,
  rowHeight,
  height,
  selectedIndex,
  onSelect,
  renderRow,
  label,
  follow = false,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const selectable = onSelect !== undefined;
  const optionId = (i: number): string => `${idBase}-row-${i}`;
  const [scrollTop, setScrollTop] = useState(0);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (follow && el && pinned.current && selectedIndex === null) el.scrollTop = el.scrollHeight;
  }, [items.length, follow, selectedIndex]);

  useEffect(() => {
    const el = ref.current;
    if (!el || selectedIndex === null) return;
    const top = selectedIndex * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + height) el.scrollTop = top + rowHeight - height;
  }, [selectedIndex, rowHeight, height]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const last = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + 5);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div
        key={i}
        id={optionId(i)}
        role={selectable ? 'option' : 'listitem'}
        aria-selected={selectable ? i === selectedIndex : undefined}
        aria-setsize={items.length}
        aria-posinset={i + 1}
        style={{ position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }}
        onClick={onSelect ? () => onSelect(i) : undefined}
      >
        {renderRow(items[i]!, i, i === selectedIndex)}
      </div>,
    );
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (items.length === 0 || !onSelect) return;
    const page = Math.max(1, Math.floor(height / rowHeight) - 1);
    const current = selectedIndex ?? -1;
    const next: Record<string, number> = {
      ArrowDown: Math.min(items.length - 1, current + 1),
      ArrowUp: Math.max(0, current - 1),
      PageDown: Math.min(items.length - 1, current + page),
      PageUp: Math.max(0, current - page),
      Home: 0,
      End: items.length - 1,
    };
    const target = next[e.key];
    if (target !== undefined) {
      e.preventDefault();
      onSelect(target);
    }
  };

  return (
    <div
      ref={ref}
      role={selectable ? 'listbox' : 'list'}
      aria-label={label}
      aria-activedescendant={
        selectable && selectedIndex !== null && selectedIndex >= first && selectedIndex < last
          ? optionId(selectedIndex)
          : undefined
      }
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight * 2;
      }}
      className="scroll-thin relative overflow-auto"
      style={{ height }}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}
