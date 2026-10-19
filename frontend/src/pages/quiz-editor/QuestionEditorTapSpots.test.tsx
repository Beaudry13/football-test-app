import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QuestionEditor } from './QuestionEditor';

/**
 * TAP ANSWERS ON AN UPLOADED PHOTO - the coach's own spots, one per answer.
 * Nothing is read from the photo: the spots start in a plain row, and he
 * drags, names, tries and confirms them before they are saved.
 */

const options = [
  { option_text: 'X', is_correct_answer: true },
  { option_text: 'Z', is_correct_answer: false },
];

function edit(props: Partial<React.ComponentProps<typeof QuestionEditor>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <QuestionEditor
        submitLabel="Save question"
        onSave={onSave}
        onCancel={vi.fn()}
        initialText="Who gets the ball?"
        initialType="multiple_choice"
        initialOptions={options}
        existingImageUrl="/uploads/photo.png"
        annotateHref="/quizzes/1/questions/5/annotate"
        {...props}
      />
    </MemoryRouter>,
  );
  return onSave;
}

const atSurface = () => {
  const surface = document.querySelector('[data-tap-surface]') as HTMLElement;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
};

describe('tap spots on an uploaded photo', () => {
  it('the coach places a spot for each answer, confirms them, and they save with the question', async () => {
    const onSave = edit();
    fireEvent.click(screen.getByRole('button', { name: 'Players tap the picture' }));
    const check = within(await screen.findByRole('dialog', { name: 'What your players tap' }));
    atSurface();
    const z = check.getByRole('button', { name: 'Move Z' });
    fireEvent.pointerDown(z, { pointerId: 1 });
    fireEvent.pointerMove(z, { pointerId: 1, clientX: 800, clientY: 250 });
    fireEvent.pointerUp(z, { pointerId: 1 });
    // He can try exactly what a player taps.
    fireEvent.click(check.getByRole('radio', { name: 'Try it' }));
    fireEvent.click(check.getByRole('button', { name: 'Tap Z' }));
    expect(check.getByRole('status')).toHaveTextContent('That answers “Z” - not the right one.');
    fireEvent.click(check.getByRole('button', { name: 'Looks right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save question' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [input] = onSave.mock.calls[0];
    expect(input.tap_targets).toHaveLength(2);
    expect(input.tap_targets[1]).toEqual({ x: 0.8, y: 0.5, zone: true });
  });

  it('spots placed but not confirmed are checked before saving', async () => {
    const onSave = edit();
    fireEvent.click(screen.getByRole('button', { name: 'Players tap the picture' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'What your players tap' })).getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Spots placed - check them before you save.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save question' }));
    const check = within(await screen.findByRole('dialog', { name: 'What your players tap' }));
    expect(check.getByText('Check the spots before you save.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(check.getByRole('button', { name: 'Looks right' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it('once players have it, the spots can be tried but not moved or removed', async () => {
    edit({
      hasBeenDelivered: true,
      existingTapTargets: [
        { x: 0.2, y: 0.5, zone: true },
        { x: 0.8, y: 0.5, zone: true },
      ],
    });
    expect(screen.queryByRole('button', { name: 'Buttons only' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'See what they tap' }));
    const check = within(await screen.findByRole('dialog', { name: 'What your players tap' }));
    expect(check.queryByRole('button', { name: 'Move Z' })).toBeNull();
    expect(check.getByText('Players have this question, so its spots are locked.')).toBeInTheDocument();
  });

  it('not offered on a select-all question or a marked-up picture', () => {
    edit({ initialAllowsMultiple: true });
    expect(screen.queryByRole('button', { name: 'Players tap the picture' })).toBeNull();
  });

  it('a picture with the coach’s markings says why there are no spots', () => {
    edit({ existingImageHasMarks: true });
    expect(screen.queryByRole('button', { name: 'Players tap the picture' })).toBeNull();
    expect(screen.getByText('Tap answers need a picture without your markings.')).toBeInTheDocument();
  });
});
