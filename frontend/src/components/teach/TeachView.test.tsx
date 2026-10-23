import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TeachView, type TeachSlide } from './TeachView';

/**
 * TEACH IN THE MEETING ROOM: operated while talking to a room. The football
 * leads; ← → step (and past the last slide, the next thing to teach); Space
 * plays it again; N leaves the football alone on the screen; F is full
 * screen; who this is about ("3 of 11 missed it") is on the screen; and the
 * next thing to teach is one press away.
 */

let mounts = 0;
function Picture({ label }: { label: string }) {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="picture">{label}</div>;
}
const slide = (key: number, over: Partial<TeachSlide> = {}): TeachSlide => ({
  key,
  imageUrl: null,
  role: null,
  prompt: `Question ${key}`,
  right: ['Rotate down'],
  why: 'He is the new #3.',
  wrong: null,
  motionPlayId: null,
  picture: <Picture label={`play ${key}`} />,
  ...over,
});
const open = (props: Partial<React.ComponentProps<typeof TeachView>> = {}) => {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <TeachView title="Motion adjustment" slides={[slide(1), slide(2)]} onClose={onClose} {...props} />
    </MemoryRouter>,
  );
  return { onClose, screenEl: screen.getByRole('dialog', { name: /Teach/ }) };
};

describe('Teach in the meeting room', () => {
  it('leads with the football, and the arrows step through it', () => {
    const { screenEl } = open();
    expect(screen.getByTestId('picture')).toHaveTextContent('play 1');
    fireEvent.keyDown(screenEl, { key: 'ArrowRight' });
    expect(screen.getByTestId('picture')).toHaveTextContent('play 2');
    fireEvent.keyDown(screenEl, { key: 'ArrowLeft' });
    expect(screen.getByTestId('picture')).toHaveTextContent('play 1');
    fireEvent.keyDown(screenEl, { key: '2' });
    expect(screen.getByTestId('picture')).toHaveTextContent('play 2');
  });

  it('past the last slide, → is the next thing to teach - and Next says what it is', () => {
    const onGo = vi.fn();
    const { screenEl } = open({ next: { label: 'Run fit · 3 missed', onGo } });
    expect(screen.getByRole('button', { name: /Next: Run fit · 3 missed/ })).toBeInTheDocument();
    fireEvent.keyDown(screenEl, { key: 'ArrowRight' });
    expect(onGo).not.toHaveBeenCalled();
    fireEvent.keyDown(screenEl, { key: 'ArrowRight' });
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  it('Space plays the play again', () => {
    mounts = 0;
    const { screenEl } = open();
    expect(mounts).toBe(1);
    fireEvent.keyDown(screenEl, { key: ' ' });
    expect(mounts).toBe(2);
  });

  it('N leaves the football alone on the screen, and brings the notes back', () => {
    const { screenEl } = open();
    expect(screen.getByText('He is the new #3.')).toBeInTheDocument();
    fireEvent.keyDown(screenEl, { key: 'n' });
    expect(screen.queryByText('He is the new #3.')).toBeNull();
    expect(screen.getByTestId('picture')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    expect(screen.getByText('He is the new #3.')).toBeInTheDocument();
  });

  it('says who this is about', () => {
    open({ room: { missed: 3, of: 11, names: ['Ty Adams', 'Bo Brown', 'Cam Cole'] } });
    expect(screen.getByText('3 of 11 missed it')).toBeInTheDocument();
    expect(screen.getByText('Ty Adams, Bo Brown, Cam Cole')).toBeInTheDocument();
  });

  it('a long list of names is counted, not crammed', () => {
    open({ room: { missed: 8, of: 11, names: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], verb: 'still working on it' } });
    expect(screen.getByText('8 of 11 still working on it')).toBeInTheDocument();
    expect(screen.getByText('A, B, C, D, E, F and 2 more')).toBeInTheDocument();
  });

  it("names the concept when the title doesn't, and the player whose job it is", () => {
    open({ title: 'Week 6 install', slides: [slide(1, { concept: 'Motion adjustment', role: 'Boundary safety' })] });
    expect(screen.getByText('Motion adjustment')).toBeInTheDocument();
    expect(screen.getByText(/You.re the Boundary safety/)).toBeInTheDocument();
  });

  it('F asks for full screen - a projector', () => {
    const request = vi.fn().mockResolvedValue(undefined);
    HTMLElement.prototype.requestFullscreen = request;
    const { screenEl } = open();
    fireEvent.keyDown(screenEl, { key: 'f' });
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('Escape closes', () => {
    const { onClose, screenEl } = open();
    fireEvent.keyDown(screenEl, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('new slides from the caller (the next thing) start at their first slide', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <TeachView title="A" slides={[slide(1), slide(2)]} start={1} onClose={onClose} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('picture')).toHaveTextContent('play 2');
    rerender(
      <MemoryRouter>
        <TeachView title="B" slides={[slide(7), slide(8)]} onClose={onClose} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('picture')).toHaveTextContent('play 7');
  });
});

describe('Ask first - the room check', () => {
  const asked = (key: number) =>
    slide(key, { picture: <Picture label={`answer lit ${key}`} />, pictureAsk: <Picture label={`no answer ${key}`} /> });

  it('holds the answer back - no right answer, no reason, no lit spot - until the coach shows it', () => {
    const { screenEl } = open({ slides: [asked(1), asked(2)] });
    fireEvent.click(screen.getByRole('button', { name: 'Ask first' }));
    expect(screen.queryByText('Rotate down')).toBeNull();
    expect(screen.queryByText('He is the new #3.')).toBeNull();
    expect(screen.getByTestId('picture')).toHaveTextContent('no answer 1');
    expect(screen.getByText('Question 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show the answer/ }));
    expect(screen.getByText('Rotate down')).toBeInTheDocument();
    expect(screen.getByText('He is the new #3.')).toBeInTheDocument();
    expect(screen.getByTestId('picture')).toHaveTextContent('answer lit 1');

    // The next slide starts held back again.
    fireEvent.keyDown(screenEl, { key: 'ArrowRight' });
    expect(screen.getByTestId('picture')).toHaveTextContent('no answer 2');
    expect(screen.queryByText('Rotate down')).toBeNull();
    // A shows it, from the keyboard.
    fireEvent.keyDown(screenEl, { key: 'a' });
    expect(screen.getByText('Rotate down')).toBeInTheDocument();
  });

  it('A turns ask first on, and off again once shown', () => {
    const { screenEl } = open({ slides: [asked(1)] });
    fireEvent.keyDown(screenEl, { key: 'a' });
    expect(screen.getByRole('button', { name: 'Ask first' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(screenEl, { key: 'a' });
    fireEvent.keyDown(screenEl, { key: 'a' });
    expect(screen.getByRole('button', { name: 'Ask first' })).toHaveAttribute('aria-pressed', 'false');
  });
});
