import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotationPage } from './AnnotationPage';
import * as quizzesApi from '../../api/quizzes';
import * as questionsApi from '../../api/questions';
import type { Quiz } from '../../api/types';

const quizWithNoImage: Quiz = {
  id: 1,
  coach_id: 1,
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: false,
  question_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  questions: [
    {
      id: 5,
      quiz_id: 1,
      question_text: 'Circle the mike backer',
      question_type: 'written',
      position: 0,
      options: [],
      image: null,
    },
  ],
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/quizzes/1/questions/5/annotate']}>
      <Routes>
        <Route path="/quizzes/:quizId/questions/:questionId/annotate" element={<AnnotationPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function dispatchPasteWithFile(file: File | null) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { items: file ? [{ type: file.type, getAsFile: () => file }] : [] },
  });
  document.dispatchEvent(event);
}

describe('AnnotationPage image upload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(quizWithNoImage);
  });

  afterEach(() => {
    // @ts-expect-error - test-only cleanup of a property we defined
    delete navigator.clipboard;
  });

  it('uploads a screenshot pasted with Ctrl+V', async () => {
    const uploadSpy = vi.spyOn(questionsApi, 'uploadQuestionImage').mockResolvedValue({
      id: 1,
      question_id: 5,
      image_url: '/uploads/x.png',
      annotations: [],
      updated_at: '2026-01-01T00:00:00Z',
    });
    renderPage();
    await screen.findByText('Add a film still');

    const file = new File(['fake-bytes'], 'image.png', { type: 'image/png' });
    dispatchPasteWithFile(file);

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(1, 5, file));
  });

  it('ignores a paste with no image on the clipboard', async () => {
    const uploadSpy = vi.spyOn(questionsApi, 'uploadQuestionImage');
    renderPage();
    await screen.findByText('Add a film still');

    dispatchPasteWithFile(null);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('uploads via the Paste image button using the Clipboard API', async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.spyOn(questionsApi, 'uploadQuestionImage').mockResolvedValue({
      id: 1,
      question_id: 5,
      image_url: '/uploads/x.png',
      annotations: [],
      updated_at: '2026-01-01T00:00:00Z',
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ['image/png'],
            getType: vi.fn().mockResolvedValue(new Blob(['fake-bytes'], { type: 'image/png' })),
          },
        ]),
      },
      configurable: true,
    });
    renderPage();
    await screen.findByText('Add a film still');

    await user.click(screen.getByRole('button', { name: 'Paste image' }));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    const [quizId, questionId, uploadedFile] = uploadSpy.mock.calls[0];
    expect(quizId).toBe(1);
    expect(questionId).toBe(5);
    expect(uploadedFile.name).toBe('pasted.png');
  });

  it('shows an error when the clipboard has no image', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { read: vi.fn().mockResolvedValue([{ types: ['text/plain'], getType: vi.fn() }]) },
      configurable: true,
    });
    renderPage();
    await screen.findByText('Add a film still');

    await user.click(screen.getByRole('button', { name: 'Paste image' }));

    expect(await screen.findByText(/No image found on the clipboard/)).toBeInTheDocument();
  });

  it('still supports choosing a file from disk', async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.spyOn(questionsApi, 'uploadQuestionImage').mockResolvedValue({
      id: 1,
      question_id: 5,
      image_url: '/uploads/x.png',
      annotations: [],
      updated_at: '2026-01-01T00:00:00Z',
    });
    renderPage();
    await screen.findByText('Add a film still');

    const file = new File(['fake-bytes'], 'play.png', { type: 'image/png' });
    const input = screen.getByLabelText('Choose image', { exact: false }) as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(1, 5, file));
  });
});
