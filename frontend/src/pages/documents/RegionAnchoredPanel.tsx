import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { placeBesideRegion, type Placement } from './placeBesideRegion';
import type { NormalisedRect } from './RegionDraw';
import styles from './RegionAnchoredPanel.module.css';

/** Floats a panel next to the region it belongs to.
 *
 * The panel is a SIBLING of the drawing surface, absolutely positioned in the
 * page box - never a child of it. RegionDraw measures pointers against its own
 * bounding box, so anything inside it that took part in layout would change
 * the number every gesture divides by. Out of flow, it cannot.
 *
 * DEGRADES TO NORMAL FLOW. Without ResizeObserver (jsdom, and any browser old
 * enough to lack it) the panel renders in the ordinary document flow rather
 * than nowhere: an un-positioned form a coach can still type into beats a
 * correctly-positioned form that never appeared.
 */
export function RegionAnchoredPanel({
  region,
  children,
  label,
}: {
  /** The region, in normalised 0-1 page coordinates. READ ONLY - this
   *  component never reports a region back to anyone. */
  region: NormalisedRect;
  children: ReactNode;
  label: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const reposition = useCallback(() => {
    const panel = panelRef.current;
    const page = panel?.offsetParent as HTMLElement | null;
    if (!panel || !page) return;

    const pageSize = { width: page.clientWidth, height: page.clientHeight };
    if (pageSize.width === 0 || pageSize.height === 0) return;

    // The normalised rect becomes pixels HERE and nowhere else, and only ever
    // in this direction. Nothing converts back.
    const box = {
      x: region.x * pageSize.width,
      y: region.y * pageSize.height,
      width: region.width * pageSize.width,
      height: region.height * pageSize.height,
    };
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    setPlacement(placeBesideRegion(box, size, pageSize));
  }, [region]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const panel = panelRef.current;
    const page = panel?.offsetParent as HTMLElement | null;
    if (!panel || !page) return;

    // Both boxes matter: the page changes when the window resizes, and the
    // panel changes when the answer field wraps onto a second line.
    const observer = new ResizeObserver(() => reposition());
    observer.observe(page);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [reposition]);

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="group"
      aria-label={label}
      data-side={placement?.side}
      style={
        placement
          ? { position: 'absolute', left: placement.left, top: placement.top }
          : undefined
      }
    >
      {children}
    </div>
  );
}
