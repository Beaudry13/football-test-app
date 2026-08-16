/** Phase 4C - the correction notice.
 *
 * Its job is to explain a boundary, not to discourage a fix. A coach who has
 * found a mistake should come away understanding three things:
 *
 *   old attempts          -> unchanged
 *   in-progress attempts  -> unchanged, pinned to what they were delivered
 *   new attempts          -> corrected
 *
 * And it must not appear on a question nobody has received, where there is no
 * boundary to explain and the note would just be noise.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuestionEditor } from './QuestionEditor';

function renderEditor(hasBeenDelivered: boolean) {
  return render(
    <QuestionEditor
      initialText="Which gap does the 3-tech attack?"
      initialType="multiple_choice"
      initialOptions={[
        { option_text: 'B gap', is_correct_answer: true },
        { option_text: 'A gap', is_correct_answer: false },
      ]}
      hasBeenDelivered={hasBeenDelivered}
      submitLabel="Save question"
      onSave={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
    />,
  );
}

describe('a question players have already received', () => {
  it('says the change applies to future attempts only', () => {
    renderEditor(true);

    expect(
      screen.getByText(/changes the question for future attempts only/i),
    ).toBeInTheDocument();
  });

  it('says existing players keep their version, answers and scores', () => {
    renderEditor(true);

    expect(
      screen.getByText(/keep the version they got, along with their answers and scores/i),
    ).toBeInTheDocument();
  });

  it('explains that the image players saw is kept', () => {
    renderEditor(true);

    expect(screen.getByText(/image players already saw is kept/i)).toBeInTheDocument();
  });

  it('does not present the correction as dangerous', () => {
    // The UX rule: explain the boundary, do not scare the coach out of fixing
    // a mistake. No alert role, and none of the vocabulary of a hazard.
    renderEditor(true);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/warning/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/permanently/i)).not.toBeInTheDocument();
  });

  it('still lets the coach save', () => {
    renderEditor(true);

    expect(screen.getByRole('button', { name: 'Save question' })).toBeEnabled();
  });
});

describe('a question nobody has received', () => {
  it('shows no notice at all', () => {
    renderEditor(false);

    expect(
      screen.queryByText(/changes the question for future attempts only/i),
    ).not.toBeInTheDocument();
  });

  it('defaults to showing no notice when the flag is absent', () => {
    // Older cached payloads carry no `has_been_delivered`. Defaulting to
    // "delivered" would put a confusing note on every brand-new question.
    render(
      <QuestionEditor
        initialText="Brand new"
        initialType="true_false"
        submitLabel="Save question"
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/changes the question for future attempts only/i),
    ).not.toBeInTheDocument();
  });
});
