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
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: false,
  require_all_answers: false,
  folder_id: null,
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resizes and re-encodes a large pasted image before uploading', async () => {
    const uploadSpy = vi.spyOn(questionsApi, 'uploadQuestionImage').mockResolvedValue({
      id: 1,
      question_id: 5,
      image_url: '/uploads/x.png',
      annotations: [],
      canvas_width: null,
      updated_at: '2026-01-01T00:00:00Z',
    });
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(quizWithNoImage);

    const fakeBitmap = { width: 4000, height: 3000, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(fakeBitmap));
    const fakeBlob = new Blob(['resized'], { type: 'image/jpeg' });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(fakeBlob));

    renderPage();
    await screen.findByText('Add a film still');

    const largeFile = new File([new Uint8Array(6 * 1024 * 1024)], 'huge.png', { type: 'image/png' });
    dispatchPasteWithFile(largeFile);

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    const [, , uploadedFile] = uploadSpy.mock.calls[0];
    expect(uploadedFile.name).toBe('huge.jpg');
    expect(uploadedFile.type).toBe('image/jpeg');
  });

  it('uploads a small pasted image unchanged, without resizing', async () => {
    const uploadSpy = vi.spyOn(questionsApi, 'uploadQuestionImage').mockResolvedValue({
      id: 1,
      question_id: 5,
      image_url: '/uploads/x.png',
      annotations: [],
      canvas_width: null,
      updated_at: '2026-01-01T00:00:00Z',
    });
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(quizWithNoImage);
    const createBitmapSpy = vi.fn();
    vi.stubGlobal('createImageBitmap', createBitmapSpy);

    renderPage();
    await screen.findByText('Add a film still');

    const smallFile = new File(['tiny'], 'small.png', { type: 'image/png' });
    dispatchPasteWithFile(smallFile);

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(1, 5, smallFile));
    expect(createBitmapSpy).not.toHaveBeenCalled();
  });

  it('uploads a screenshot pasted with Ctrl+V', async () => {
    const uploadSpy = vi.spyOn(questionsApi, 'uploadQuestionImage').mockResolvedValue({
      id: 1,
      question_id: 5,
      image_url: '/uploads/x.png',
      annotations: [],
      canvas_width: null,
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
      canvas_width: null,
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
      canvas_width: null,
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
