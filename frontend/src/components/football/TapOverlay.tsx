import { Fragment, useRef, type CSSProperties, type PointerEvent } from 'react';
import { placeRows, ROW_LIFT, type TapTarget } from './tapTargets';
import styles from './TapOverlay.module.css';

export interface TapOption {
  id: number;
  option_text: string;
}

/**
 * THE ANSWERS, IN THE PICTURE: a ring on each man, a labelled spot on each
 * place - laid over a play picture. The same layer for the player (tap to
 * answer) and for the coach checking it (`onMove`: drag a place to where he
 * means it - a man stays on the man). Close places share one row in field
 * order with a dot on each true spot (tapTargets.placeRows).
 */
export function TapOverlay({
  targets,
  options,
  onTap,
  chosen,
  tone,
  disabled,
  onMove,
}: {
  targets: TapTarget[];
  options: TapOption[];
  onTap?: (optionId: number) => void;
  chosen?: number[];
  tone?: 'right' | 'wrong' | null;
  disabled?: boolean;
  /** The coach's check: places can be dragged; `at` is in picture fractions. */
  onMove?: (index: number, at: { x: number; y: number }) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ index: number; id: number } | null>(null);

  const grab = (index: number) =>
    onMove
      ? {
          onPointerDown: (e: PointerEvent<HTMLElement>) => {
            e.preventDefault();
            dragging.current = { index, id: e.pointerId };
            e.currentTarget.setPointerCapture?.(e.pointerId);
          },
          onPointerMove: (e: PointerEvent<HTMLElement>) => {
            const box = surface.current?.getBoundingClientRect();
            if (!dragging.current || dragging.current.index !== index || !box?.width || !box.height) return;
            const clamp = (v: number) => Math.min(0.98, Math.max(0.02, v));
            onMove(index, {
              x: clamp((e.clientX - box.left) / box.width),
              y: clamp((e.clientY - box.top) / box.height),
            });
          },
          onPointerUp: () => {
            dragging.current = null;
          },
        }
      : {};

  const button = (i: number, style?: CSSProperties) => {
    const option = options[i];
    const on = chosen?.includes(option.id);
    // In a shared row everything is a labelled button (the dot marks the man or the spot).
    const zone = !!targets[i].zone || !style;
    // A man's ring stays on the man; only a place moves - by its own pill when
    // it stands alone, by its dot when it shares a row.
    const movable = !!onMove && zone && !!style;
    return (
      <button
        key={option.id}
        type="button"
        className={[
          zone ? styles.zone : styles.target,
          on ? styles.on : '',
          on && tone === 'right' ? styles.right : '',
          on && tone === 'wrong' ? styles.wrong : '',
          movable ? styles.movable : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={style}
        aria-label={movable ? `Move ${option.option_text}` : `Tap ${option.option_text}`}
        disabled={disabled && !movable}
        onClick={onTap && !movable ? () => onTap(option.id) : undefined}
        {...(movable ? grab(i) : {})}
      >
        {zone ? option.option_text : null}
      </button>
    );
  };

  return (
    <div ref={surface} className={styles.surface} data-tap-surface>
      {placeRows(targets).map((row) =>
        row.length === 1 ? (
          button(row[0], { left: `${targets[row[0]].x * 100}%`, top: `${targets[row[0]].y * 100}%` })
        ) : (
          <Fragment key={row.join('-')}>
            {row.map((i) => {
              // A place's dot can be dragged; a man's dot stays on the man.
              const movable = !!onMove && !!targets[i].zone;
              return (
                <span
                  key={`dot-${i}`}
                  className={movable ? `${styles.dot} ${styles.dotMovable}` : styles.dot}
                  style={{ left: `${targets[i].x * 100}%`, top: `${targets[i].y * 100}%` }}
                  aria-hidden={movable ? undefined : true}
                  role={movable ? 'button' : undefined}
                  aria-label={movable ? `Move ${options[i].option_text}` : undefined}
                  {...(movable ? grab(i) : {})}
                />
              );
            })}
            <div
              className={styles.row}
              style={{
                left: `${(row.reduce((n, i) => n + targets[i].x, 0) / row.length) * 100}%`,
                top: `${(targets[row[0]].y - ROW_LIFT) * 100}%`,
              }}
            >
              {row.map((i) => button(i))}
            </div>
          </Fragment>
        ),
      )}
    </div>
  );
}
