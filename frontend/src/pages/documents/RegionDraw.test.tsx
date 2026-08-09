import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RegionDraw } from './RegionDraw';

/** jsdom gives every element a zero-sized bounding box, so the surface has to
 *  be told a size before any fraction can be computed from a pointer. */
function withSize(width = 1000, height = 800) {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect);
}

function drag(element: Element, from: [number, number], to: [number, number]) {
  const opts = { bubbles: true, button: 0, pointerId: 1 };
  element.dispatchEvent(
    new PointerEvent('pointerdown', { ...opts, clientX: from[0], clientY: from[1] }),
  );
  element.dispatchEvent(
    new PointerEvent('pointermove', { ...opts, clientX: to[0], clientY: to[1] }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: to[0], clientY: to[1] }));
}

/** Fractions come out of subtraction (0.3 - 0.2 is 0.09999999999999998), so
 *  they are compared numerically rather than for exact equality. The precision
 *  that matters is "the same on any screen", not the 17th decimal place. */
function expectRect(
  onDrawn: ReturnType<typeof vi.fn>,
  expected: { x: number; y: number; width: number; height: number },
) {
  expect(onDrawn).toHaveBeenCalledTimes(1);
  const actual = onDrawn.mock.calls[0][0];
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(actual[key]).toBeCloseTo(expected[key], 6);
  }
}

function setup(props: Partial<React.ComponentProps<typeof RegionDraw>> = {}) {
  const onDrawn = vi.fn();
  const onClick = vi.fn();
  const onSelect = vi.fn();
  const onRegionChanged = vi.fn();
  const { container } = render(
    // Every required prop is supplied here, BEFORE the spread, so a caller can
    // still override any of them. These became required when RegionDraw grew
    // tap-to-select and region editing; without them the click path called an
    // undefined onSelect, which the tests only survived because the throw
    // happened inside a dispatched event handler.
    <RegionDraw
      existing={[]}
      selectedId={null}
      onDrawn={onDrawn}
      onClick={onClick}
      onSelect={onSelect}
      onRegionChanged={onRegionChanged}
      {...props}
    >
      <img alt="page" src="/page.webp" />
    </RegionDraw>,
  );
  const surface = container.firstElementChild as HTMLElement;
  // setPointerCapture does not exist in jsdom.
  surface.setPointerCapture = vi.fn();
  return { onDrawn, onClick, onSelect, onRegionChanged, surface };
}

describe('RegionDraw', () => {
  it('reports a rectangle in normalised page fractions, not pixels', () => {
    withSize(1000, 800);
    const { onDrawn, surface } = setup();

    drag(surface, [200, 160], [450, 240]);

    // THE contract: the same drag on a differently-sized layout must produce
    // the same stored values, so nothing here may be a pixel.
    expectRect(onDrawn, { x: 0.2, y: 0.2, width: 0.25, height: 0.1 });
  });

  it('produces the same rectangle at a different display size', () => {
    withSize(500, 400);
    const { onDrawn, surface } = setup();

    drag(surface, [100, 80], [225, 120]);

    expectRect(onDrawn, { x: 0.2, y: 0.2, width: 0.25, height: 0.1 });
  });

  it('normalises a drag made up and to the left', () => {
    // A coach should never have to think about which corner they started from.
    withSize(1000, 800);
    const { onDrawn, surface } = setup();

    drag(surface, [450, 240], [200, 160]);

    expectRect(onDrawn, { x: 0.2, y: 0.2, width: 0.25, height: 0.1 });
  });

  it('ignores a click, which is not a rectangle', () => {
    withSize(1000, 800);
    const { onDrawn, surface } = setup();

    drag(surface, [300, 300], [301, 301]);

    // Creating a 1px question the coach then has to find and delete is worse
    // than doing nothing.
    expect(onDrawn).not.toHaveBeenCalled();
  });

  it('clamps a drag that runs off the page', () => {
    withSize(1000, 800);
    const { onDrawn, surface } = setup();

    drag(surface, [900, 700], [1400, 1200]);

    const rect = onDrawn.mock.calls[0][0];
    // The server rejects a region past the page edge, so producing one would
    // turn a natural gesture into an error message.
    expect(rect.x + rect.width).toBeLessThanOrEqual(1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1);
  });

  it('draws nothing when authoring is disabled', () => {
    withSize(1000, 800);
    const { onDrawn, surface } = setup({ disabled: true });

    drag(surface, [200, 160], [450, 240]);

    expect(onDrawn).not.toHaveBeenCalled();
  });

  it('shows already-created regions with their numbers', () => {
    withSize(1000, 800);
    setup({
      existing: [
        { id: 1, label: '1', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 } },
        { id: 2, label: '2', rect: { x: 0.4, y: 0.5, width: 0.2, height: 0.05 } },
      ],
    });

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('positions an existing region as a percentage so it survives a resize', () => {
    withSize(1000, 800);
    const { surface } = setup({
      existing: [{ id: 1, label: '1', rect: { x: 0.25, y: 0.5, width: 0.1, height: 0.2 } }],
    });

    const overlay = surface.querySelector('[style*="left"]') as HTMLElement;
    expect(overlay.style.left).toBe('25%');
    expect(overlay.style.top).toBe('50%');
    expect(overlay.style.width).toBe('10%');
    expect(overlay.style.height).toBe('20%');
  });
});
