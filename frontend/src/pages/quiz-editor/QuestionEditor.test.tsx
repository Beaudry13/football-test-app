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
    // The second argument is the image, which the create flow now passes in
    // the same call - null here because this editor has no picker.
    expect(onSave).toHaveBeenCalledWith(
      {
        question_text: 'Is this cover 2?',
        question_type: 'true_false',
        options: [
          { option_text: 'True', is_correct_answer: false },
          { option_text: 'False', is_correct_answer: true },
        ],
      },
      null,
    );
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

describe('QuestionEditor image upload on create', () => {
  function pngFile(name = 'play.png') {
    return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
  }

  it('offers no image picker unless the create flow asks for one', () => {
    // Editing keeps its existing route to the annotation page, which does more
    // than upload - that is where a coach draws on the image.
    renderEditor();
    expect(screen.queryByLabelText('Question image')).not.toBeInTheDocument();
  });

  it('lets a coach attach an image before the first save', async () => {
    const user = userEvent.setup();
    renderEditor({ allowImage: true });

    await user.upload(screen.getByLabelText('Question image'), pngFile());

    // Previewed from the local file - nothing has been created yet.
    expect(await screen.findByAltText('Selected question image')).toBeInTheDocument();
  });

  it('sends the file with the question in one save', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({ allowImage: true });
    const file = pngFile();

    await user.type(screen.getByLabelText('Question'), 'Who has the flat?');
    await user.upload(screen.getByLabelText('Question image'), file);
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ question_text: 'Who has the flat?' }),
        file,
      ),
    );
  });

  it('can replace the image before saving', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({ allowImage: true });
    const second = pngFile('second.png');

    await user.upload(screen.getByLabelText('Question image'), pngFile('first.png'));
    await screen.findByAltText('Selected question image');
    await user.upload(screen.getByLabelText('Question image'), second);

    await user.type(screen.getByLabelText('Question'), 'Q');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), second));
  });

  it('can remove the image before saving', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({ allowImage: true });

    await user.upload(screen.getByLabelText('Question image'), pngFile());
    await screen.findByAltText('Selected question image');
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(screen.queryByAltText('Selected question image')).not.toBeInTheDocument(),
    );

    await user.type(screen.getByLabelText('Question'), 'Q');
    await user.click(screen.getByRole('button', { name: 'Add question' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), null));
  });

  it('saves with no image when none was picked', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({ allowImage: true });

    await user.type(screen.getByLabelText('Question'), 'No picture');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), null));
  });

  it('cancelling never calls save, so nothing reaches the server', async () => {
    // THE guarantee: the file is held locally until save, so Cancel cannot
    // leave a partial question behind - there was never anything to leave.
    const user = userEvent.setup();
    const { onSave, onCancel } = renderEditor({ allowImage: true });

    await user.upload(screen.getByLabelText('Question image'), pngFile());
    await screen.findByAltText('Selected question image');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('only accepts image types at the picker', () => {
    renderEditor({ allowImage: true });
    expect(screen.getByLabelText('Question image')).toHaveAttribute(
      'accept',
      'image/png,image/jpeg,image/webp',
    );
  });
});
