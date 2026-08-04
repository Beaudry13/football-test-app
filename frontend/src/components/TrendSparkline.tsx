import type { PlayerTrend } from '../api/types';
import { trendArrow, trendLabel } from '../utils/playerAnalyticsDisplay';
import styles from './TrendSparkline.module.css';

const WIDTH = 240;
const HEIGHT = 56;
const PAD = 6;

/** A simple, dependency-free score-over-time line - the project has no
 * charting library, and this is all Part 1's "simple accessible line chart
 * or score list with directional indicator" needs. Renders nothing
 * meaningful (an explicit empty state) when trend.available is false;
 * callers should check that first, this only draws the line itself plus
 * the direction label pairing so meaning never depends on color alone. */
export function TrendSparkline({ trend }: { trend: PlayerTrend }) {
  if (!trend.available || trend.points.length < 2) {
    return null;
  }

  const scores = trend.points.map((p) => p.score_percent);
  const min = Math.min(...scores, 0);
  const max = Math.max(...scores, 100);
  const range = max - min || 1;

  const coords = trend.points.map((p, i) => {
    const x = PAD + (i / (trend.points.length - 1)) * (WIDTH - PAD * 2);
    const y = HEIGHT - PAD - ((p.score_percent - min) / range) * (HEIGHT - PAD * 2);
    return { x, y };
  });
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');

  const summary = `Score trend across ${trend.points.length} completed quizzes: ${trendLabel(trend.direction)}, from ${trend.points[0].score_percent}% to ${trend.points[trend.points.length - 1].score_percent}%.`;

  return (
    <div className={styles.wrapper}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={summary}
      >
        <path d={linePath} className={styles.line} fill="none" />
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={2.5} className={styles.dot} />
        ))}
      </svg>
      <span className={`${styles.directionLabel} ${styles[trend.direction ?? 'flat']}`}>
        {trendArrow(trend.direction)} {trendLabel(trend.direction)}
      </span>
    </div>
  );
}
