/** A CLIP QUESTION, FROM THE COACH'S SIDE OF THE DESK.
 *
 * Three things were missing once a clip existed on a question:
 *
 *  - it was INVISIBLE AS VIDEO. The list rendered the poster as a bare image,
 *    identical to an uploaded film still, so a coach scanning twenty questions
 *    could not tell which ones carried film.
 *  - it was UNWATCHABLE. The only way to see the take you had attached was to
 *    preview the entire quiz as a player.
 *  - it was UNREPLACEABLE. The menu offered Remove and nothing else, so a
 *    better take meant deleting the current one FIRST and re-recording from
 *    nothing - with the old one already gone if the second attempt went badly.
 *    The backend had replaced in a single call the whole time.
 *
 * These are written against the payload the API actually returns, not against
 * markup, and they also pin the boundary that must not move: the coach's
 * surfaces resolve the LIVE clip through the coach media path, while a
 * delivered attempt resolves its frozen snapshot. Rendering both with the same
 * component must never merge the two.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QuestionsTab } from './QuestionsTab';
import type { Question, Quiz } from '../../api/types';

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  updateQuestion: vi.fn(),
  retireQuestion: vi.fn().mockResolvedValue({}),
  restoreQuestion: vi.fn().mockResolvedValue({}),
  uploadQuestionClip: vi.fn().mockResolvedValue({}),
  deleteQuestionClip: vi.fn().mockResolvedValue({}),
}));

const COACH_CLIP_URL = '/api/media/v1.coach-token-for-clip-77';
const COACH_POSTER_URL = '/api/media/v1.coach-poster-token-for-clip-77';

/** Shaped from a real payload: what GET /api/quizzes/:id returns for a
 *  question a coach recorded a clip onto. The URLs are minted for the COACH
 *  audience against the live clip row. */
const withClip = (over: Partial<Question> = {}): Question =>
  ({
    id: 77,
    quiz_id: 500,
    question_text: 'What happens after the motion?',
    question_type: 'written',
    position: 0,
    options: [],
    image: null,
    needs_image: false,
    clip: {
      id: 9,
      question_id: 77,
      content_type: 'video/mp4',
      duration_ms: 8000,
      width: 1280,
      height: 720,
      has_poster: true,
      url: COACH_CLIP_URL,
      poster_url: COACH_POSTER_URL,
    },
    ...over,
  }) as unknown as Question;

const withUploadedImage = (over: Partial<Question> = {}): Question =>
  ({
    id: 12,
    quiz_id: 500,
    question_text: 'Who has the flat?',
    question_type: 'true_false',
    position: 1,
    options: [],
    image: { id: 3, question_id: 12, image_url: '/uploads/play.jpg', annotations: [] },
    needs_image: false,
    ...over,
  }) as unknown as Question;

function renderTab(questions: Question[]) {
  const quiz = { id: 500, title: 'Coverage Responsibility', questions } as unknown as Quiz;
  return render(
    <MemoryRouter initialEntries={['/quizzes/500']}>
      <Routes>
        <Route
          path="/quizzes/500"
          element={<QuestionsTab quiz={quiz} reload={vi.fn().mockResolvedValue(undefined)} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** The same handle the retirement tests use - the menu is labelled by the
 *  question's position, not by its text. */
async function openQuestionMenu(n = 1) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: `More actions for question ${n}` }));
  return user;
}

describe('a clip question in the coach list', () => {
  it('is identifiable as VIDEO, by its length', () => {
    // A poster alone is indistinguishable from an uploaded still. A timecode
    // says "this moves" AND says how long - two facts for one small chip,
    // where a "VIDEO" label would say less and shout more.
    renderTab([withClip()]);
    expect(screen.getByText('0:08')).toBeInTheDocument();
  });

  it('still shows the poster still', () => {
    renderTab([withClip()]);
    const poster = screen.getByAltText('Still frame from the recorded clip');
    expect(poster.getAttribute('src')).toContain(COACH_POSTER_URL);
  });

  it('does NOT autoplay a wall of video', () => {
    // Twenty questions is twenty simultaneous decodes on a surface that is
    // scanned rather than watched.
    const { container } = renderTab([withClip(), withClip({ id: 78 }), withClip({ id: 79 })]);
    expect(container.querySelectorAll('video')).toHaveLength(0);
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
  });

  it('says nothing about length when the duration was never recorded', () => {
    // Older clips may carry no duration. A chip reading "0:00" would be worse
    // than no chip.
    renderTab([withClip({ clip: { ...withClip().clip, duration_ms: null } } as Partial<Question>)]);
    expect(screen.queryByText('0:00')).toBeNull();
  });

  it('leaves an ordinary film still alone', () => {
    renderTab([withUploadedImage()]);
    expect(screen.queryByText(/^\d+:\d\d$/)).toBeNull();
    expect(screen.getByAltText('Question film')).toBeInTheDocument();
  });
});

describe('watching, replacing and removing a clip', () => {
  it('offers all three deliberate actions', async () => {
    renderTab([withClip()]);
    await openQuestionMenu();

    expect(screen.getByText('Watch clip')).toBeInTheDocument();
    expect(screen.getByText('Replace clip')).toBeInTheDocument();
    expect(screen.getByText('Remove clip')).toBeInTheDocument();
  });

  it('plays the clip through the COACH media path, not a player one', async () => {
    renderTab([withClip()]);
    const user = await openQuestionMenu();
    await user.click(screen.getByText('Watch clip'));

    // A real video appears only once the coach asks for it. Queried from the
    // document rather than the render container - the modal is a portal.
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video).toBeTruthy();
    // It resolves the LIVE clip through the coach's own signed URL. A
    // delivered attempt resolves its frozen snapshot instead, and the two
    // paths must never merge.
    expect(video.getAttribute('src')).toContain(COACH_CLIP_URL);
    expect(video.getAttribute('poster')).toContain(COACH_POSTER_URL);

    // AND IT HAS ORDINARY CONTROLS, unlike the player's copy. The coach is
    // choosing a frame, which means scrubbing through the whole clip -
    // including the part a player will never see. Handing them the player
    // component here would stop the film at the very moment they are trying
    // to pick.
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('lets the coach set the decision point from the frame on screen', async () => {
    renderTab([withClip()]);
    const user = await openQuestionMenu();
    await user.click(screen.getByText('Watch clip'));

    expect(screen.getByRole('button', { name: /set decision point/i })).toBeInTheDocument();
    // Nothing is set yet, so the clip is described honestly as an ordinary one.
    expect(screen.getByText(/plays the whole clip on a loop/i)).toBeInTheDocument();
  });

  it('opens the recorder when the coach chooses Replace', async () => {
    renderTab([withClip()]);
    const user = await openQuestionMenu();
    await user.click(screen.getByText('Replace clip'));

    // The SAME Record Clip workflow, reused rather than duplicated - and it
    // uploads over the existing clip in one call, so there is no window where
    // the question has no film.
    //
    // Asserted by the recorder's own dialog rather than by its Start button:
    // jsdom has no MediaRecorder, so ClipRecorder correctly renders its
    // unsupported state here. What matters is that Replace routes into the
    // recorder at all rather than into a delete.
    expect(
      screen.getByRole('dialog', { name: /record a clip for this question/i }),
    ).toBeInTheDocument();
  });

  it('does not offer Record clip when a clip already exists', async () => {
    // Replace is the honest verb once there is something to replace.
    renderTab([withClip()]);
    await openQuestionMenu();
    expect(screen.queryByText('Record clip')).toBeNull();
  });
});
