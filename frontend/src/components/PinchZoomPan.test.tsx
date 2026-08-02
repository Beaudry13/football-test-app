import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PinchZoomPan } from './PinchZoomPan';

function pointerDown(el: Element, opts: Partial<PointerEvent> & { pointerId: number; clientX: number; clientY: number }) {
  fireEvent.pointerDown(el, opts);
}
function pointerUp(el: Element, opts: Partial<PointerEvent> & { pointerId: number; clientX: number; clientY: number }) {
  fireEvent.pointerUp(el, opts);
}

describe('PinchZoomPan', () => {
  it('renders its children', () => {
    render(
      <PinchZoomPan>
        <img src="/photo.png" alt="Film still" />
      </PinchZoomPan>,
    );
    expect(screen.getByAltText('Film still')).toBeInTheDocument();
  });

  it('does not show a reset button at the default 1x scale', () => {
    render(
      <PinchZoomPan>
        <img src="/photo.png" alt="Film still" />
      </PinchZoomPan>,
    );
    expect(screen.queryByRole('button', { name: 'Reset zoom' })).not.toBeInTheDocument();
  });

  it('shows and applies the reset button after a double-click zooms in', () => {
    render(
      <PinchZoomPan>
        <img src="/photo.png" alt="Film still" />
      </PinchZoomPan>,
    );
    const surface = screen.getByAltText('Film still').parentElement!.parentElement!;

    fireEvent.doubleClick(surface, { clientX: 50, clientY: 50 });

    const resetButton = screen.getByRole('button', { name: 'Reset zoom' });
    expect(resetButton).toBeInTheDocument();

    fireEvent.click(resetButton);
    expect(screen.queryByRole('button', { name: 'Reset zoom' })).not.toBeInTheDocument();
  });

  it('a plain single tap (no movement, no second tap) does not trigger zoom', () => {
    render(
      <PinchZoomPan>
        <img src="/photo.png" alt="Film still" />
      </PinchZoomPan>,
    );
    const surface = screen.getByAltText('Film still').parentElement!.parentElement!;

    pointerDown(surface, { pointerId: 1, clientX: 50, clientY: 50 });
    pointerUp(surface, { pointerId: 1, clientX: 50, clientY: 50 });

    expect(screen.queryByRole('button', { name: 'Reset zoom' })).not.toBeInTheDocument();
  });

  it('two quick taps in the same spot (a manual double-tap) toggle zoom in', () => {
    render(
      <PinchZoomPan>
        <img src="/photo.png" alt="Film still" />
      </PinchZoomPan>,
    );
    const surface = screen.getByAltText('Film still').parentElement!.parentElement!;

    pointerDown(surface, { pointerId: 1, clientX: 50, clientY: 50 });
    pointerUp(surface, { pointerId: 1, clientX: 50, clientY: 50 });
    pointerDown(surface, { pointerId: 2, clientX: 51, clientY: 51 });
    pointerUp(surface, { pointerId: 2, clientX: 51, clientY: 51 });

    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeInTheDocument();
  });

  it('a tap that moves past the threshold does not count toward a double-tap', () => {
    render(
      <PinchZoomPan>
        <img src="/photo.png" alt="Film still" />
      </PinchZoomPan>,
    );
    const surface = screen.getByAltText('Film still').parentElement!.parentElement!;

    pointerDown(surface, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 90, clientY: 90 });
    pointerUp(surface, { pointerId: 1, clientX: 90, clientY: 90 });
    pointerDown(surface, { pointerId: 2, clientX: 90, clientY: 90 });
    pointerUp(surface, { pointerId: 2, clientX: 90, clientY: 90 });

    expect(screen.queryByRole('button', { name: 'Reset zoom' })).not.toBeInTheDocument();
  });
});
