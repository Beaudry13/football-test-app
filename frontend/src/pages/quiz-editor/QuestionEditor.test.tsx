import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // The second argument is the image and the third is a recorded clip -
    // both supplied in the same call, because a question and its visual
    // material are created in one operation. Null here on both: this editor
    // has no picker and nothing was recorded.
    expect(onSave).toHaveBeenCalledWith(
      {
        question_text: 'Is this cover 2?',
        question_type: 'true_false',
        options: [
          { option_text: 'True', is_correct_answer: false },
          { option_text: 'False', is_correct_answer: true },
        ],
        // Sent as an empty string when the coach left it blank; the server
        // stores that as null so "no explanation" has one representation.
        answer_explanation: '',
        // Added by Multi-Select M2. FALSE here on purpose: this is a
        // true/false question, which never offers the setting, and the payload
        // must say so rather than omit it - the exact-shape assertion is what
        // makes a new field visible instead of silently accepted.
        allows_multiple_answers: false,
        // Phase B. NULL, and SENT rather than omitted: the update route only
        // touches the tag when the key is present, so an absent key would make
        // "cleared to Untagged" indistinguishable from "this edit was not
        // about the concept" - and clearing would silently never work. The
        // exact-shape assertion is exactly what surfaced this addition.
        concept_id: null,
      },
      null,
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
        null,
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

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), second, null));
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
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), null, null));
  });

  it('saves with no image when none was picked', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({ allowImage: true });

    await user.type(screen.getByLabelText('Question'), 'No picture');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), null, null));
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

  it('asks the picker for images BROADLY, and validates narrowly', () => {
    /* Deliberately wider than what is accepted. Given a narrow list iOS greys
       out most of the camera roll and converts HEIC inconsistently; given
       image/* it converts far more reliably, so the wide filter yields MORE
       usable files. Anything unusable is caught by the validator below, which
       is the half that stayed strict. */
    renderEditor({ allowImage: true });
    expect(screen.getByLabelText('Question image')).toHaveAttribute('accept', 'image/*');
  });

  it('sends the coach explanation with a new question', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor();

    await user.type(screen.getByLabelText('Question'), 'Which coverage?');
    await user.type(
      screen.getByLabelText(/Explanation/),
      'Two deep safeties means Cover 2.',
    );
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ answer_explanation: 'Two deep safeties means Cover 2.' }),
        null,
        null,
      ),
    );
  });

  it('offers the explanation on every type, including the ones Peira cannot score', async () => {
    const user = userEvent.setup();
    renderEditor();

    // Short Answer is exactly where a coach's own explanation does the whole
    // job of teaching, because the player is only told "Response recorded".
    await user.selectOptions(screen.getByLabelText('Type'), 'written');
    expect(screen.getByLabelText(/Explanation/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Type'), 'draw_response');
    expect(screen.getByLabelText(/Explanation/)).toBeInTheDocument();
  });

  it('loads an existing explanation when editing', () => {
    renderEditor({ initialExplanation: 'Look at the safety depth.', submitLabel: 'Save question' });

    expect(screen.getByLabelText(/Explanation/)).toHaveValue('Look at the safety depth.');
  });

  // -----------------------------------------------------------------------
  // Attaching an image: paste, drop and pick are ONE path.
  //
  // The coach's workflow is Snipping Tool then Ctrl+V. Before this, a
  // screenshot had to be saved to disk and browsed for - three steps to avoid
  // one. Nothing here uploads: every route produces a File and hands it to the
  // same state the file input writes to, so the create request is unchanged
  // and stays atomic (question + image commit together, server-side).
  // -----------------------------------------------------------------------

  function imageFile(name = 'shot.png', type = 'image/png') {
    return new File([new Uint8Array([1, 2, 3])], name, { type });
  }

  /** A paste payload shaped like a real ClipboardEvent's clipboardData. */
  function clipboardWith(items: { kind: string; type: string; file?: File }[]) {
    return {
      items: items.map((i) => ({
        kind: i.kind,
        type: i.type,
        getAsFile: () => i.file ?? null,
      })),
      getData: () => '',
    };
  }

  function formOf() {
    return screen.getByLabelText('Question').closest('form') as HTMLFormElement;
  }

  it('pastes a PNG screenshot straight onto the unsaved question', async () => {
    renderEditor({ allowImage: true });

    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([{ kind: 'file', type: 'image/png', file: imageFile() }]),
    });

    expect(await screen.findByAltText('Selected question image')).toBeInTheDocument();
  });

  it('pastes a JPEG', async () => {
    renderEditor({ allowImage: true });

    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([
        { kind: 'file', type: 'image/jpeg', file: imageFile('shot.jpg', 'image/jpeg') },
      ]),
    });

    expect(await screen.findByAltText('Selected question image')).toBeInTheDocument();
  });

  it('attaches a pasted image while the question textarea has focus', async () => {
    const user = userEvent.setup();
    renderEditor({ allowImage: true });
    const textarea = screen.getByLabelText('Question');
    await user.type(textarea, 'Which coverage is this?');

    // Pasting from the field the cursor is actually in - the realistic case.
    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([{ kind: 'file', type: 'image/png', file: imageFile() }]),
    });

    expect(await screen.findByAltText('Selected question image')).toBeInTheDocument();
    expect(textarea).toHaveValue('Which coverage is this?');
  });

  it('leaves an ordinary text paste completely alone', async () => {
    renderEditor({ allowImage: true });
    const form = formOf();

    const event = createEvent.paste(form, {
      clipboardData: clipboardWith([{ kind: 'string', type: 'text/plain' }]),
    });
    fireEvent(form, event);

    // Not prevented, so the browser performs its normal insertion.
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByAltText('Selected question image')).not.toBeInTheDocument();
  });

  it('lets text through when the clipboard carries BOTH text and an image', async () => {
    renderEditor({ allowImage: true });
    const form = formOf();

    const event = createEvent.paste(form, {
      clipboardData: clipboardWith([
        { kind: 'string', type: 'text/plain' },
        { kind: 'file', type: 'image/png', file: imageFile() },
      ]),
    });
    fireEvent(form, event);

    // The image attaches AND the text still pastes - swallowing the text
    // would be the surprising half.
    expect(await screen.findByAltText('Selected question image')).toBeInTheDocument();
    expect(event.defaultPrevented).toBe(false);
  });

  it('accepts a dropped image', async () => {
    renderEditor({ allowImage: true });
    const zone = screen.getByRole('button', { name: /Attach an image/ });

    fireEvent.drop(zone, { dataTransfer: { files: [imageFile()] } });

    expect(await screen.findByAltText('Selected question image')).toBeInTheDocument();
  });

  it('still accepts a file chosen through the picker', async () => {
    const user = userEvent.setup();
    renderEditor({ allowImage: true });

    await user.upload(screen.getByLabelText('Question image'), imageFile());

    expect(await screen.findByAltText('Selected question image')).toBeInTheDocument();
  });

  it('ignores non-image clipboard content safely', async () => {
    renderEditor({ allowImage: true });

    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([
        {
          kind: 'file',
          type: 'application/pdf',
          file: new File(['x'], 'a.pdf', { type: 'application/pdf' }),
        },
      ]),
    });

    expect(screen.queryByAltText('Selected question image')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rejects a disallowed image type that arrives by drop', async () => {
    // accept is image/* now, so the picker no longer filters these out on its
    // own - and paste and drop never respected accept anyway. The validator is
    // what stands between a coach and an unusable file, on all three routes.
    renderEditor({ allowImage: true });
    const zone = screen.getByRole('button', { name: /Attach an image/ });

    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['x'], 'evil.svg', { type: 'image/svg+xml' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/JPEG, PNG and WebP/);
    expect(screen.queryByAltText('Selected question image')).not.toBeInTheDocument();
  });

  it('rejects a disallowed image type that arrives by paste', async () => {
    renderEditor({ allowImage: true });

    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([
        {
          kind: 'file',
          type: 'image/svg+xml',
          file: new File(['x'], 'evil.svg', { type: 'image/svg+xml' }),
        },
      ]),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/JPEG, PNG and WebP/);
    expect(screen.queryByAltText('Selected question image')).not.toBeInTheDocument();
  });

  it('replaces a pasted image with another before saving', async () => {
    renderEditor({ allowImage: true });
    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([
        { kind: 'file', type: 'image/png', file: imageFile('first.png') },
      ]),
    });
    await screen.findByAltText('Selected question image');

    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([
        { kind: 'file', type: 'image/png', file: imageFile('second.png') },
      ]),
    });

    // Still exactly one preview - replaced, not appended.
    await waitFor(() => expect(screen.getAllByAltText('Selected question image')).toHaveLength(1));
  });

  it('removes a pasted image and saves the question without one', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({ allowImage: true });
    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([{ kind: 'file', type: 'image/png', file: imageFile() }]),
    });
    await screen.findByAltText('Selected question image');

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.type(screen.getByLabelText('Question'), 'No image needed');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][1]).toBeNull();
  });

  it('hands the pasted File to onSave, so it takes the file picker route exactly', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({ allowImage: true });
    const pasted = imageFile('screenshot.png');
    fireEvent.paste(formOf(), {
      clipboardData: clipboardWith([{ kind: 'file', type: 'image/png', file: pasted }]),
    });
    await screen.findByAltText('Selected question image');

    await user.type(screen.getByLabelText('Question'), 'Which coverage?');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // The SAME File the picker would have produced - one upload path.
    expect(onSave.mock.calls[0][1]).toBe(pasted);
  });

  it('offers no image area at all when the caller does not allow one', () => {
    renderEditor();

    expect(screen.queryByRole('button', { name: /Attach an image/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Question image')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A REJECTED SAVE MUST NOT LOOK LIKE A DEAD BUTTON.
//
// The banner sits at the top of a form that runs past a screen. A coach
// clicking Add question from the bottom would otherwise watch nothing happen
// while the reason scrolled off above them - and, critically, nothing about
// the form may be cleared, or they lose a typed question and a pasted
// screenshot along with it.
// ---------------------------------------------------------------------------

describe('when saving fails', () => {
  function pasteInto(form: HTMLFormElement, file: File) {
    fireEvent.paste(form, {
      clipboardData: {
        items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
        getData: () => '',
      },
    });
  }

  it('shows the error, scrolls it into view, and focuses it', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    // jsdom implements neither, so both are stubbed to observe the calls.
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const onSave = vi.fn().mockRejectedValue(new Error('That image is too large.'));
    render(
      <QuestionEditor
        submitLabel="Add question"
        onSave={onSave}
        onCancel={vi.fn()}
        allowImage
      />,
    );

    await user.type(screen.getByLabelText('Question'), 'Which coverage?');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That image is too large.');
    expect(scrollIntoView).toHaveBeenCalled();
    // Focus lands on the anchor wrapping the alert, so the message is
    // announced rather than merely scrolled to.
    expect(document.activeElement).toContainElement(alert);
  });

  it('keeps every unsaved field intact, including a pasted image', async () => {
    const user = userEvent.setup();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error('Server said no.'));
    render(
      <QuestionEditor
        submitLabel="Add question"
        onSave={onSave}
        onCancel={vi.fn()}
        allowImage
      />,
    );

    await user.selectOptions(screen.getByLabelText('Type'), 'multiple_choice');
    await user.type(screen.getByLabelText('Question'), 'Which coverage?');
    await user.type(screen.getByPlaceholderText('Option 1'), 'Cover 2');
    await user.type(screen.getByPlaceholderText('Option 2'), 'Cover 3');
    await user.type(screen.getByLabelText(/Explanation/i), 'Two deep safeties.');
    const form = screen.getByLabelText('Question').closest('form') as HTMLFormElement;
    pasteInto(form, new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }));
    await screen.findByAltText('Selected question image');

    await user.click(screen.getByRole('button', { name: 'Add question' }));
    await screen.findByRole('alert');

    // Nothing reset. Losing a typed question and a pasted screenshot to a
    // failed save is worse than the failure itself.
    expect(screen.getByLabelText('Question')).toHaveValue('Which coverage?');
    expect(screen.getByPlaceholderText('Option 1')).toHaveValue('Cover 2');
    expect(screen.getByPlaceholderText('Option 2')).toHaveValue('Cover 3');
    expect(screen.getByLabelText(/Explanation/i)).toHaveValue('Two deep safeties.');
    expect(screen.getByAltText('Selected question image')).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toHaveValue('multiple_choice');
  });

  it('re-submits the same image after a failure, so nothing has to be re-attached', async () => {
    const user = userEvent.setup();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('Temporary failure.'))
      .mockResolvedValueOnce(undefined);
    render(
      <QuestionEditor
        submitLabel="Add question"
        onSave={onSave}
        onCancel={vi.fn()}
        allowImage
      />,
    );

    await user.type(screen.getByLabelText('Question'), 'Which coverage?');
    const form = screen.getByLabelText('Question').closest('form') as HTMLFormElement;
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    pasteInto(form, file);
    await screen.findByAltText('Selected question image');

    await user.click(screen.getByRole('button', { name: 'Add question' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    // The SAME File both times - the retry is a retry, not a re-attach.
    expect(onSave.mock.calls[0][1]).toBe(file);
    expect(onSave.mock.calls[1][1]).toBe(file);
  });

  it('does not scroll when the save succeeds', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <QuestionEditor submitLabel="Add question" onSave={onSave} onCancel={vi.fn()} allowImage />,
    );

    await user.type(screen.getByLabelText('Question'), 'Which coverage?');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // A jarring jump on every successful save would be its own bug.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not scroll while the coach is simply editing the form', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(
      <QuestionEditor
        submitLabel="Add question"
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        allowImage
      />,
    );

    await user.type(screen.getByLabelText('Question'), 'Typing away');
    await user.selectOptions(screen.getByLabelText('Type'), 'written');
    const form = screen.getByLabelText('Question').closest('form') as HTMLFormElement;
    pasteInto(form, new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }));
    await screen.findByAltText('Selected question image');

    // No submit attempted, so nothing should move.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('opening the form ready to type', () => {
  it('puts the cursor in the question field when the caller opened the form', () => {
    render(
      <QuestionEditor autoFocusQuestion submitLabel="Add question" onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(document.activeElement).toBe(screen.getByLabelText('Question'));
  });

  it('does NOT steal focus by default', () => {
    // An editor rendered inline for an existing question opens because the
    // coach wants to change one word - moving the cursor (and, on a phone,
    // raising the keyboard) would be the opposite of helpful.
    render(<QuestionEditor submitLabel="Save" onSave={vi.fn()} onCancel={vi.fn()} />);

    expect(document.activeElement).not.toBe(screen.getByLabelText('Question'));
  });
});


describe('image entry follows the pointer, not the screen width', () => {
  /** jsdom implements no matchMedia at all, so each test states the device. */
  function setPointer(coarse: boolean) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('coarse') ? coarse : !coarse,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }),
    });
  }

  afterEach(() => {
    // @ts-expect-error - putting the environment back the way it was found
    delete window.matchMedia;
  });

  it('offers the CAMERA first on a touch device, and says nothing about Ctrl+V', () => {
    setPointer(true);
    renderEditor({ allowImage: true });

    expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose image' })).toBeInTheDocument();
    expect(screen.queryByText(/Ctrl\+V/)).toBeNull();
    expect(screen.queryByText(/drag/i)).toBeNull();
  });

  it('gives the camera button an input the browser will open the camera for', () => {
    setPointer(true);
    renderEditor({ allowImage: true });

    const camera = screen.getByLabelText('Take a photo for this question');
    expect(camera).toHaveAttribute('capture', 'environment');
    // A SEPARATE input from the library one, so neither button can open the
    // other's picker - `capture` is read when the picker opens.
    expect(screen.getByLabelText('Question image')).not.toHaveAttribute('capture');
  });

  it('leaves the DESKTOP paste-and-drop box exactly as it was', () => {
    setPointer(false);
    renderEditor({ allowImage: true });

    expect(screen.getByText('Paste an image here')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+V / Cmd+V')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    // No capture-hinted input on a machine whose "camera" is a webcam.
    expect(screen.queryByLabelText('Take a photo for this question')).toBeNull();
  });
});

