import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, getDocumentPage, getPageTextRuns } from '../../api/documents';
import type {
  DocumentPage as PageModel,
  SourceDocumentWithPages,
  TextRun,
} from '../../api/documents';
import { createRegionQuestion, deleteQuestion, updateRegionQuestion } from '../../api/questions';
import { getQuiz, listQuizzes } from '../../api/quizzes';
import type { Question, Quiz } from '../../api/types';
import { resolveMediaUrl, getErrorMessage } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { RegionDraw, type NormalisedRect } from './RegionDraw';
import { RegionQuestionForm } from './RegionQuestionForm';
import { hitTest, paddedRect } from './textHitTest';
import { useRegionHistory } from './useRegionHistory';
import nb from '../../styles/notebook.module.css';
import styles from './DocumentPage.module.css';

const LAST_QUIZ_KEY = 'peira.playbook.lastQuizId';

/** The Playbook Quiz authoring surface.
 *
 * BUILT FOR THIRTY QUESTIONS, NOT ONE. Every decision here is about the
 * twenty-ninth question being as cheap as the first:
 *
 *   - TAP a play name and the mask AND the expected answer both come from the
 *     PDF's own text layer. The coach types nothing and presses Enter.
 *   - DRAG for a diagram, route or gap, where there is no text to tap.
 *   - The gesture chooses, so a page holding both an install sheet and a
 *     formation never asks the coach to switch modes.
 *   - The prompt and the target quiz are remembered, so the repeated part of
 *     the work is done once.
 *   - Mistakes are cheap: select, nudge, resize, Delete, Ctrl+Z. A coach who
 *     cannot fix a mis-tap slows down and becomes careful, which costs far
 *     more than the mis-tap did.
 */
