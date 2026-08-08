import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegionQuestionForm } from './RegionQuestionForm';

function setup(overrides: Partial<React.ComponentProps<typeof RegionQuestionForm>> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <RegionQuestionForm
      onSave={onSave}
      onCancel={onCancel}
      saving={false}
      defaultPrompt=""
      {...overrides}
    />,
  );
  return { onSave, onCancel };
}

describe('RegionQuestionForm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the answer field, not the prompt', () => {
    // The prompt is often reused across a page; the answer changes every time
    // and is what the coach came to type.
    setup();
    expect(screen.getByLabelText('Accepted answers')).toHaveFocus();
  });

  it('saves one answer and a prompt', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();

    await user.type(screen.getByLabelText('Accepted answers'), 'Cover 3');
    await user.type(screen.getByLabelText('Question'), 'What coverage is this?');
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    expect(onSave).toHaveBeenCalledWith({
      question_text: 'What coverage is this?',
      expected_answers: ['Cover 3'],
    });
  });

  it('splits comma-separated alternatives', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();

    await user.type(screen.getByLabelText('Accepted answers'), 'Cover 3, C3 , Cvr 3');
    await user.type(screen.getByLabelText('Question'), 'Coverage?');
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    expect(onSave).toHaveBeenCalledWith({
      question_text: 'Coverage?',
      expected_answers: ['Cover 3', 'C3', 'Cvr 3'],
    });
  });

  it('drops blank entries from the list', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();

    await user.type(screen.getByLabelText('Accepted answers'), 'Cover 3, , ,C3,');
    await user.type(screen.getByLabelText('Question'), 'Coverage?');
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    expect(onSave.mock.calls[0][0].expected_answers).toEqual(['Cover 3', 'C3']);
  });

  it('reuses the last prompt so the next question is faster', () => {
    // A coach masking twelve coverage names types one question, not twelve.
    setup({ defaultPrompt: 'What coverage is this?' });
    expect(screen.getByLabelText('Question')).toHaveValue('What coverage is this?');
  });

  it('cannot be saved without an answer', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('Question'), 'Coverage?');
    expect(screen.getByRole('button', { name: 'Save question' })).toBeDisabled();
  });

  it('cannot be saved without a prompt', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('Accepted answers'), 'Cover 3');
    expect(screen.getByRole('button', { name: 'Save question' })).toBeDisabled();
  });

  it('cannot be double-submitted while saving', () => {
    setup({ saving: true, defaultPrompt: 'Coverage?' });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('can be cancelled', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
