import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quiz } from '../../api/types';

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  updateQuestion: vi.fn(),
  retireQuestion: vi.fn().mockResolvedValue({}),
  restoreQuestion: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../api/motionLab', () => ({ listMotionPlays: vi.fn() }));
// jsdom cannot draw; the picture is playImage's business.
vi.mock('../../motion-lab/playImage', () => ({
  IMAGE_WIDTH: 1376,
  IMAGE_HEIGHT: 720,
  drawPlay: vi.fn(),
  playImage: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}));
import * as questionsApi from '../../api/questions';
import * as motionApi from '../../api/motionLab';
import * as authModule from '../../auth/AuthContext';
import { QuestionsTab } from './QuestionsTab';
import { newPlay, type Play } from '../../motion-lab/engine/play';
import { toDocument } from '../../motion-lab/storage/apiPlayRepository';

/**
 * QUIZ -> MOTION LAB. A coach who has Motion Lab can add a question straight
 * from one of his saved plays: the picker shows each play with the questions it
 * can become, and one click adds it through the quiz editor's own create path,
 * picture and all. Coaches without Motion Lab never see the offer.
 */

const quiz = { id: 500, title: 'Week 3', questions: [], question_count: 0 } as unknown as Quiz;
const jetDig = { ...newPlay('Jet Dig'), ball: { kind: 'pass' as const, targetId: 'O8', catchPoint: { x: 17, y: 11 } } };
const runPlay = newPlay('Inside Zone');
const row = (id: number, play: Play, updated: string) => ({
  id,
  name: play.name,
  document: toDocument(play),
  schema_version: 3,
  revision: 1,
  folder_id: null,
  copied_from_play_id: null,
  created_by_coach_id: 1,
  created_at: updated,
  updated_at: updated,
});

function open(owner: boolean | 'no-auth') {
  if (owner !== 'no-auth') vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: owner } } as never);
  const reload = vi.fn(async () => undefined);
  render(
    <MemoryRouter>
      <QuestionsTab quiz={quiz} reload={reload} />
    </MemoryRouter>,
  );
  return reload;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(questionsApi.createQuestion).mockReset().mockResolvedValue({ id: 900, image: null } as never);
  vi.mocked(motionApi.listMotionPlays).mockReset().mockResolvedValue([row(14, jetDig, '2026-10-10T00:00:00Z'), row(15, runPlay, '2026-10-01T00:00:00Z')] as never);
});

describe('From Motion Lab, in the quiz editor', () => {
  it('adds "Who gets the ball?" from a saved play, picture and all, through the quiz\'s own create path', async () => {
    const reload = open(true);
    fireEvent.click(screen.getByRole('button', { name: 'From Motion Lab' }));
    const list = within(await screen.findByRole('list', { name: 'Motion Lab plays' }));
    await waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(2));
    // Most recent first; a play that gives nobody the ball offers only the Draw question.
    expect(list.getAllByRole('listitem').map((li) => li.querySelector('span')!.textContent)).toEqual(['Jet Dig', 'Inside Zone']);
    expect(list.queryByRole('button', { name: 'Who gets the ball: Inside Zone' })).toBeNull()
    fireEvent.click(list.getByRole('button', { name: 'Who gets the ball: Jet Dig' }));
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled());
    const [quizId, input, image] = vi.mocked(questionsApi.createQuestion).mock.calls[0];
    expect(quizId).toBe(500);
    expect(input).toMatchObject({ question_type: 'multiple_choice', question_text: 'Who gets the ball on this play?' });
    expect(input.options.filter((o) => o.is_correct_answer).map((o) => o.option_text)).toEqual(['X']);
    expect((image as File).type).toBe('image/png');
    await waitFor(() => expect(reload).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Motion Lab plays' })).toBeNull());
  });

  it('adds "Draw your assignment" as a Draw question', async () => {
    open(true);
    fireEvent.click(screen.getByRole('button', { name: 'From Motion Lab' }));
    const list = within(await screen.findByRole('list', { name: 'Motion Lab plays' }));
    fireEvent.click(await list.findByRole('button', { name: 'Draw your assignment: Inside Zone' }));
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled());
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0];
    expect(input).toEqual({ question_text: 'Draw your assignment on this play.', question_type: 'draw_response', options: [], motion_play_id: 15 });
  });

  it('a play with pre-snap motion plays it before the player draws, frozen at the snap', async () => {
    const jet = newPlay('Jet Sweep');
    const h = jet.players.find((p) => p.label === 'H')!;
    h.motion = [{ x: h.x, y: h.y }, { x: h.x - 14, y: h.y }];
    vi.mocked(motionApi.listMotionPlays).mockResolvedValue([row(16, jet, '2026-10-12T00:00:00Z')] as never);
    open(true);
    fireEvent.click(screen.getByRole('button', { name: 'From Motion Lab' }));
    const list = within(await screen.findByRole('list', { name: 'Motion Lab plays' }));
    expect(await list.findByText('· motion plays')).toBeInTheDocument();
    fireEvent.click(list.getByRole('button', { name: 'Draw your assignment: Jet Sweep' }));
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled());
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0];
    expect(input.motion_play_id).toBe(16);
    const clip = input.presnap as { freeze?: string; players: { id: string; motion?: unknown }[] };
    expect(clip.freeze).toBeUndefined();
    expect(clip.players.find((p) => p.id === h.id)!.motion).toBeTruthy();
  });

  it('a question that plays its motion says so in the list - and when it stops', () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    const moving = {
      ...quiz,
      question_count: 1,
      questions: [
        {
          id: 1,
          quiz_id: 500,
          question_text: 'Who has the flat?',
          question_type: 'multiple_choice',
          position: 0,
          options: [],
          image: null,
          concept: null,
          presnap: { v: 1, situation: {}, highlight: null, players: [], freeze: 'mid' },
        },
      ],
    } as unknown as Quiz;
    render(
      <MemoryRouter>
        <QuestionsTab quiz={moving} reload={vi.fn(async () => undefined)} />
      </MemoryRouter>,
    );
    expect(screen.getByText('▶ Motion · Mid-motion')).toBeInTheDocument();
  });

  it('is not offered to a coach without Motion Lab', () => {
    open(false);
    expect(screen.queryByRole('button', { name: 'From Motion Lab' })).toBeNull();
  });

  it('is not offered when there is no signed-in coach to ask', () => {
    open('no-auth');
    expect(screen.queryByRole('button', { name: 'From Motion Lab' })).toBeNull();
    expect(screen.getByRole('button', { name: '+ Add question' })).toBeInTheDocument();
  });
});