export function DocumentPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const id = Number(documentId);

  const [document_, setDocument] = useState<SourceDocumentWithPages | null>(null);
  const [openPage, setOpenPage] = useState<PageModel | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [targetQuizId, setTargetQuizId] = useState<number | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [textRuns, setTextRuns] = useState<TextRun[]>([]);
  const [draft, setDraft] = useState<{ rect: NormalisedRect; answer: string } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const history = useRegionHistory();
  // Destructured because the hook returns a NEW OBJECT every render, so
  // depending on `history` itself would make openPageNumber a new function on
  // every render - and the mount effect that depends on it would re-fetch the
  // document in a loop. `clear` is a stable useCallback; the object is not.
  const { clear: clearHistory } = history;
  const surfaceRef = useRef<HTMLDivElement>(null);

  const openPageNumber = useCallback(
    async (pageNumber: number) => {
      setIsRendering(true);
      setError(null);
      setDraft(null);
      setSelectedId(null);
      // History is per page: an entry that undoes something on a page the
      // coach has navigated away from would appear to do nothing.
      clearHistory();
      try {
        const [page, runs] = await Promise.all([
          getDocumentPage(id, pageNumber),
          // A page with no text layer resolves to [] and the editor behaves
          // identically - drag stays first-class for scans.
          getPageTextRuns(id, pageNumber).catch(() => []),
        ]);
        setOpenPage(page);
        setTextRuns(runs);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setIsRendering(false);
      }
    },
    [id, clearHistory],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loaded, allQuizzes] = await Promise.all([getDocument(id), listQuizzes()]);
        if (cancelled) return;
        setDocument(loaded);
        setQuizzes(allQuizzes);
        // The quiz a coach was last filing into is almost always the one they
        // want again. Re-picking it every visit is a click that buys nothing.
        const remembered = Number(sessionStorage.getItem(LAST_QUIZ_KEY));
        if (remembered && allQuizzes.some((q) => q.id === remembered)) {
          setTargetQuizId(remembered);
        }
        if (loaded.pages.length > 0) void openPageNumber(loaded.pages[0].page_number);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, openPageNumber]);

  useEffect(() => {
    if (targetQuizId === null) {
      setQuestions([]);
      return;
    }
    sessionStorage.setItem(LAST_QUIZ_KEY, String(targetQuizId));
    let cancelled = false;
    (async () => {
      try {
        const quiz = await getQuiz(targetQuizId);
        if (!cancelled) setQuestions(quiz.questions ?? []);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetQuizId]);

  const pageQuestions = useMemo(
    () => questions.filter((q) => q.region?.document_page_id === openPage?.id),
    [questions, openPage],
  );

  const regions = useMemo(
    () =>
      pageQuestions.map((question, index) => ({
        id: question.id,
        label: String(index + 1),
        rect: {
          x: question.region!.x,
          y: question.region!.y,
          width: question.region!.width,
          height: question.region!.height,
        },
      })),
    [pageQuestions],
  );

  function flash(message: string) {
    setStatus(message);
    window.setTimeout(() => setStatus((current) => (current === message ? null : current)), 2200);
  }

  /** A click that was not on an existing region: tap-to-select. */
  function handleClick(x: number, y: number) {
    if (targetQuizId === null || !openPage) return;
    const run = hitTest(textRuns, x, y);
    if (!run) {
      // Empty page. Not an error - it is how a coach begins a drag over a
      // diagram, and how a scanned page behaves everywhere.
      setDraft(null);
      return;
    }
    // The mask lands on the glyph boxes, pixel-perfect, and the answer comes
    // from the page itself. This is the whole speed win.
    setDraft({ rect: paddedRect(run), answer: run.text });
  }

  async function createFromDraft(input: { question_text: string; expected_answers: string[] }) {
    if (!draft || targetQuizId === null || !openPage) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createRegionQuestion(targetQuizId, {
        document_page_id: openPage.id,
        question_text: input.question_text,
        expected_answers: input.expected_answers,
        region: draft.rect,
      });
      setQuestions((current) => [...current, created]);
      setLastPrompt(input.question_text);
      setDraft(null);
      flash(`Added "${input.expected_answers[0]}"`);

      history.push({
        label: 'Add question',
        undo: async () => {
          await deleteQuestion(targetQuizId, created.id);
          setQuestions((current) => current.filter((q) => q.id !== created.id));
        },
        redo: async () => {
          const again = await createRegionQuestion(targetQuizId, {
            document_page_id: openPage.id,
            question_text: input.question_text,
            expected_answers: input.expected_answers,
            region: draft.rect,
          });
          setQuestions((current) => [...current, again]);
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const applyRegion = useCallback(
    async (questionId: number, rect: NormalisedRect) => {
      if (targetQuizId === null) return;
      const updated = await updateRegionQuestion(targetQuizId, questionId, { region: rect });
      setQuestions((current) => current.map((q) => (q.id === questionId ? updated : q)));
    },
    [targetQuizId],
  );

  async function handleRegionChanged(questionId: number, rect: NormalisedRect) {
    const before = regions.find((r) => r.id === questionId)?.rect;
    if (!before) return;
    setError(null);
    try {
      await applyRegion(questionId, rect);
      history.push({
        label: 'Move region',
        undo: () => applyRegion(questionId, before),
        redo: () => applyRegion(questionId, rect),
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  const removeSelected = useCallback(async () => {
    if (selectedId === null || targetQuizId === null) return;
    const question = questions.find((q) => q.id === selectedId);
    if (!question || !openPage) return;

    setError(null);
    try {
      await deleteQuestion(targetQuizId, question.id);
      setQuestions((current) => current.filter((q) => q.id !== question.id));
      setSelectedId(null);
      flash('Deleted');

      const rect = {
        x: question.region!.x,
        y: question.region!.y,
        width: question.region!.width,
        height: question.region!.height,
      };
      const restore = async () => {
        const again = await createRegionQuestion(targetQuizId, {
          document_page_id: openPage.id,
          question_text: question.question_text,
          expected_answers: question.expected_answers ?? [],
          region: rect,
        });
        setQuestions((current) => [...current, again]);
      };
      history.push({
        label: 'Delete question',
        // Undo re-creates rather than restoring: the row is gone from the
        // server, so there is nothing to put back - only something to remake.
        undo: restore,
        redo: async () => {
          const latest = await getQuiz(targetQuizId);
          const match = (latest.questions ?? []).find(
            (q) => q.region?.x === rect.x && q.question_text === question.question_text,
          );
          if (match) {
            await deleteQuestion(targetQuizId, match.id);
            setQuestions((current) => current.filter((q) => q.id !== match.id));
          }
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [selectedId, targetQuizId, questions, openPage, history]);

  /** Duplicate offset slightly, so eight similar masks on one page are eight
   *  nudges rather than eight taps and eight typed answers. */
  const duplicateSelected = useCallback(async () => {
    if (selectedId === null || targetQuizId === null || !openPage) return;
    const question = questions.find((q) => q.id === selectedId);
    if (!question?.region) return;

    const rect = {
      x: Math.min(0.98, question.region.x + 0.01),
      y: Math.min(0.98, question.region.y + 0.01),
      width: question.region.width,
      height: question.region.height,
    };
    setError(null);
    try {
      const created = await createRegionQuestion(targetQuizId, {
        document_page_id: openPage.id,
        question_text: question.question_text,
        expected_answers: question.expected_answers ?? [],
        region: rect,
      });
      setQuestions((current) => [...current, created]);
      setSelectedId(created.id);
      flash('Duplicated');
      history.push({
        label: 'Duplicate question',
        undo: async () => {
          await deleteQuestion(targetQuizId, created.id);
          setQuestions((current) => current.filter((q) => q.id !== created.id));
        },
        redo: async () => {
          const again = await createRegionQuestion(targetQuizId, {
            document_page_id: openPage.id,
            question_text: question.question_text,
            expected_answers: question.expected_answers ?? [],
            region: rect,
          });
          setQuestions((current) => [...current, again]);
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [selectedId, targetQuizId, questions, openPage, history]);

  // Keyboard, because the fast path is hands-on-keys. Ignored while a field
  // has focus, so typing an answer never deletes a region.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        if (event.key === 'Escape') setDraft(null);
        return;
      }

      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void (event.shiftKey ? history.redo() : history.undo());
      } else if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        void duplicateSelected();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedId !== null) {
          event.preventDefault();
          void removeSelected();
        }
      } else if (event.key === 'Escape') {
        setDraft(null);
        setSelectedId(null);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [history, duplicateSelected, removeSelected, selectedId]);

  if (document_ === null) {
    return error ? <ErrorBanner message={error} /> : <LoadingState label="Loading playbook" />;
  }

  const canAuthor = targetQuizId !== null;

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={nb.heading}>{document_.title}</h1>
          <p className={nb.subheading}>
            {document_.page_count} {document_.page_count === 1 ? 'page' : 'pages'}
            {canAuthor && ` · ${pageQuestions.length} on this page`}
          </p>
        </div>
        <Link to="/documents" className={nb.btnSecondary}>
          All playbooks
        </Link>
      </div>

      <div className={styles.quizPicker}>
        <label className={nb.fieldLabel} htmlFor="target-quiz">
          Add questions to
        </label>
        <select
          id="target-quiz"
          className={nb.input}
          value={targetQuizId ?? ''}
          onChange={(event) =>
            setTargetQuizId(event.target.value ? Number(event.target.value) : null)
          }
        >
          <option value="">Choose a quiz…</option>
          {quizzes.map((quiz) => (
            <option key={quiz.id} value={quiz.id}>
              {quiz.title}
            </option>
          ))}
        </select>
        {canAuthor && (
          <>
            <button
              type="button"
              className={nb.btnSm}
              disabled={!history.canUndo}
              onClick={() => void history.undo()}
            >
              Undo
            </button>
            <button
              type="button"
              className={nb.btnSm}
              disabled={!history.canRedo}
              onClick={() => void history.redo()}
            >
              Redo
            </button>
            <Link to={`/quizzes/${targetQuizId}`} className={nb.btnSm}>
              Open quiz
            </Link>
          </>
        )}
      </div>

      <p className={styles.instruction}>
        {!canAuthor
          ? 'Choose a quiz above, then click a play name to turn it into a question.'
          : textRuns.length > 0
            ? 'Click a play name to mask it. Drag a box for diagrams. Click a mask to move, resize or delete it.'
            : 'This page has no selectable text, so drag a box over what you want to mask.'}
      </p>

      <ErrorBanner message={error} />
      {status && (
        <div className={styles.status} role="status">
          {status}
        </div>
      )}

      <div className={styles.layout}>
        <nav className={styles.strip} aria-label="Pages">
          {document_.pages.map((page) => (
            <button
              key={page.id}
              type="button"
              className={`${styles.thumb} ${
                openPage?.page_number === page.page_number ? styles.thumbActive : ''
              }`}
              aria-current={openPage?.page_number === page.page_number ? 'page' : undefined}
              onClick={() => openPageNumber(page.page_number)}
            >
              {page.thumbnail_url ? (
                <img
                  src={resolveMediaUrl(page.thumbnail_url)}
                  alt={`Page ${page.page_number}`}
                  style={{ aspectRatio: page.aspect_ratio ?? undefined }}
                />
              ) : (
                <span
                  className={styles.thumbFallback}
                  style={{ aspectRatio: page.aspect_ratio ?? undefined }}
                />
              )}
              <span className={styles.thumbLabel}>{page.page_number}</span>
            </button>
          ))}
        </nav>

        <div className={styles.viewer} ref={surfaceRef}>
          {isRendering && <LoadingState label="Rendering page" />}
          {!isRendering && openPage?.image_url && (
            <RegionDraw
              existing={regions}
              selectedId={selectedId}
              disabled={!canAuthor}
              onClick={handleClick}
              onDrawn={(rect) => setDraft({ rect, answer: '' })}
              onSelect={setSelectedId}
              onRegionChanged={handleRegionChanged}
            >
              <img
                className={styles.pageImage}
                src={resolveMediaUrl(openPage.image_url)}
                alt={`${document_.title}, page ${openPage.page_number}`}
                width={openPage.render_width}
                height={openPage.render_height}
                draggable={false}
              />
            </RegionDraw>
          )}
        </div>

        <aside className={styles.side}>
          {draft && (
            <RegionQuestionForm
              key={`${draft.rect.x}-${draft.rect.y}`}
              saving={saving}
              defaultPrompt={lastPrompt}
              defaultAnswer={draft.answer}
              onSave={createFromDraft}
              onCancel={() => setDraft(null)}
            />
          )}

          {selectedId !== null && !draft && (
            <div className={styles.selectedPanel}>
              <div className={styles.selectedTitle}>Selected mask</div>
              <p className={styles.selectedHint}>
                Drag to move, corners to resize.
              </p>
              <div className={styles.selectedActions}>
                <button type="button" className={nb.btnSm} onClick={() => void duplicateSelected()}>
                  Duplicate
                </button>
                <button
                  type="button"
                  className={`${nb.btnSm} ${nb.btnDanger}`}
                  onClick={() => void removeSelected()}
                >
                  Delete
                </button>
              </div>
            </div>
          )}

          {canAuthor && pageQuestions.length > 0 && (
            <div className={styles.created}>
              <div className={styles.createdTitle}>{pageQuestions.length} on this page</div>
              <ol className={styles.createdList}>
                {pageQuestions.map((question) => (
                  <li key={question.id}>
                    <button
                      type="button"
                      className={styles.createdItem}
                      onClick={() => setSelectedId(question.id)}
                    >
                      <span className={styles.createdAnswer}>
                        {(question.expected_answers ?? []).join(', ')}
                      </span>
                      <span className={styles.createdPrompt}>{question.question_text}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
