/** Q2 - USING A PLAYBOOK PAGE AS A QUESTION'S PICTURE.
 *
 * THE PRODUCT RULE THESE PIN. A coach chooses HOW THE PLAYER ANSWERS and,
 * separately, WHAT THEY SEE. A playbook page is one option for the second and
 * says nothing about the first - which is exactly what the old dedicated route
 * got wrong by turning every playbook question into Fill in the Blank.
 *
 * THE COACH NEVER MEETS OUR VOCABULARY. No test here looks for the words mask,
 * region, crop, role or page id, because none of them appears on screen. The
 * coach sees "or choose from a Playbook" and "Hide something from players".
 *
 * THE SIMPLE PATH HAS NO HIDING IN IT. Choose a playbook, choose a page, done.
 * Hiding is offered afterwards and never required, so
 * `test_the_simple_path_never_asks_about_hiding` is as load-bearing as the
 * tests that exercise it.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionEditor } from './QuestionEditor';
import * as documentsApi from '../../api/documents';

const PLAYBOOK = { id: 7, title: '2026 Defensive Playbook', page_count: 2 };

const PAGES = [
  { id: 71, source_document_id: 7, page_number: 1, thumbnail_url: '/t1.png', aspect_ratio: 0.77 },
  { id: 72, source_document_id: 7, page_number: 2, thumbnail_url: '/t2.png', aspect_ratio: 0.77 },
];

function mockPlaybooks(playbooks = [PLAYBOOK]) {
  vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue(playbooks as never);
  vi.spyOn(documentsApi, 'getDocument').mockResolvedValue({
    ...PLAYBOOK,
    pages: PAGES,
  } as never);
  vi.spyOn(documentsApi, 'getDocumentPage').mockImplementation(
    async (_id: number, pageNumber: number) =>
      ({
        ...PAGES.find((p) => p.page_number === pageNumber),
        image_url: `/full-${pageNumber}.png`,
        render_width: 600,
        render_height: 800,
      }) as never,
  );
}

function renderEditor(props: Record<string, unknown> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <QuestionEditor
      initialText="What coverage is this?"
      initialType="multiple_choice"
      initialOptions={[
        { option_text: 'Cover 2', is_correct_answer: true },
        { option_text: 'Cover 3', is_correct_answer: false },
      ]}
      submitLabel="Save question"
      allowImage
      onSave={onSave}
      onCancel={vi.fn()}
      {...props}
    />,
  );
  return { onSave };
}

const openPicker = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /choose from a playbook/i }));

async function pickPage(user: ReturnType<typeof userEvent.setup>, pageNumber = 1) {
  await openPicker(user);
  // One playbook opens straight to its pages - see PlaybookPicker.
  await user.click(await screen.findByRole('button', { name: `Use page ${pageNumber}` }));
  await screen.findByAltText(
    new RegExp(`page ${pageNumber}$`, 'i'),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the coach who never uses a playbook', () => {
  it('sees the image control exactly as before, plus one line', () => {
    mockPlaybooks();
    renderEditor();

    // The existing ways of supplying a picture are untouched.
    expect(screen.getByText(/paste an image here/i)).toBeInTheDocument();
    expect(screen.getByText(/or drag & drop, or choose a file/i)).toBeInTheDocument();
    // And exactly one thing is new.
    expect(
      screen.getByRole('button', { name: /choose from a playbook/i }),
    ).toBeInTheDocument();
  });

  it('sends a payload with no playbook fields at all', async () => {
    mockPlaybooks();
    const user = userEvent.setup();
    const { onSave } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Save question' }));

    const payload = onSave.mock.calls[0][0];
    expect(payload).not.toHaveProperty('document_page_id');
    expect(payload).not.toHaveProperty('region');
  });

  it('never loads playbooks until asked', () => {
    mockPlaybooks();
    renderEditor();

    // Opening the editor must not cost a request for a feature most questions
    // will not use.
    expect(documentsApi.listDocuments).not.toHaveBeenCalled();
  });
});

describe('choosing a playbook page', () => {
  it('shows the page immediately, in the editor', async () => {
    mockPlaybooks();
    const user = userEvent.setup();
    renderEditor();

    await pickPage(user);

    expect(screen.getByAltText(/2026 Defensive Playbook, page 1/i)).toBeInTheDocument();
    // And it says which page, in the coach's own words.
    expect(screen.getByText(/2026 Defensive Playbook, page 1/i)).toBeInTheDocument();
  });

  it('sends the page and NO hidden rectangle', async () => {
    mockPlaybooks();
    const user = userEvent.setup();
    const { onSave } = renderEditor();

    await pickPage(user);
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    const payload = onSave.mock.calls[0][0];
    expect(payload.document_page_id).toBe(71);
    expect(payload).not.toHaveProperty('region');
  });

  it('the simple path never asks about hiding', async () => {
    // THE DEFAULT THAT MATTERS. A page that gives nothing away needs no
    // decision - the coach picks it and is finished.
    mockPlaybooks();
    const user = userEvent.setup();
    renderEditor();

    await pickPage(user);

    expect(screen.getByText(/2026 Defensive Playbook, page 1/i)).toBeInTheDocument();
    expect(screen.queryByText(/one part hidden/i)).not.toBeInTheDocument();
  });

  it('keeps the question type the coach chose', async () => {
    // The whole point: a picture does not decide how the player answers.
    mockPlaybooks();
    const user = userEvent.setup();
    const { onSave } = renderEditor();

    await pickPage(user);
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    expect(onSave.mock.calls[0][0].question_type).toBe('multiple_choice');
  });

  it('offers exactly two actions, and no way to change page', async () => {
    // A DELIBERATE OMISSION, pinned so it cannot drift back in. Picking the
    // wrong page is an uncommon correction and Remove-then-choose already
    // does it; a third permanent button on every playbook question is the
    // higher price. Optimise the common path, not every possible one.
    mockPlaybooks();
    const user = userEvent.setup();
    renderEditor();

    await pickPage(user);

    expect(
      screen.getByRole('button', { name: /hide something from players/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change page/i })).toBeNull();
    // And no menu or overflow standing in for it either.
    expect(screen.queryByRole('button', { name: /more|options|…/i })).toBeNull();
  });

  it('can be removed again', async () => {
    mockPlaybooks();
    const user = userEvent.setup();
    const { onSave } = renderEditor();

    await pickPage(user);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Save question' }));

    expect(onSave.mock.calls[0][0]).not.toHaveProperty('document_page_id');
  });
});

describe('the words the coach reads', () => {
  it('uses coaching language, never ours', async () => {
    mockPlaybooks();
    const user = userEvent.setup();
    const { container } = { container: document.body };
    renderEditor();

    await pickPage(user);

    const text = container.textContent ?? '';
    for (const ours of ['mask', 'region', 'crop', 'role', 'geometry', 'document_page']) {
      expect(text.toLowerCase()).not.toContain(ours);
    }
    expect(screen.getByRole('button', { name: /hide something from players/i })).toBeInTheDocument();
  });
});

describe('a playbook with several books', () => {
  it('asks which one first', async () => {
    mockPlaybooks([PLAYBOOK, { id: 8, title: 'Special Teams', page_count: 3 }]);
    const user = userEvent.setup();
    renderEditor();

    await openPicker(user);

    expect(await screen.findByText('2026 Defensive Playbook')).toBeInTheDocument();
    expect(screen.getByText('Special Teams')).toBeInTheDocument();
  });
});
