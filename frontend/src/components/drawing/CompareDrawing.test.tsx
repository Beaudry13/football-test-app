import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The viewer draws on a Fabric canvas; what matters here is what it is asked to draw.
const seen: { overlay: unknown }[] = [];
vi.mock('./DrawingViewer', () => ({
  DrawingViewer: (props: { overlay: unknown; alt: string }) => {
    seen.push({ overlay: props.overlay });
    return <div role="img" aria-label={props.alt} />;
  },
}));
import { CompareDrawing } from './CompareDrawing';
import type { DrawingDocument } from './types';

const doc = (layer: 'player' | 'coach') =>
  ({ format: 'peira.drawing', version: 1, strokes: [{ layer }] }) as unknown as DrawingDocument;

describe('his drawing against the answer', () => {
  it('lays the answer over his drawing, and one toggle shows his alone', () => {
    const answer = doc('coach');
    render(<CompareDrawing imageUrl="/p.png" document={doc('player')} answer={answer} alt="Jordan's drawing" />);
    expect(seen.at(-1)?.overlay).toBe(answer);
    const toggle = screen.getByRole('button', { name: /Your answer/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(seen.at(-1)?.overlay).toBeNull();
  });

  it('no answer drawn: just his drawing, no toggle', () => {
    render(<CompareDrawing imageUrl="/p.png" document={doc('player')} answer={null} alt="Jordan's drawing" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(seen.at(-1)?.overlay).toBeNull();
  });

  it("a Rep's player sees it as the coach's answer", () => {
    render(
      <CompareDrawing imageUrl="/p.png" document={doc('player')} answer={doc('coach')} answerLabel="Coach's answer" alt="Yours" />,
    );
    expect(screen.getByRole('button', { name: /Coach's answer/ })).toBeInTheDocument();
  });
});
