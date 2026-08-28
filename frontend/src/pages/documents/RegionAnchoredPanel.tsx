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
  /** The boxes the current placement was computed from. Re-measuring is
   *  cheap; re-POSITIONING from an unchanged measurement is what would loop. */
  const measured = useRef({ panelW: 0, panelH: 0, pageW: 0, pageH: 0 });

  const reposition = useCallback(() => {
    const panel = panelRef.current;
    const page = panel?.offsetParent as HTMLElement | null;
    if (!panel || !page) return;

    const pageW = page.clientWidth;
    const pageH = page.clientHeight;
    const panelW = panel.offsetWidth;
    const panelH = panel.offsetHeight;
    // A zero on any side means the browser has not laid this out yet.
    // Positioning against it would produce a confidently wrong answer.
    if (pageW === 0 || pageH === 0 || panelW === 0 || panelH === 0) return;

    const last = measured.current;
    if (
      last.panelW === panelW &&
      last.panelH === panelH &&
      last.pageW === pageW &&
      last.pageH === pageH
    ) {
      return;
    }
    measured.current = { panelW, panelH, pageW, pageH };

    // The normalised rect becomes pixels HERE and nowhere else, and only ever
    // in this direction. Nothing converts back.
    const box = {
      x: region.x * pageW,
      y: region.y * pageH,
      width: region.width * pageW,
      height: region.height * pageH,
    };
    setPlacement(placeBesideRegion(box, { width: panelW, height: panelH }, {
      width: pageW,
      height: pageH,
    }));
  }, [region]);

  /* ORDER MATTERS: this clears the cache BEFORE the effect below reads it.
     A new region is a new placement problem, and the panel does not remount
     between drafts - so without this, a second mask the same size as the
     first would keep the first one's position. */
  useLayoutEffect(() => {
    measured.current = { panelW: 0, panelH: 0, pageW: 0, pageH: 0 };
  }, [region]);

  /** AFTER EVERY RENDER, not just the first.
   *
   * The first measurement happens before the panel has been through a full
   * layout, and can read a height the finished panel never has - which put
   * the form 231px past the bottom of the page in testing, because the clamp
   * had been handed a 15px panel. Re-measuring on every render lets the very
   * next one correct it, and the early return above means an unchanged
   * measurement costs a comparison and stops.
   *
   * Deliberately NOT dependent on ResizeObserver for this: RO callbacks are
   * delivered on the rendering lifecycle, so a tab that is not producing
   * frames never gets them. Layout effects still run. */
  useLayoutEffect(() => {
    reposition();
  });

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
