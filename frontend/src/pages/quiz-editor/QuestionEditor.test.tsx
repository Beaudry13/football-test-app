import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionEditor } from './QuestionEditor';

function renderEditor(props: Partial<React.ComponentProps<typeof QuestionEditor>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(<QuestionEditor submitLabel="Add question" onSave={onSave} onCancel={onCancel} {...props} />);
  return { onSave, onCancel };
}

describe('QuestionEditor', () => {
  it('defaults to true/false with True marked correct', () => {
    renderEditor();

    expect(screen.getByLabelText('Type')).toHaveValue('true_false');
    const [trueRadio, falseRadio] = screen.getAllByRole('radio');
    expect(trueRadio).toBeChecked();
    expect(falseRadio).not.toBeChecked();
  });

  it('switching to multiple choice replaces options with two blank ones', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.selectOptions(screen.getByLabelText('Type'), 'multiple_choice');

    expect(screen.getByPlaceholderText('Option 1')).toHaveValue('');
    expect(screen.getByPlaceholderText('Option 2')).toHaveValue('');
    expect(screen.queryByPlaceholderText('Option 3')).not.toBeInTheDocument();
  });

  it('switching to written hides the options section entirely', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.selectOptions(screen.getByLabelText('Type'), 'written');

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('adds and removes options, only allowing removal above the two-option minimum', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.selectOptions(screen.getByLabelText('Type'), 'multiple_choice');

    expect(screen.queryByRole('button', { name: 'Remove option' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ Add option' }));
    expect(screen.getByPlaceholderText('Option 3')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove option' })).toHaveLength(3);

    await user.click(screen.getAllByRole('button', { name: 'Remove option' })[2]);
    expect(screen.queryByPlaceholderText('Option 3')).not.toBeInTheDocument();
  });

  it('changes which option is marked correct when a different radio is selected', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.selectOptions(screen.getByLabelText('Type'), 'multiple_choice');

    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();

    await user.click(radios[1]);

    expect(radios[0]).not.toBeChecked();
    expect(radios[1]).toBeChecked();
  });

  it('rejects a multiple-choice submission with a blank option, without calling onSave', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor();
    await user.selectOptions(screen.getByLabelText('Type'), 'multiple_choice');
    await user.type(screen.getByLabelText('Question'), 'Which gap?');
    await user.type(screen.getByPlaceholderText('Option 1'), 'A gap');
    // Option 2 deliberately left blank.

    await user.click(screen.getByRole('button', { name: 'Add question' }));

    expect(await screen.findByText('Every option needs text.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('submits a trimmed true/false question with the selected correct answer', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor();

    await user.type(screen.getByLabelText('Question'), '  Is this cover 2?  ');
    await user.click(screen.getAllByRole('radio')[1]); // mark "False" correct
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      question_text: 'Is this cover 2?',
      question_type: 'true_false',
      options: [
        { option_text: 'True', is_correct_answer: false },
        { option_text: 'False', is_correct_answer: true },
      ],
    });
  });

  it('shows the save error and re-enables the form when onSave rejects', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('Network down'));
    render(<QuestionEditor submitLabel="Add question" onSave={onSave} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText('Question'), 'Is this cover 2?');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    expect(await screen.findByText('Network down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add question' })).not.toBeDisabled();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
