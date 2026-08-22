import { useState } from 'react';
import { LINE_CAPS, STROKE_COLORS, type AnnotationStyle, type AnnotationTool, type LineCap } from './types';
import { TOOL_HOTKEYS } from './useAnnotationKeyboard';
import styles from './AnnotationToolbar.module.css';

/** The letter that reaches each tool, derived from the keymap rather than
 *  written out again - a hint that can drift from the binding is worse than
 *  no hint. */
const HOTKEY_FOR = Object.fromEntries(
  Object.entries(TOOL_HOTKEYS).map(([key, tool]) => [tool, key.toUpperCase()]),
) as Record<AnnotationTool, string>;

const TOOLS: { key: AnnotationTool; label: string; icon: string }[] = [
  { key: 'select', label: 'Select', icon: '↖' },
  { key: 'line', label: 'Line', icon: '╱' },
  { key: 'curve', label: 'Curve (click points, double-click to finish)', icon: '〰' },
  { key: 'freehand', label: 'Freehand', icon: '✎' },
  { key: 'arrow', label: 'Arrow', icon: '➜' },
  { key: 'rectangle', label: 'Rectangle', icon: '▭' },
  { key: 'circle', label: 'Circle / Ellipse', icon: '◯' },
  { key: 'text', label: 'Text label', icon: 'T' },
];

interface AnnotationToolbarProps {
  tool: AnnotationTool;
  onToolChange: (tool: AnnotationTool) => void;
  style: AnnotationStyle;
  onStyleChange: (style: AnnotationStyle) => void;
  showFillOpacity: boolean;
  /** Start/end cap pickers only apply to lines and arrows. */
  showLineCaps: boolean;
  /** Bold toggle only applies to text labels. */
  showTextWeight: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteSelected: () => void;
  hasSelection: boolean;
}

export function AnnotationToolbar({
  tool,
  onToolChange,
  style,
  onStyleChange,
  showFillOpacity,
  showLineCaps,
  showTextWeight,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDeleteSelected,
  hasSelection,
}: AnnotationToolbarProps) {
  /* THE STYLE CONTROLS FOLD ON A PHONE, and only on a phone.
     Colour, width, dotted, fill and end caps were five wrapped rows at 375px -
     168px of a screen whose whole point is the image. They are not removed and
     nothing is unreachable; they are one tap away behind a control that shows
     the current colour, so a coach can see what they are drawing with without
     opening anything. On a desktop the media query below ignores this
     entirely and every control stays laid out as it was. */
  const [styleOpen, setStyleOpen] = useState(false);

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolGroup}>
        {/* aria-keyshortcuts rather than appending the key to `title`: a
            label is a name, not a place to stash a keybinding - and the
            visible badge below is what actually teaches it. */}
        {TOOLS.map((t) => (
          <button
            key={t.key}
            title={t.label}
            aria-keyshortcuts={HOTKEY_FOR[t.key]}
            className={`${styles.toolButton} ${tool === t.key ? styles.toolButtonActive : ''}`}
            onClick={() => onToolChange(t.key)}
          >
            {t.icon}
            {/* The shortcut teaches itself from the control it belongs to,
                rather than from a help panel nobody opens. Hidden where there
                is no keyboard - see the stylesheet. */}
            <span className={styles.hotkey} aria-hidden="true">
              {HOTKEY_FOR[t.key]}
            </span>
          </button>
        ))}
      </div>

      <div className={styles.divider} />

      <button
        type="button"
        className={styles.styleToggle}
        onClick={() => setStyleOpen((open) => !open)}
        aria-expanded={styleOpen}
      >
        <span
          className={styles.styleToggleSwatch}
          style={{ background: style.color }}
          aria-hidden="true"
        />
        Style
      </button>

      <div className={`${styles.styleGroup} ${styleOpen ? styles.styleGroupOpen : ''}`}>
        <div className={styles.swatches}>
          {STROKE_COLORS.map((color) => (
            <button
              key={color}
              title={color}
              className={`${styles.swatch} ${style.color === color ? styles.swatchActive : ''}`}
              style={{ background: color, boxShadow: color === '#ffffff' ? 'inset 0 0 0 1px #ccc' : undefined }}
              onClick={() => onStyleChange({ ...style, color })}
            />
          ))}
        </div>

        <label className={styles.sliderLabel}>
          Width
          <input
            type="range"
            min={1}
            max={12}
            value={style.strokeWidth}
            onChange={(e) => onStyleChange({ ...style, strokeWidth: Number(e.target.value) })}
          />
        </label>

        <label className={styles.sliderLabel}>
          <input
            type="checkbox"
            checked={style.dashed}
            onChange={(e) => onStyleChange({ ...style, dashed: e.target.checked })}
          />
          Dotted
        </label>

        {showFillOpacity && (
          <label className={styles.sliderLabel}>
            Fill opacity
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.fillOpacity}
              onChange={(e) => onStyleChange({ ...style, fillOpacity: Number(e.target.value) })}
            />
          </label>
        )}

        {showTextWeight && (
          <label className={styles.sliderLabel}>
            <input
              type="checkbox"
              checked={style.bold}
              onChange={(e) => onStyleChange({ ...style, bold: e.target.checked })}
            />
            Bold
          </label>
        )}

        {showLineCaps && (
          <>
            <label className={styles.sliderLabel}>
              Start
              <select
                value={style.startCap}
                onChange={(e) => onStyleChange({ ...style, startCap: e.target.value as LineCap })}
              >
                {LINE_CAPS.map((cap) => (
                  <option key={cap.value} value={cap.value}>
                    {cap.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.sliderLabel}>
              End
              <select
                value={style.endCap}
                onChange={(e) => onStyleChange({ ...style, endCap: e.target.value as LineCap })}
              >
                {LINE_CAPS.map((cap) => (
                  <option key={cap.value} value={cap.value}>
                    {cap.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      <div className={styles.spacer} />

      <div className={styles.toolGroup}>
        <button className={styles.toolButton} title="Undo" onClick={onUndo} disabled={!canUndo}>
          ↺
        </button>
        <button className={styles.toolButton} title="Redo" onClick={onRedo} disabled={!canRedo}>
          ↻
        </button>
        <button
          className={styles.toolButton}
          title="Delete selected"
          onClick={onDeleteSelected}
          disabled={!hasSelection}
        >
          🗑
        </button>
      </div>
    </div>
  );
}
