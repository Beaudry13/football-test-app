import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// The board itself is a Fabric canvas jsdom cannot draw; this is about the
// editor around it - when it is offered, and what is saved.
vi.mock('../../components/drawing/DrawingBoard', () => ({
  DrawingBoard: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Drawing board">
      <button type="button" onClick={onClose}>
        Close board
      </button>
    </div>
  ),
}));
vi.mock('../play/drawingDraft', async (original) => ({
  ...(await original<typeof import('../play/drawingDraft')>()),
  measureImage: vi.fn(async () => ({ width: 1000, height: 600 })),
}));
import { QuestionEditor } from './QuestionEditor';
import type { DrawingDocument } from '../../components/drawing/types';

/** DRAW THE ANSWER: a Draw Response question carries the coach's own drawing. */

const drawn: DrawingDocument = {
  format: 'peira.drawing',
  version: 1,
  coordinate_width: 1000,
  coordinate_height: 600,
  source: { image_id: '7', image_version: null, natural_width: 1000, natural_height: 600 },
  strokes: [{ id: 's1', tool: 'pen', layer: 'coach', points: [1, 2, 3, 4], color: '#22c55e', width: 4, order: 1 }],
} as unknown as DrawingDocument;

function edit(props: Partial<React.ComponentProps<typeof QuestionEditor>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <QuestionEditor
        submitLabel="Save question"
        onSave={onSave}
        onCancel={vi.fn()}
        initialText="Draw the FS rotation"
        initialType="draw_response"
        initialOptions={[]}
        existingImageUrl="/uploads/coverage.png"
        annotateHref="/quizzes/1/questions/5/annotate"
        {...props}
      />
    </MemoryRouter>,
  );
  return onSave;
}

describe('Draw the answer', () => {
  it('offered on a drawing question with a picture, on the same board a player uses', async () => {
    edit();
    fireEvent.click(screen.getByRole('button', { name: 'Draw the answer' }));
    expect(await screen.findByRole('dialog', { name: 'Drawing board' })).toBeInTheDocument();
  });

  it('not offered on a question players answer another way', () => {
    edit({ initialType: 'multiple_choice', initialOptions: [{ option_text: 'A', is_correct_answer: true }, { option_text: 'B', is_correct_answer: false }] });
    expect(screen.queryByRole('button', { name: 'Draw the answer' })).toBeNull();
  });

  it('a drawn answer says so; Remove clears it and the save sends null', async () => {
    const onSave = edit({ existingAnswerDrawing: drawn });
    expect(screen.getByText(/Your answer is drawn/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Draw the answer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save question' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].answer_drawing).toBeNull();
  });

  it('an unchanged answer drawing is not resent', async () => {
    const onSave = edit({ existingAnswerDrawing: drawn });
    fireEvent.click(screen.getByRole('button', { name: 'Save question' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect('answer_drawing' in onSave.mock.calls[0][0]).toBe(false);
  });
});
