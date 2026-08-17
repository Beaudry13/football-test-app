/** Draw Response Phase B - WHEN THE PLAYER IS TOLD THEIR DRAWING CHANGED.
 *
 * The message exists for exactly one situation: a newer drawing saved on
 * another device replaced work this device still had locally. Every other
 * resume outcome is either normal or invisible to the player, and showing the
 * notice there would teach them to ignore it.
 *
 * The precedence rule itself is unit-tested in resumeDrawing.test.ts. These
 * tests are about what the PLAYER sees.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizStep } from './QuizStep';
import { ACTIVE_EDIT_CONFLICT_MESSAGE, DRAWING_RESTORED_MESSAGE } from './resumeDrawing';
import { saveDrawing } from '../../api/play';
import { draftKey, loadDraft } from './drawingDraft';
import type { Question, Quiz, ResumedAnswer } from '../../api/types';

vi.mock('../../api/play', () => ({
  checkAnswer: vi.fn(),
  saveAnswer: vi.fn().mockResolvedValue(undefined),
  saveDrawing: vi.fn().mockResolvedValue({ revision: 1 }),
  submitQuiz: vi.fn(),
}));

const IMAGE_ID = 77;
const QUESTION_ID = 1;
const SCOPE = '5:Jordan Smith';

const drawingDoc = (label: string, imageId: number = IMAGE_ID) => ({
  format: 'peira.drawing',
  version: 1,
  source: {
    image_id: String(imageId),
    image_version: null,
    natural_width: 1200,
    natural_height: 800,
  },
  coordinate_width: 1200,
  coordinate_height: 800,
  strokes: [
    { id: label, tool: 'pen', color: '#f00', width: 4, points: [1, 2, 3, 4], order: 0 },
  ],
});

const question = (): Question =>
  ({
    id: QUESTION_ID,
    quiz_id: 9,
    question_text: 'Draw the FS rotation',
    question_type: 'draw_response',
    position: 0,
    options: [],
    image: {
      id: IMAGE_ID,
      question_id: QUESTION_ID,
      image_url: '/film.png',
      canvas_width: 1200,
      annotations: [],
    },
  }) as unknown as Question;

function renderStep(initialAnswers: ResumedAnswer[]) {
  const quiz = { id: 9, title: 'Install', questions: [question()] } as unknown as Quiz;
  return render(
    <QuizStep
      quiz={quiz}
      accessCodeId={5}
      playerName="Jordan Smith"
      playerId={undefined}
      initialAnswers={initialAnswers}
      initialFeedback={[]}
      onSubmitted={vi.fn()}
    />,
  );
}

const serverAnswer = (revision: number, label = 'from-server'): ResumedAnswer => ({
  question_id: QUESTION_ID,
  selected_option_id: null,
  answer_text: null,
  checked: false,
  drawing: { document: drawingDoc(label), revision },
});

function writeDraft(baseRevision: number | null, label = 'local', imageId = IMAGE_ID) {
  window.localStorage.setItem(
    draftKey(SCOPE, QUESTION_ID),
    JSON.stringify({ document: drawingDoc(label, imageId), base_revision: baseRevision }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // Without this the saveDrawing spy accumulates across tests, and the
  // "does NOT save" assertions fail on a call made by an earlier test.
  vi.clearAllMocks();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('the draft fixture itself', () => {
  // Kept from the debugging pass. When the banner tests failed, this is what
  // ruled out the storage layer in one step - and it stops a future change to
  // the draft envelope from being mis-read as a broken resume rule.
  it('writes a draft that loadDraft can read back', () => {
    writeDraft(1);

    const key = draftKey(SCOPE, QUESTION_ID);
    expect(window.localStorage.getItem(key)).not.toBeNull();

    const loaded = loadDraft(key);
    expect(loaded).not.toBeNull();
    expect(loaded?.base_revision).toBe(1);
    expect(loaded?.document.source.image_id).toBe(String(IMAGE_ID));
  });
});

describe('the message IS shown', () => {
  it('when a newer server drawing replaced local work', async () => {
    writeDraft(1);

    renderStep([serverAnswer(2)]);

    expect(await screen.findByText(DRAWING_RESTORED_MESSAGE)).toBeInTheDocument();
  });

  it('when the local draft cannot prove where it came from', async () => {
    // A pre-Phase-B draft, or one written before any save succeeded. The
    // server wins, and the player still lost visible local work.
    writeDraft(null);

    renderStep([serverAnswer(3)]);

    expect(await screen.findByText(DRAWING_RESTORED_MESSAGE)).toBeInTheDocument();
  });

  it('is informational rather than an error', () => {
    writeDraft(1);

    renderStep([serverAnswer(2)]);

    // role=status, not alert: nothing has gone wrong, and the drawing was
    // recovered correctly.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('avoids technical vocabulary', () => {
    writeDraft(1);

    renderStep([serverAnswer(2)]);

    const text = screen.getByRole('status').textContent ?? '';
    expect(text).not.toMatch(/revision|conflict|sync|error/i);
  });

  it('can be dismissed, and does not block the question', async () => {
    const user = userEvent.setup();
    writeDraft(1);
    renderStep([serverAnswer(2)]);

    await user.click(screen.getByRole('button', { name: 'Got it' }));

    expect(screen.queryByText(DRAWING_RESTORED_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByText('Draw the FS rotation')).toBeInTheDocument();
  });
});

describe('the message is NOT shown', () => {
  it('when there is no local draft at all', () => {
    renderStep([serverAnswer(4)]);

    expect(screen.queryByText(DRAWING_RESTORED_MESSAGE)).not.toBeInTheDocument();
  });

  it('when the local draft continues the current server revision', () => {
    // Unsaved strokes on top of exactly what the server holds. The draft WINS,
    // so nothing was replaced and there is nothing to explain.
    writeDraft(2);

    renderStep([serverAnswer(2)]);

    expect(screen.queryByText(DRAWING_RESTORED_MESSAGE)).not.toBeInTheDocument();
  });

  it('when nothing is saved on the server and the local draft wins', () => {
    writeDraft(null);

    renderStep([]);

    expect(screen.queryByText(DRAWING_RESTORED_MESSAGE)).not.toBeInTheDocument();
  });

  it('when a draft is discarded for belonging to a different image', () => {
    // It was never work for THIS question, so there is nothing to apologise
    // for - telling the player would just confuse them.
    writeDraft(1, 'other-image', 999);

    renderStep([serverAnswer(2)]);

    expect(screen.queryByText(DRAWING_RESTORED_MESSAGE)).not.toBeInTheDocument();
  });

  it('when there is neither a draft nor a server drawing', () => {
    renderStep([]);

    expect(screen.queryByText(DRAWING_RESTORED_MESSAGE)).not.toBeInTheDocument();
  });
});


describe('recovered local work is SAVED, not just shown', () => {
  it('pushes a local-only draft back to the server', async () => {
    // Gate 2: the autosave never got through before. Restoring it on screen
    // and leaving it there would keep the work trapped on one device, which is
    // the exact failure this phase exists to fix.
    writeDraft(null);

    renderStep([]);

    // The drawing autosave is deliberately debounced far longer than the
    // text one, so this needs more than waitFor's default second.
    await waitFor(() => expect(saveDrawing).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(vi.mocked(saveDrawing).mock.calls[0][0]).toMatchObject({
      question_id: QUESTION_ID,
      base_revision: null,
    });
  });

  it('pushes an unsaved continuation using the revision it continued from', async () => {
    // Gate 4: the draft is server revision 2 plus strokes that never left the
    // device. Saving against 2 is what makes the server accept it as 3 rather
    // than refusing it as stale.
    writeDraft(2);

    renderStep([serverAnswer(2)]);

    // The drawing autosave is deliberately debounced far longer than the
    // text one, so this needs more than waitFor's default second.
    await waitFor(() => expect(saveDrawing).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(vi.mocked(saveDrawing).mock.calls[0][0]).toMatchObject({
      question_id: QUESTION_ID,
      base_revision: 2,
    });
  });

  it('does NOT save the server drawing straight back to itself', async () => {
    // The server already has this exact document. Re-saving it would burn a
    // revision and could lose a genuine save racing from another device.
    renderStep([serverAnswer(4)]);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(saveDrawing).not.toHaveBeenCalled();
  });

  it('does NOT save a draft discarded for belonging to another image', async () => {
    writeDraft(1, 'other-image', 999);

    renderStep([serverAnswer(2)]);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(saveDrawing).not.toHaveBeenCalled();
  });
});

describe('the two multi-device messages', () => {
  it('share an opening sentence', () => {
    const opening = 'Your drawing was updated on another device.';

    expect(DRAWING_RESTORED_MESSAGE.startsWith(opening)).toBe(true);
    expect(ACTIVE_EDIT_CONFLICT_MESSAGE.startsWith(opening)).toBe(true);
  });

  it('describe DIFFERENT outcomes, because the outcomes are different', () => {
    // Resume: the server version replaced local work.
    expect(DRAWING_RESTORED_MESSAGE).toMatch(/latest saved version has been restored/i);
    // Active editing: the player's drawing is still on screen and still wins.
    expect(ACTIVE_EDIT_CONFLICT_MESSAGE).toMatch(/current changes are still here/i);
    expect(ACTIVE_EDIT_CONFLICT_MESSAGE).not.toMatch(/restored/i);
  });

  it('avoid technical vocabulary in both', () => {
    for (const message of [DRAWING_RESTORED_MESSAGE, ACTIVE_EDIT_CONFLICT_MESSAGE]) {
      expect(message).not.toMatch(/revision|conflict|409|sync|error/i);
    }
  });
});