/* Hoisted above every test in this file, so the defaults matter: each mock
   resolves rather than returning undefined. Without that, every pre-existing
   test in this file would throw inside the editor's concept-loading effect,
   which has nothing to do with what those tests are checking. */
vi.mock('../../api/concepts', () => ({
  listConcepts: vi.fn(() => Promise.resolve([])),
  createConcept: vi.fn(() => Promise.resolve({ id: 1, name: 'Stub', is_archived: false })),
}));

import { createConcept, listConcepts } from '../../api/concepts';

describe('tagging a question with a concept', () => {
  const concept = (id: number, name: string, is_archived = false) => ({ id, name, is_archived });

  beforeEach(() => {
    vi.mocked(listConcepts).mockResolvedValue([concept(1, 'Force / Contain'), concept(2, 'Run Fit')]);
    vi.mocked(createConcept).mockReset();
  });

  it('defaults to UNTAGGED, and untagged is a real saveable state', async () => {
    // Not "General": a question nobody classified does not have a concept
    // called General, and naming it one invents football the coach never said.
    const user = userEvent.setup();
    const { onSave } = renderEditor();
    await waitFor(() => expect(listConcepts).toHaveBeenCalled());

    expect((screen.getByLabelText('Concept') as HTMLSelectElement).value).toBe('');
    await user.type(screen.getByLabelText('Question'), 'Who has force?');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ concept_id: null });
  });

  it('saves the concept a coach picks', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor();
    await waitFor(() => expect(listConcepts).toHaveBeenCalled());

    await user.type(screen.getByLabelText('Question'), 'Who has force?');
    await user.selectOptions(screen.getByLabelText('Concept'), '2');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ concept_id: 2 });
  });

  it('creates one inline and selects it immediately', async () => {
    vi.mocked(createConcept).mockResolvedValue(concept(9, 'Motion Adjustment'));
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() => expect(listConcepts).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(screen.getByLabelText('New concept name'), '  Motion Adjustment  ');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    // Trimmed on the way out - the server case-folds, but a name padded with
    // spaces would still read wrong everywhere it is displayed.
    await waitFor(() => expect(createConcept).toHaveBeenCalledWith('Motion Adjustment'));
    await waitFor(() =>
      expect((screen.getByLabelText('Concept') as HTMLSelectElement).value).toBe('9'),
    );
  });

  it('does not submit the QUESTION when Enter names a concept', async () => {
    // The coach opened a text field to name a label; Enter there must not
    // save a half-written question.
    vi.mocked(createConcept).mockResolvedValue(concept(9, 'Run Fit'));
    const user = userEvent.setup();
    const { onSave } = renderEditor();
    await waitFor(() => expect(listConcepts).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(screen.getByLabelText('New concept name'), 'Run Fit{Enter}');

    await waitFor(() => expect(createConcept).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('says so when a concept cannot be created, without losing the question', async () => {
    vi.mocked(createConcept).mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() => expect(listConcepts).toHaveBeenCalled());

    await user.type(screen.getByLabelText('Question'), 'Who has force?');
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(screen.getByLabelText('New concept name'), 'Whatever');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Question')).toHaveValue('Who has force?');
  });

  it('SHOWS AN ARCHIVED CONCEPT the question still carries, marked as such', async () => {
    // The list endpoint withholds archived concepts. Without merging the
    // question's own tag in, a tagged question would render as Untagged and
    // the next save would silently strip a real tag.
    renderEditor({ initialConcept: concept(7, 'Old Idea', true) });
    await waitFor(() => expect(listConcepts).toHaveBeenCalled());

    const select = screen.getByLabelText('Concept') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('7'));
    expect(screen.getByRole('option', { name: 'Old Idea (archived)' })).toBeInTheDocument();
  });

  it('keeps the tag through an edit that does not touch it', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({
      initialConcept: concept(2, 'Run Fit'),
      initialText: 'Original wording',
      submitLabel: 'Save question',
    });
    await waitFor(() => expect(listConcepts).toHaveBeenCalled());

    await user.type(screen.getByLabelText('Question'), ' reworded');
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ concept_id: 2 });
  });

  it('lets a coach clear a tag back to Untagged', async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor({
      initialConcept: concept(2, 'Run Fit'),
      initialText: 'Tagged already',
      submitLabel: 'Save question',
    });
    await waitFor(() => expect(listConcepts).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText('Concept'), '');
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    // null must be SENT, not omitted, or the server cannot tell "cleared"
    // from "this edit was not about the concept".
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ concept_id: null });
  });

  it('still lets a question be saved when the concept list fails to load', async () => {
    // A concept is optional. A question a coach cannot save because a label
    // list did not load would be a far worse trade than an untagged one.
    vi.mocked(listConcepts).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    const { onSave } = renderEditor();

    await user.type(screen.getByLabelText('Question'), 'Who has force?');
    await user.click(screen.getByRole('button', { name: 'Add question' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });
});
