import { formatBytes } from '../../components/drawing/renderScale';
import type { BoardTelemetry } from '../../components/drawing/DrawingBoard';
import styles from './DrawingHud.module.css';

/** On-screen instrumentation for the real-device gate.
 *
 * Lives under pages/spike/, NOT under components/drawing/, so the engine
 * carries no HUD code into production. The board exposes telemetry through a
 * render prop; this is the only thing that consumes it.
 *
 * It exists because the gate happens on a phone connected to nothing. Safari
 * on iOS can be inspected from a Mac, and Android from chrome://inspect, but
 * requiring either turns a five-minute field test into a tethered debugging
 * session - and the interesting failures (thermal throttling, memory
 * pressure, a real thumb) do not reproduce on a tethered device sitting
 * still on a desk.
 */

interface DrawingHudProps {
  telemetry: BoardTelemetry;
  /** Tester-controlled tally. The automatic heuristic cannot see the screen;
   * a human can. */
  manualStrays: number;
  onTallyStray(): void;
  onResetTally(): void;
  graceMs: number;
  onGraceChange(value: number): void;
  saveState: string;
}

export function DrawingHud({
  telemetry,
  manualStrays,
  onTallyStray,
  onResetTally,
  graceMs,
  onGraceChange,
  saveState,
}: DrawingHudProps) {
  const { render } = telemetry;
  const fpsClass = telemetry.fps >= 40 ? styles.ok : styles.bad;
  const strayClass = manualStrays === 0 && telemetry.suspectedStrays === 0 ? styles.ok : styles.bad;

  return (
    <div className={styles.hud}>
      <div className={styles.row}>
        <Metric label="FPS" value={String(telemetry.fps)} className={fpsClass} />
        <Metric label="Gesture" value={telemetry.gesture} />
        <Metric label="Pointers" value={String(telemetry.pointerCount)} />
        <Metric label="Zoom" value={`${telemetry.zoom.toFixed(2)}x`} />
      </div>

      <div className={styles.row}>
        <Metric label="Strays (seen)" value={String(manualStrays)} className={strayClass} />
        <Metric label="Strays (suspected)" value={String(telemetry.suspectedStrays)} className={strayClass} />
        <Metric label="Prevented" value={String(telemetry.preventedStrays)} />
        <Metric label="Strokes" value={String(telemetry.strokeCount)} />
      </div>

      <div className={styles.row}>
        <Metric label="Render scale" value={`${render.scale.toFixed(2)}x`} />
        <Metric
          label="Backing store"
          value={`${render.backingWidth}x${render.backingHeight}`}
          className={render.cappedByMemory ? styles.warn : undefined}
        />
        <Metric label="Canvas memory" value={formatBytes(render.estimatedBytes)} />
        <Metric label="DPR" value={String(window.devicePixelRatio)} />
      </div>

      <div className={styles.row}>
        <Metric label="Viewport" value={`${telemetry.viewport.width}x${telemetry.viewport.height}`} />
        <Metric label="Orientation" value={telemetry.orientation} />
        <Metric label="Save" value={saveState} />
      </div>

      <div className={styles.controls}>
        <label className={styles.slider}>
          Grace {graceMs}ms
          <input
            type="range"
            min={0}
            max={140}
            step={10}
            value={graceMs}
            onChange={(event) => onGraceChange(Number(event.target.value))}
          />
        </label>
        <button type="button" className={styles.tallyButton} onClick={onTallyStray}>
          I saw a stray
        </button>
        <button type="button" className={styles.resetButton} onClick={onResetTally}>
          Reset counts
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={styles.metric}>
      <span className={styles.label}>{label}</span>
      <span className={className ? `${styles.value} ${className}` : styles.value}>{value}</span>
    </div>
  );
}
