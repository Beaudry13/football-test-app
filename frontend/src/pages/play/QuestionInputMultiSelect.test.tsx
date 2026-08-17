/** Multi-Select M3 - the player's side.
 *
 * The bar is not "does it work" but "does a player understand it in a second,
 * on a phone, without instructions". These tests pin the things that decide
 * that:
 *
 *   - the rule is stated, not inferred from the shape of a control
 *   - the whole ROW is the tap target, not the little box
 *   - selections toggle, so a mis-tap costs one tap to undo
 *   - single choice is untouched
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionInput } from './QuestionInput';
import type { Question } from '../../api/types';

const question = (over: Partial<Question> = {}): Question =>
  ({
    id: 1,
    quiz_id: 9,
    question_text: 'Who is in the pressure?',
    question_type: 'multiple_choice',
    position: 0,
    options: [
      { id: 11, question_id: 1, option_text: 'Mike', position: 0 },
      { id: 12, question_id: 1, option_text: 'Will', position: 1 },
      { id: 13, question_id: 1, option_text: 'Nickel', position: 2 },
    ],
    image: null,
    ...over,
  }) as unknown as Question;

function renderInput(props: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  render(
    <QuestionInput
      question={question({ allows_multiple_answers: true })}
      index={0}
      answer={undefined}
      onChange={onChange}
      {...props}
    />,
  );
  return onChange;
}

describe('the player is told the rule', () => {
  it('says "Select all that apply" on a multi-select question', () => {
    renderInput();

    expect(screen.getByText('Select all that apply')).toBeInTheDocument();
  });

  it('says nothing extra on an ordinary multiple choice question', () => {
    // The common case must not get louder because a rarer one exists.
    renderInput({ question: question() });

    expect(screen.queryByText('Select all that apply')).not.toBeInTheDocument();
  });
});

describe('choosing', () => {
  it('offers checkboxes rather than radios', () => {
    renderInput();

    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('sends the complete set when one is chosen', () => {
    const onChange = renderInput();

    screen.getAllByRole('checkbox')[0].click();

    expect(onChange).toHaveBeenCalledWith({ selected_option_ids: [11] });
  });

  it('ADDS to the existing set rather than replacing it', () => {
    const onChange = renderInput({ answer: { selected_option_ids: [11] } });

    screen.getAllByRole('checkbox')[2].click();

    expect(onChange).toHaveBeenCalledWith({ selected_option_ids: [11, 13] });
  });

  it('removes a selection when a chosen row is tapped again', () => {
    // A mis-tap costs one tap to undo, which is what a checkbox means
    // everywhere else and needs no explaining.
    const onChange = renderInput({ answer: { selected_option_ids: [11, 13] } });

    screen.getAllByRole('checkbox')[0].click();

    expect(onChange).toHaveBeenCalledWith({ selected_option_ids: [13] });
  });

  it('sends a sorted set, so tap order never reaches the server', () => {
    const onChange = renderInput({ answer: { selected_option_ids: [13] } });

    screen.getAllByRole('checkbox')[0].click();

    expect(onChange).toHaveBeenCalledWith({ selected_option_ids: [11, 13] });
  });

  it('shows every chosen row as selected, not just one', async () => {
    renderInput({ answer: { selected_option_ids: [11, 13] } });

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[2]).toBeChecked();
  });
});

describe('the tap target', () => {
  it('is the whole row, not the checkbox', async () => {
    // The row is a <label> wrapping the control, so tapping the TEXT selects
    // it. On a phone this is the difference between a comfortable target and
    // a frustrating one.
    const user = userEvent.setup();
    const onChange = renderInput();

    await user.click(screen.getByText('Nickel'));

    expect(onChange).toHaveBeenCalledWith({ selected_option_ids: [13] });
  });
});

describe('single choice is untouched', () => {
  it('still uses radios', () => {
    renderInput({ question: question() });

    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('still sends one id, not a set', () => {
    const onChange = renderInput({ question: question() });

    screen.getAllByRole('radio')[1].click();

    expect(onChange).toHaveBeenCalledWith({ selected_option_id: 12 });
  });
});

describe('a locked question', () => {
  it('cannot be changed', () => {
    renderInput({ locked: true, answer: { selected_option_ids: [11] } });

    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).toBeDisabled();
    }
  });
});
