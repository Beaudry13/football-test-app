/** Multi-Select M2 - the coach's side, which is one checkbox.
 *
 * The feature has to earn its place in an editor a coach already knows. These
 * tests pin the things that keep it small:
 *
 *   - it only appears on multiple choice
 *   - it does not change single-choice authoring at all
 *   - turning it on changes the interaction to one coaches already understand
 *     (radio -> checkbox), not to a new concept
 *   - the consequence is stated where the decision is made, not in a modal
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionEditor } from './QuestionEditor';

function renderEditor(props: Record<string, unknown> = {}) {
  return render(
    <QuestionEditor
      initialText="Who is in the pressure?"
      initialType="multiple_choice"
      initialOptions={[
        { option_text: 'Mike', is_correct_answer: true },
        { option_text: 'Will', is_correct_answer: false },
      ]}
      submitLabel="Save question"
      onSave={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
      {...props}
    />,
  );
}

describe('where the setting appears', () => {
  it('is offered on multiple choice', () => {
    renderEditor();

    expect(screen.getByLabelText(/allow more than one answer/i)).toBeInTheDocument();
  });

  it('is NOT offered on true/false', () => {
    // Two options, one right, by definition. A setting here would be noise.
    renderEditor({ initialType: 'true_false' });

    expect(screen.queryByText(/allow more than one answer/i)).not.toBeInTheDocument();
  });

  it('is NOT offered on a written question', () => {
    renderEditor({ initialType: 'written', initialOptions: [] });

    expect(screen.queryByText(/allow more than one answer/i)).not.toBeInTheDocument();
  });

  it('says what it will do to PLAYERS, where the decision is made', () => {
    // Not in a modal, not behind a help link, not in a warning banner.
    renderEditor();

    expect(screen.getByText(/select all that apply/i)).toBeInTheDocument();
  });
});

describe('single choice is untouched', () => {
  it('marks correctness with radios by default', () => {
    renderEditor();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.queryByRole('checkbox', { name: /option 1 is correct/i })).toBeNull();
  });

  it('picking a new correct answer un-picks the old one', async () => {
    const user = userEvent.setup();
    renderEditor();

    const [first, second] = screen.getAllByRole('radio');
    expect(first).toBeChecked();

    await user.click(second);

    expect(second).toBeChecked();
    expect(first).not.toBeChecked();
  });

  it('starts switched off', () => {
    renderEditor();

    expect(screen.getByLabelText(/allow more than one answer/i)).not.toBeChecked();
  });
});

describe('turning it on', () => {
  it('switches correctness to checkboxes', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByLabelText(/allow more than one answer/i));

    expect(screen.getAllByRole('checkbox', { name: /is correct/i })).toHaveLength(2);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('lets several answers be correct at once', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByLabelText(/allow more than one answer/i));

    const boxes = screen.getAllByRole('checkbox', { name: /is correct/i });
    await user.click(boxes[1]);

    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
  });

  it('lets a correct answer be un-marked, unlike a radio', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByLabelText(/allow more than one answer/i));

    const boxes = screen.getAllByRole('checkbox', { name: /is correct/i });
    await user.click(boxes[0]);

    expect(boxes[0]).not.toBeChecked();
  });

  it('updates the options label to match', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByLabelText(/allow more than one answer/i));

    expect(screen.getByText(/mark every correct one/i)).toBeInTheDocument();
  });

  it('sends the setting when saved', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onSave });

    await user.click(screen.getByLabelText(/allow more than one answer/i));
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    // Asserting the payload only: the second argument is the optional image,
    // which this editor instance never offers and which is not what this test
    // is about.
    expect(onSave.mock.calls[0][0]).toMatchObject({ allows_multiple_answers: true });
  });
});

describe('an existing multi-select question', () => {
  it('opens with the setting already on', () => {
    renderEditor({ initialAllowsMultiple: true });

    expect(screen.getByLabelText(/allow more than one answer/i)).toBeChecked();
    expect(screen.getAllByRole('checkbox', { name: /is correct/i })).toHaveLength(2);
  });
});
