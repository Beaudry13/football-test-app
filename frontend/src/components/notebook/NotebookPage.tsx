import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import styles from '../../styles/notebook.module.css';

/** Page shell for the notebook-themed redesign: ruled-paper background,
 * red margin line, hole-punch dots, and a mouse-tracked spotlight glow +
 * masked dot-grid overlay. Extracted from DashboardPage.tsx's original
 * inline implementation so every reskinned page shares one copy of this
 * logic instead of re-declaring it. */
export function NotebookPage({ children }: { children: ReactNode }) {
  const [mouse, setMouse] = useState({ x: 50, y: 20 });

  function handleMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setMouse({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    });
  }

  return (
    <div className={styles.page} onMouseMove={handleMouseMove}>
      <div
        className={styles.spotlight}
        style={{
          background: `radial-gradient(600px 400px at ${mouse.x}% ${mouse.y}%, rgba(79,70,229,0.07), transparent 70%)`,
        }}
      />
      <div
        className={styles.dotGrid}
        style={{
          maskImage: `radial-gradient(ellipse 800px 500px at ${mouse.x}% ${mouse.y}%, black, transparent 70%)`,
          WebkitMaskImage: `radial-gradient(ellipse 800px 500px at ${mouse.x}% ${mouse.y}%, black, transparent 70%)`,
        }}
      />
      <div className={styles.holePunch} style={{ top: 42 }} />
      <div className={styles.holePunch} style={{ top: '50%' }} />
      <div className={styles.holePunch} style={{ top: '88%' }} />

      {children}
    </div>
  );
}
