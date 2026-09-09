import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionEditor } from './QuestionEditor';
import { ApiError } from '../../api/client';

/** SAFE CORRECTIONS ARE ALLOWED. HISTORY-CHANGING ONES ARE NOT.
 *
 * That distinction is the whole point of this screen, and it used to be
 * invisible. A coach who found a typo on an active quiz met either silence or
 * a flat sentence with no route out, and concluded the quiz was locked - so
 * they deleted it, or duplicated it, or resent a new code, none of which they
 * needed to do.
 *
 * The architecture was already safe: an attempt records what it received in
 * `attempt_question_snapshots`, so a correction reaches future players only.
 * What was missing was saying so, and saying what to do when a change really
 * would rewrite history.
 *
 * These tests are about the SENTENCE and the ROUTE OUT, not the rules. The
 * rules live on the server and are tested there - including the guard that
 * refuses to let a competition's history be edited out from under it.
 */

vi.mock('../../api/concepts', () => ({
  listConcepts: vi.fn(async () => []),
  createConcept: vi.fn(),
}));

const baseProps = {
  submitLabel: 'Save question',
  initialText: 'Which coverage is shown?',
  initialType: 'multiple_choice' as const,
  initialOptions: [
    { option_text: 'Cover 3', is_correct_answer: true },
    { option_text: 'Cover 2', is_correct_answer: false },
  ],
  onCancel: vi.fn(),
};

function renderEditor(overrides: Record<string, unknown> = {}) {
  const onSave = vi.fn(async () => {});
  render(
    <MemoryRouter>
      <QuestionEditor {...baseProps} onSave={onSave} {...overrides} />
    </MemoryRouter>,
  );
  return { onSave };
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /save question/i }));

const refuseWith = (reason: string) =>
  vi.fn(async () => {
    throw new ApiError('server sentence', 422, undefined, reason);
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the delivered notice', () => {
  it('tells the coach corrections ARE allowed, and what stays frozen', () => {
    renderEditor({ hasBeenDelivered: true });

    // The whole paragraph, not the <strong> inside it - the bold half is only
    // the headline, and the two halves that matter are in the rest.
    const note = screen
      .getByText(/players have already received this question/i)
      .closest('p') as HTMLElement;
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/apply to players who start after you save/i);
    expect(note.textContent).toMatch(/keep the version they received/i);
  });

  it('never says editing is locked', () => {
    // The failure this whole task exists to fix.
    renderEditor({ hasBeenDelivered: true });
    expect(screen.queryByText(/locked|cannot be edited|read.only/i)).toBeNull();
  });

  it('is absent for a question nobody has received', () => {
    renderEditor({ hasBeenDelivered: false });
    expect(screen.queryByText(/already received this question/i)).toBeNull();
  });
});

describe('a refused correction explains itself', () => {
  it('an answer-key change says WHY, not just no', async () => {
    renderEditor({
      hasBeenDelivered: true,
      onSave: refuseWith('correct_answer_change_blocked'),
    });
    save();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/grade them differently from everyone who answers next/i);
  });

  it('and points at the two tools that DO work', async () => {
    renderEditor({
      hasBeenDelivered: true,
      onSave: refuseWith('correct_answer_change_blocked'),
    });
    save();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/stop sending this question/i);
    // Named rather than offered: exclusion lives on Results, and a second
    // entry point would be a second thing to keep correct.
    expect(alert).toHaveTextContent(/don’t count this question/i);
  });

  it('option removal explains what a player may have chosen', async () => {
    renderEditor({ hasBeenDelivered: true, onSave: refuseWith('option_removal_blocked') });
    save();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/may have chosen the option you removed/i);
    expect(alert).toHaveTextContent(/reword an option or add a new one/i);
  });

  it('a competition refusal explains that competition reads the question live', async () => {
    renderEditor({ hasBeenDelivered: true, onSave: refuseWith('competition_history_blocked') });
    save();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already been played in a competition/i);
  });

  it('offers Stop sending it, using the caller’s own handler', async () => {
    const onStopSending = vi.fn();
    renderEditor({
      hasBeenDelivered: true,
      onSave: refuseWith('correct_answer_change_blocked'),
      onStopSending,
    });
    save();

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /stop sending it/i }));
    expect(onStopSending).toHaveBeenCalledTimes(1);
  });

  it('omits the button when the caller has no retire handler', async () => {
    renderEditor({
      hasBeenDelivered: true,
      onSave: refuseWith('correct_answer_change_blocked'),
    });
    save();

    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /stop sending it/i })).toBeNull();
  });

  it('clears the explanation when the coach saves again', async () => {
    // They may have undone whatever was refused; last attempt's explanation
    // must not sit there contradicting a successful save.
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('nope', 422, undefined, 'option_removal_blocked'))
      .mockResolvedValueOnce(undefined);
    renderEditor({ hasBeenDelivered: true, onSave });

    save();
    await screen.findByRole('alert');

    save();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('ordinary failures are still ordinary', () => {
  it('an unrecognised refusal falls back to the server message', async () => {
    renderEditor({
      hasBeenDelivered: true,
      onSave: refuseWith('some_future_reason_nobody_has_mapped'),
    });
    save();

    await waitFor(() => expect(screen.getByText(/server sentence/i)).toBeInTheDocument());
  });

  it('a plain error is unaffected', async () => {
    renderEditor({
      hasBeenDelivered: true,
      onSave: vi.fn(async () => {
        throw new Error('network died');
      }),
    });
    save();

    await waitFor(() => expect(screen.getByText(/network died/i)).toBeInTheDocument());
  });

  it('a successful save on a delivered question shows no refusal at all', async () => {
    const { onSave } = renderEditor({ hasBeenDelivered: true });
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
