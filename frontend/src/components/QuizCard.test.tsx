/** S1 - BROWSING IS THE DEFAULT, MANAGEMENT IS INVOKED.
 *
 * A quiz card used to carry three permanent controls: a folder dropdown, a
 * Duplicate button and a red Delete. On a screen whose job is "open a quiz"
 * that is thirty controls at ten quizzes, and the rarest action - Delete - was
 * the highest-contrast thing on every row.
 *
 * They now live behind one quiet "…". Duplicate moved too, even though it is
 * the most frequent of the three: a permanent button on every card is a worse
 * price than one extra click on an occasional action.
 *
 * THE CARD ALSO USED TO LIE. It hover-lifted as though clickable while only
 * its left portion actually was - the <Link> wrapped the info area, not the
 * card. `test_the_menu_does_not_open_the_quiz` and the stretched-link test
 * below are the two halves of fixing that.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizCard } from './QuizCard';
import type { Coach, Folder, Quiz } from '../api/types';

const coach: Coach = {
  id: 1,
  username: 'coach1',
  email: 'c@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'member',
  is_platform_owner: false,
  created_at: '2026-01-01T00:00:00Z',
};

const quiz: Quiz = {
  id: 5,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 3 Prep',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: null,
  question_count: 11,
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
} as Quiz;

const folders: Folder[] = [
  { id: 10, name: 'Fall Camp', parent_folder_id: null } as Folder,
];

function renderCard(overrides: Partial<Quiz> = {}, opts: { folders?: Folder[]; who?: Coach } = {}) {
  const onDuplicate = vi.fn();
  const onDelete = vi.fn();
  const onMoveToFolder = vi.fn();
  render(
    <MemoryRouter>
      <QuizCard
        quiz={{ ...quiz, ...overrides }}
        coach={opts.who ?? coach}
        folders={opts.folders ?? folders}
        onMoveToFolder={onMoveToFolder}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />
    </MemoryRouter>,
  );
  return { onDuplicate, onDelete, onMoveToFolder };
}

const openMenu = (user: ReturnType<typeof userEvent.setup>, title = 'Week 3 Prep') =>
  user.click(screen.getByRole('button', { name: `Actions for ${title}` }));

beforeEach(() => vi.restoreAllMocks());

describe('what a coach sees without asking for anything', () => {
  it('shows the title, the results and nothing to manage', () => {
    renderCard({ completed_count: 14, roster_size: 15, average_score_percent: 95 });

    expect(screen.getByRole('heading', { name: /Week 3 Prep/ })).toBeInTheDocument();
    expect(screen.getByText(/95%/)).toBeInTheDocument();
    expect(screen.getByText(/14\/15/)).toBeInTheDocument();

    // THE POINT OF THE PHASE: none of these is on the card any more.
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByLabelText(/to folder/)).toBeNull();
  });

  it('offers exactly ONE control', () => {
    // Counted rather than described: three permanent controls became one, and
    // a future addition should have to justify itself against this number.
    const { container } = render(
      <MemoryRouter>
        <QuizCard
          quiz={quiz}
          coach={coach}
          folders={folders}
          onMoveToFolder={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll('button, select')).toHaveLength(1);
  });

  it('still says when a quiz is active', () => {
    renderCard({ is_active: true });

    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('keeps the date and question count, quietly', () => {
    renderCard();

    expect(screen.getByText(/11 questions/)).toBeInTheDocument();
    expect(screen.getByText(/updated/)).toBeInTheDocument();
  });
});

describe('opening the quiz', () => {
  it('the card is one link to the quiz', () => {
    renderCard();

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/quizzes/5');
  });

  it('has exactly one link, so the card is one tab stop', () => {
    // Wrapping the card in an anchor would have nested a button inside a
    // link - invalid, and unusable by keyboard. The link is stretched over
    // the card in CSS instead.
    renderCard();

    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('the menu does NOT open the quiz', async () => {
    // The menu sits inside the card the link covers. Without stopping
    // propagation, reaching for Delete would navigate.
    const user = userEvent.setup();
    renderCard();

    await openMenu(user);

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('the actions, once asked for', () => {
  it('duplicates', async () => {
    const user = userEvent.setup();
    const { onDuplicate } = renderCard();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    expect(onDuplicate).toHaveBeenCalledWith(5);
  });

  it('deletes, and is marked as destructive', async () => {
    const user = userEvent.setup();
    const { onDelete } = renderCard();

    await openMenu(user);
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    // The confirmation itself is the caller's, unchanged - this only proves
    // the action still reaches it.
    await user.click(remove);

    expect(onDelete).toHaveBeenCalledWith(5, 'Week 3 Prep');
  });

  it('moves to a folder, keeping the control it always had', async () => {
    const user = userEvent.setup();
    const { onMoveToFolder } = renderCard();

    await openMenu(user);
    await user.selectOptions(screen.getByLabelText('Move "Week 3 Prep" to folder'), '10');

    expect(onMoveToFolder).toHaveBeenCalledWith(5, 10);
  });

  it('choosing a folder does not close the menu out from under the coach', async () => {
    // The first version closed on any click inside the menu, which made the
    // <select> unusable - it shut before a folder could be chosen.
    const user = userEvent.setup();
    renderCard();

    await openMenu(user);
    await user.selectOptions(screen.getByLabelText('Move "Week 3 Prep" to folder'), '10');

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('choosing an action DOES close the menu', async () => {
    const user = userEvent.setup();
    renderCard();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('keyboard and screen readers', () => {
  it('the trigger is named by its quiz, not "More"', () => {
    // Twenty cards would otherwise be twenty identical buttons.
    renderCard();

    expect(screen.getByRole('button', { name: 'Actions for Week 3 Prep' })).toBeInTheDocument();
  });

  it('announces that it opens a menu, and whether it is open', async () => {
    const user = userEvent.setup();
    renderCard();
    const trigger = screen.getByRole('button', { name: 'Actions for Week 3 Prep' });

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await openMenu(user);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens with the keyboard and closes on Escape, returning focus', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.tab();
    await user.tab();
    const trigger = screen.getByRole('button', { name: 'Actions for Week 3 Prep' });
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    // Focus returns to the quiz they were on, not the top of the page.
    expect(trigger).toHaveFocus();
  });

  it('every action is reachable by keyboard', async () => {
    const user = userEvent.setup();
    renderCard();

    await openMenu(user);
    const menu = screen.getByRole('menu');

    expect(within(menu).getAllByRole('menuitem').length).toBeGreaterThanOrEqual(2);
  });
});

describe('permissions are unchanged', () => {
  it("a teammate's quiz can be duplicated but not deleted or moved", async () => {
    const user = userEvent.setup();
    renderCard({ coach_id: 99, created_by_username: 'coach_jones' });

    await openMenu(user);

    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    expect(screen.queryByLabelText(/to folder/)).toBeNull();
  });

  it('an admin can delete a teammate\'s quiz', async () => {
    const user = userEvent.setup();
    renderCard({ coach_id: 99 }, { who: { ...coach, role: 'admin' } });

    await openMenu(user);

    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('offers no move when there are no folders', async () => {
    const user = userEvent.setup();
    renderCard({}, { folders: [] });

    await openMenu(user);

    expect(screen.queryByLabelText(/to folder/)).toBeNull();
    // Duplicate is still there - the absence is about folders, not permissions.
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
  });
});
