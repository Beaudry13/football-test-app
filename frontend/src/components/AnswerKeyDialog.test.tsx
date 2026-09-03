import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AnswerKeyDialog } from './AnswerKeyDialog';
import type { Quiz } from '../api/types';

/** Picking tests for one cumulative answer key.
 *
 * The rule worth pinning here is what this dialog is NOT: it asks for quizzes
 * and nothing else. No player, no attempt, no score is requested or shown, so
 * a coach reaching for the test they wrote cannot be handed their squad's
 * performance by accident.
 */

const exportAnswerKeyPdf = vi.fn();
const downloadBlob = vi.fn();

vi.mock('../api/quizzes', () => ({
  exportAnswerKeyPdf: (...args: unknown[]) => exportAnswerKeyPdf(...args),
}));
vi.mock('../utils/download', () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}));

const quizzes = [
  { id: 7, title: 'Cover 3 Test' },
  { id: 9, title: 'Red Zone Test' },
] as unknown as Quiz[];

function renderDialog(list: Quiz[] = quizzes) {
  const onClose = vi.fn();
  const { container } = render(<AnswerKeyDialog quizzes={list} onClose={onClose} />);
  return { onClose, container };
}

describe('AnswerKeyDialog', () => {
  it('lists the quizzes a coach can export', () => {
    renderDialog();
    expect(screen.getByText('Cover 3 Test')).toBeInTheDocument();
    expect(screen.getByText('Red Zone Test')).toBeInTheDocument();
  });

  it('will not export until something is chosen', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /download answer key/i })).toBeDisabled();
  });

  it('exports exactly the quizzes that were ticked', async () => {
    exportAnswerKeyPdf.mockResolvedValue(new Blob(['pdf']));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('checkbox', { name: /red zone test/i }));
    await user.click(screen.getByRole('button', { name: /download answer key/i }));

    await waitFor(() => expect(exportAnswerKeyPdf).toHaveBeenCalledWith([9]));
    expect(downloadBlob).toHaveBeenCalled();
  });

  it('select all takes every quiz', async () => {
    exportAnswerKeyPdf.mockResolvedValue(new Blob(['pdf']));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /download answer key/i }));

    await waitFor(() => expect(exportAnswerKeyPdf).toHaveBeenCalledWith([7, 9]));
  });

  it('says what will be left out, so the omission is not a surprise', () => {
    // Excluded questions vanish from the PDF entirely. A coach who did not
    // expect that would think the export had lost something.
    renderDialog();
    // `.` rather than an apostrophe: the copy uses a typographic one.
    expect(screen.getByText(/don.t count/i)).toBeInTheDocument();
  });

  it('asks for nothing about players', () => {
    const { container } = renderDialog();
    const text = container.textContent ?? '';
    for (const word of ['Player', 'Score', 'Result', 'Attempt', '%']) {
      expect(text).not.toContain(word);
    }
  });

  it('reports a failure instead of closing silently', async () => {
    exportAnswerKeyPdf.mockRejectedValue(new Error('server said no'));
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /download answer key/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('copes with a coach who has no quizzes yet', () => {
    renderDialog([]);
    expect(screen.getByText(/no quizzes yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download answer key/i })).toBeDisabled();
  });
});
