import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, getDocumentPage } from '../../api/documents';
import type { DocumentPage as PageModel, SourceDocumentWithPages } from '../../api/documents';
import { createRegionQuestion } from '../../api/questions';
import { getQuiz, listQuizzes } from '../../api/quizzes';
import type { Question, Quiz } from '../../api/types';
import { resolveMediaUrl, getErrorMessage } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { RegionDraw, type NormalisedRect } from './RegionDraw';
import { RegionQuestionForm } from './RegionQuestionForm';
import nb from '../../styles/notebook.module.css';
import styles from './DocumentPage.module.css';

/** One playbook: a page strip down the side, one page open, and the drag-to-
 * create authoring loop on top of it.
 *
 * There is no page-selection step - opening a page IS selecting it. And there
 * is no "save the page" step either: a question exists the moment its form is
 * submitted, so a coach can draw the next rectangle immediately.
 *
 * The full-resolution raster for a page does not exist until it is first
 * opened, so opening one can take a moment. That wait is shown rather than
 * hidden; every page after the first is instant.
 */
export function DocumentPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const id = Number(documentId);

  const [document, setDocument] = useState<SourceDocumentWithPages | null>(null);
  const [openPage, setOpenPage] = useState<PageModel | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [targetQuizId, setTargetQuizId] = useState<number | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [draftRect, setDraftRect] = useState<NormalisedRect | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');

  const openPageNumber = useCallback(
    async (pageNumber: number) => {
      setIsRendering(true);
      setError(null);
      setDraftRect(null);
      try {
        setOpenPage(await getDocumentPage(id, pageNumber));
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setIsRendering(false);
      }
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loaded, allQuizzes] = await Promise.all([getDocument(id), listQuizzes()]);
        if (cancelled) return;
        setDocument(loaded);
        setQuizzes(allQuizzes);
        if (loaded.pages.length > 0) void openPageNumber(loaded.pages[0].page_number);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, openPageNumber]);

  // Reload the target quiz's questions whenever it changes, so the page shows
  // the rectangles already created on it.
  useEffect(() => {
    if (targetQuizId === null) {
      setQuestions([]);
      return;
    }
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

  const regionsOnThisPage = useMemo(() => {
    if (!openPage) return [];
    return questions
      .filter((question) => question.region?.document_page_id === openPage.id)
      .map((question, index) => ({
        id: question.id,
        label: String(index + 1),
        rect: {
          x: question.region!.x,
          y: question.region!.y,
          width: question.region!.width,
          height: question.region!.height,
        },
      }));
  }, [questions, openPage]);

  async function handleSave(input: { question_text: string; expected_answers: string[] }) {
    if (!draftRect || targetQuizId === null || !openPage) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createRegionQuestion(targetQuizId, {
        document_page_id: openPage.id,
        question_text: input.question_text,
        expected_answers: input.expected_answers,
        region: draftRect,
      });
      setQuestions((current) => [...current, created]);
      // Remembering the prompt is what makes the second question fast: a coach
      // masking twelve coverage names reuses one question and types only the
      // answer each time.
      setLastPrompt(input.question_text);
      setDraftRect(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (document === null) {
    return error ? <ErrorBanner message={error} /> : <LoadingState label="Loading playbook" />;
  }

  const canAuthor = targetQuizId !== null;

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={nb.heading}>{document.title}</h1>
          <p className={nb.subheading}>
            {document.page_count} {document.page_count === 1 ? 'page' : 'pages'}
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
        {targetQuizId !== null && (
          <Link to={`/quizzes/${targetQuizId}`} className={nb.btnSm}>
            Open quiz
          </Link>
        )}
      </div>

      <p className={styles.instruction}>
        {canAuthor
          ? 'Drag a box over a play name or call to turn it into a question.'
          : 'Choose a quiz above, then drag a box over the page to create questions.'}
      </p>

      <ErrorBanner message={error} />

      <div className={styles.layout}>
        <nav className={styles.strip} aria-label="Pages">
          {document.pages.map((page) => (
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

        <div className={styles.viewer}>
          {isRendering && <LoadingState label="Rendering page" />}
          {!isRendering && openPage?.image_url && (
            <RegionDraw
              existing={regionsOnThisPage}
              disabled={!canAuthor}
              onDrawn={(rect) => setDraftRect(rect)}
            >
              <img
                className={styles.pageImage}
                src={resolveMediaUrl(openPage.image_url)}
                alt={`${document.title}, page ${openPage.page_number}`}
                width={openPage.render_width}
                height={openPage.render_height}
                draggable={false}
              />
            </RegionDraw>
          )}
        </div>

        <aside className={styles.side}>
          {draftRect && (
            <RegionQuestionForm
              saving={saving}
              defaultPrompt={lastPrompt}
              onSave={handleSave}
              onCancel={() => setDraftRect(null)}
            />
          )}

          {canAuthor && regionsOnThisPage.length > 0 && (
            <div className={styles.created}>
              <div className={styles.createdTitle}>
                {regionsOnThisPage.length} on this page
              </div>
              <ol className={styles.createdList}>
                {questions
                  .filter((question) => question.region?.document_page_id === openPage?.id)
                  .map((question) => (
                    <li key={question.id}>
                      <span className={styles.createdAnswer}>
                        {(question.expected_answers ?? []).join(', ')}
                      </span>
                      <span className={styles.createdPrompt}>{question.question_text}</span>
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
