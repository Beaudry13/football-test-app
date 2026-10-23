import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/retests', () => ({ createRetest: vi.fn() }));
import * as retestsApi from '../../api/retests';
import { WeakestConcepts } from './WeakestConcepts';
import type { ConceptBreakdown, Question } from '../../api/types';

/**
 * PROBLEM -> TEACH -> RETEST, without leaving the teaching screen: Teach on
 * Results says who missed it ("6 of 10 missed it", names), offers Retest these
 * 6 (the same draft, opened ready to send), and Next walks to the next problem
 * - the next concept the team missed - in the same screen.
 */

let landed = '';
function Landed() {
  const l = useLocation();
  landed = `${l.pathname}${l.search}`;
  return <div>EDITOR</div>;
}

const concept = (id: number, name: string, over: Partial<ConceptBreakdown> = {}): ConceptBreakdown => ({
  concept_id: id,
  concept_name: name,
  question_count: 1,
  correct_count: 4,
  incorrect_count: 6,
  ungraded_count: 0,
  graded_count: 10,
  miss_rate: 60,
  players_missed_count: 2,
  players_responded_count: 10,
  player_miss_rate: 20,
  retestable_question_count: 1,
  retired_missed_question_count: 0,
  has_enough_responses: true,
  players_missed: [
    { player_id: 3, player_name: 'Ty Adams', display_name: 'Ty Adams', jersey_number: null, position_at_attempt: 'S' },
    { player_id: 4, player_name: 'Bo Brown', display_name: 'Bo Brown', jersey_number: null, position_at_attempt: 'FS' },
  ] as unknown as ConceptBreakdown['players_missed'],
  top_distractor: null,
  ...over,
});
const question = (id: number, conceptId: number, text: string) =>
  ({
    id,
    quiz_id: 9,
    question_text: text,
    question_type: 'multiple_choice',
    position: id,
    concept: { id: conceptId, name: '', is_archived: false },
    image: { id, question_id: id, image_url: `/uploads/${id}.png`, annotations: null, canvas_width: null, updated_at: '' },
    options: [
      { id: id * 10, question_id: id, option_text: 'Right', position: 0, is_correct_answer: true },
      { id: id * 10 + 1, question_id: id, option_text: 'Wrong', position: 1, is_correct_answer: false },
    ],
    answer_explanation: `Why ${id}`,
  }) as unknown as Question;

const CONCEPTS = [concept(1, 'Force / Contain', { player_miss_rate: 60 }), concept(2, 'Run fit'), concept(3, 'Cover 3', { players_missed_count: 0, players_missed: [] })];
const QUESTIONS = [question(7, 1, 'Who has force on toss?'), question(8, 2, 'Where is your fit?'), question(9, 3, 'Who has the deep third?')];

function open(teachConceptId: number | null = null) {
  render(
    <MemoryRouter initialEntries={['/quizzes/9']}>
      <Routes>
        <Route path="/quizzes/9" element={<WeakestConcepts concepts={CONCEPTS} quizId={9} questions={QUESTIONS} teachConceptId={teachConceptId} />} />
        <Route path="/quizzes/:id" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  landed = '';
  vi.mocked(retestsApi.createRetest).mockResolvedValue({ id: 42 } as never);
});

describe('Results: problem -> teach -> retest -> next', () => {
  it('Teach says who missed it, and Next walks to the next problem in the same screen', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Teach it' }));
    let teach = within(screen.getByRole('dialog', { name: 'Teach Force / Contain' }));
    expect(teach.getByText('2 of 10 missed it')).toBeInTheDocument();
    expect(teach.getByText('Ty Adams, Bo Brown')).toBeInTheDocument();
    expect(teach.getByText('Who has force on toss?')).toBeInTheDocument();

    fireEvent.click(teach.getByRole('button', { name: /Next: Run fit · 2 missed/ }));
    teach = within(screen.getByRole('dialog', { name: 'Teach Run fit' }));
    expect(teach.getByText('Where is your fit?')).toBeInTheDocument();
    // Cover 3 nobody missed: it is not a thing to teach, so Run fit is the last.
    expect(teach.queryByRole('button', { name: /Next:/ })).toBeNull();
  });

  it('→ past the last slide is the next problem too', () => {
    open(1);
    const dialog = screen.getByRole('dialog', { name: 'Teach Force / Contain' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'Teach Run fit' })).toBeInTheDocument();
  });

  it('Retest from Teach: exactly who missed it, opened ready to send', async () => {
    open(2);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Teach Run fit' })).getByRole('button', { name: 'Retest these 2' }));
    await waitFor(() => expect(retestsApi.createRetest).toHaveBeenCalledWith(9, { concept_id: 2, player_ids: [3, 4], player_names: [] }));
    await screen.findByText('EDITOR');
    expect(landed).toBe('/quizzes/42?tab=activate');
  });

  it('a row\'s Teach opens the same screen on that concept', () => {
    open();
    const row = screen.getByText('Run fit').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Teach' }));
    expect(screen.getByRole('dialog', { name: 'Teach Run fit' })).toBeInTheDocument();
  });
});
