import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import styles from '../../styles/notebook.module.css';

/** Page shell for the dark Peira coach theme: gold gradient background and
 * a mouse-tracked spotlight glow + masked line-art texture overlay.
 * Extracted from DashboardPage.tsx's original inline implementation so
 * every reskinned page shares one copy of this logic instead of
 * re-declaring it. */
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
          background: `radial-gradient(700px 500px at ${mouse.x}% ${mouse.y}%, rgba(201,162,75,0.1), transparent 70%)`,
        }}
      />
      <div
        className={styles.dotGrid}
        style={{
          maskImage: `radial-gradient(ellipse 900px 600px at ${mouse.x}% ${mouse.y}%, black, transparent 75%)`,
          WebkitMaskImage: `radial-gradient(ellipse 900px 600px at ${mouse.x}% ${mouse.y}%, black, transparent 75%)`,
        }}
      />

      {children}
    </div>
  );
}
