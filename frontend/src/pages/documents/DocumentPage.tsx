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
import { RegionAnchoredPanel } from './RegionAnchoredPanel';
import { hitTest, paddedRect } from './textHitTest';
import { useRegionHistory } from './useRegionHistory';
import nb from '../../styles/notebook.module.css';
import styles from './DocumentPage.module.css';

/** A PLAYBOOK OPENS AS A PLAYBOOK.
 *
 * This screen used to be the authoring surface and nothing else: a quiz picker
 * was the first control on it, existing masks were drawn over the page, and
 * the last target quiz was restored from sessionStorage on mount - so a coach
 * returning to read their playbook landed straight back in authoring mode with
 * boxes over the pages. Reading one was not reachable at all.
 *
 * Now the default is browse, and everything to do with making questions
 * appears only after the coach asks for it. The authoring machinery below is
 * UNCHANGED - it is the same gestures, the same undo, the same fast path. It
 * is simply behind a door now.
 */

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
  /** Set when Done was pressed with a question still unsaved. Not a modal -
   *  the coach keeps the page, the draft and the form; this only adds the
   *  sentence explaining why nothing closed. */
  const [pendingExit, setPendingExit] = useState(false);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [textRuns, setTextRuns] = useState<TextRun[]>([]);
  const [draft, setDraft] = useState<{ rect: NormalisedRect; answer: string } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** Browse by default. The ONE piece of state this redesign adds, and it
   *  gates every authoring control on the page rather than each one deciding
   *  for itself. */
  const [isAuthoring, setIsAuthoring] = useState(false);
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
        // DELIBERATELY NOT RESTORED. Remembering the last target quiz saved a
        // click for a coach who came back to author, and cost every coach who
        // came back to READ the ability to do so - the page reopened covered
        // in one quiz's masks. Opening a playbook now means opening a
        // playbook; the quiz is chosen once, on the way in to authoring.
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

  /** Region-backed questions belonging to the page currently open.
   *
   * BOTH GUARDS ARE LOad-BEARING, and their absence white-screened the app.
   *
   * The old test was `q.region?.document_page_id === openPage?.id`. When no
   * page is open, `openPage?.id` is undefined - and an ORDINARY question
   * (multiple choice, written, anything with no region) also yields undefined
   * for `q.region?.document_page_id`. `undefined === undefined` is true, so
   * every non-region question in the selected quiz passed the filter, and the
   * next memo dereferenced `question.region!.x` on a question that has no
   * region at all.
   *
   * Requiring an open page AND an actual region makes the comparison one
   * between two real ids, never between two absences. */
  const pageQuestions = useMemo(
    () =>
      openPage === null
        ? []
        : questions.filter((q) => !!q.region && q.region.document_page_id === openPage.id),
    [questions, openPage],
  );

  const regions = useMemo(
    () =>
      pageQuestions.flatMap((question, index) => {
        // Narrowed rather than asserted. `region!` was a promise to the type
        // checker that the data did not keep; a question whose region is
        // missing is skipped instead of crashing the page.
        const region = question.region;
        if (!region) return [];
        return [
          {
            id: question.id,
            label: String(index + 1),
            rect: {
              x: region.x,
              y: region.y,
              width: region.width,
              height: region.height,
            },
          },
        ];
      }),
    [pageQuestions],
  );

  /** The rect of the currently selected mask, so its actions can sit beside
   *  it rather than across the page from it. */
  const selectedRegion = useMemo(
    () => regions.find((region) => region.id === selectedId)?.rect ?? null,
    [regions, selectedId],
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

  /** Leaving authoring - but NEVER at the cost of an unsaved question.
   *
   * "Done" used to clear the draft outright. A coach who typed a question and
   * pressed Done instead of "Save question" watched the panel close, read that
   * as success, and found nothing in the quiz: the question had never been
   * sent anywhere. Nothing warned them, because from the page's point of view
   * discarding a draft and finishing cleanly looked identical.
   *
   * So Done now REFUSES to finish while a draft is open, and says why. The
   * coach stays exactly where they are with their text intact, and chooses:
   * save it, or discard it deliberately.
   */
  function requestExit() {
    if (draft) {
      setPendingExit(true);
      return;
    }
    exitAuthoring();
  }

  function exitAuthoring() {
    // Leaving clears the target as well, so the next entry is a deliberate
    // choice rather than a remembered one - the same reason the sessionStorage
    // restore was removed.
    setPendingExit(false);
    setIsAuthoring(false);
    setTargetQuizId(null);
    setDraft(null);
    setSelectedId(null);
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

      // The id undo must delete changes when redo re-creates the question:
      // the server issues a NEW row, so a closure fixed to the first id would
      // ask the server to delete something that no longer exists. That failed
      // silently in the worst way - a 404 banner, and the re-created question
      // left sitting in the coach's quiz after they pressed undo.
      let liveId = created.id;
      history.push({
        label: 'Add question',
        undo: async () => {
          await deleteQuestion(targetQuizId, liveId);
          setQuestions((current) => current.filter((q) => q.id !== liveId));
        },
        redo: async () => {
          const again = await createRegionQuestion(targetQuizId, {
            document_page_id: openPage.id,
            question_text: input.question_text,
            expected_answers: input.expected_answers,
            region: draft.rect,
          });
          liveId = again.id;
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

      // Same reasoning as `regions`: never assert a field the server may omit.
      if (!question.region) return;
      const rect = {
        x: question.region.x,
        y: question.region.y,
        width: question.region.width,
        height: question.region.height,
      };
      // The live row this entry acts on. Null while the question is
      // deleted; set to the NEW id each time undo re-creates it.
      //
      // Redo used to re-fetch the quiz and find the row by matching
      // region.x and question_text. That is identity inferred from content,
      // and it is wrong twice over: two questions can legitimately share
      // both (duplicate a question, then drag it back), and the match would
      // then delete whichever the server happened to list first. A row the
      // server created has a real id - this tracks it.
      let liveId: number | null = null;
      history.push({
        label: 'Delete question',
        // Undo re-creates rather than restoring: the row is gone from the
        // server, so there is nothing to put back - only something to remake.
        undo: async () => {
          const again = await createRegionQuestion(targetQuizId, {
            document_page_id: openPage.id,
            question_text: question.question_text,
            expected_answers: question.expected_answers ?? [],
            region: rect,
          });
          liveId = again.id;
          setQuestions((current) => [...current, again]);
        },
        redo: async () => {
          if (liveId === null) return;
          const doomed = liveId;
          await deleteQuestion(targetQuizId, doomed);
          setQuestions((current) => current.filter((q) => q.id !== doomed));
          liveId = null;
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
      // The id undo must delete changes when redo re-creates the question:
      // the server issues a NEW row, so a closure fixed to the first id would
      // ask the server to delete something that no longer exists. That failed
      // silently in the worst way - a 404 banner, and the re-created question
      // left sitting in the coach's quiz after they pressed undo.
      let liveId = created.id;
      history.push({
        label: 'Duplicate question',
        undo: async () => {
          await deleteQuestion(targetQuizId, liveId);
          setQuestions((current) => current.filter((q) => q.id !== liveId));
        },
        redo: async () => {
          const again = await createRegionQuestion(targetQuizId, {
            document_page_id: openPage.id,
            question_text: question.question_text,
            expected_answers: question.expected_answers ?? [],
            region: rect,
          });
          liveId = again.id;
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

  const canAuthor = isAuthoring && targetQuizId !== null;

  return (
    /* THE PLAYBOOK IS THE WIDEST THING IN THE APP. The attribute is what the
       shared shell keys its wider measure off (notebook.module.css), so the
       layout stays ignorant of which page it is wrapping. */
    <div data-workspace="playbook">
      <div className={styles.header}>
        <div>
          <h1 className={nb.heading}>{document_.title}</h1>
          <p className={nb.subheading}>
            {document_.page_count} {document_.page_count === 1 ? 'page' : 'pages'}
            {canAuthor && ` · ${pageQuestions.length} on this page`}
          </p>
        </div>
        <div className={styles.headerActions}>
          {isAuthoring ? (
            <button
              type="button"
              className={nb.btnSecondary}
              onClick={requestExit}
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              className={nb.btnSecondary}
              onClick={() => setIsAuthoring(true)}
            >
              Create questions
            </button>
          )}
          <Link to="/documents" className={nb.btnSecondary}>
            All playbooks
          </Link>
        </div>
      </div>

      {isAuthoring && (
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
      )}

      {isAuthoring && (
        <p className={styles.instruction}>
          {!canAuthor
            ? 'Choose a quiz, then click a play name to turn it into a question.'
            : textRuns.length > 0
              ? 'Click a play name to mask it. Drag a box for diagrams. Click a mask to move, resize or delete it.'
              : 'This page has no selectable text, so drag a box over what you want to mask.'}
        </p>
      )}

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
          {/* A playbook whose pages are missing or failed to render still has
              a usable screen: the title, the page count, and a plain
              explanation - rather than an empty frame that reads as a hang. */}
          {!isRendering && document_.pages.length === 0 && (
            <p className={styles.instruction}>
              This playbook has no pages available to display. The file may still be processing, or
              its pages may have failed to render. Nothing has been lost - try again shortly, and
              re-upload it if the problem persists.
            </p>
          )}
          {!isRendering && document_.pages.length > 0 && !openPage && !error && (
            <p className={styles.instruction}>
              This page could not be opened. Choose another page from the strip.
            </p>
          )}
          {/* BROWSING: the page and nothing on it. Rendering the plain image
              rather than a disabled RegionDraw is deliberate - it guarantees
              no mask, no hit target and no draw affordance can appear over
              reference material, instead of relying on a flag to suppress
              them. */}
          {!isRendering && openPage?.image_url && !isAuthoring && (
            <img
              className={styles.pageImage}
              src={resolveMediaUrl(openPage.image_url)}
              alt={`${document_.title}, page ${openPage.page_number}`}
              width={openPage.render_width}
              height={openPage.render_height}
              draggable={false}
            />
          )}
          {!isRendering && openPage?.image_url && isAuthoring && (
            <RegionDraw
              existing={regions}
              selectedId={selectedId}
              pending={draft?.rect ?? null}
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

          {/* THE FORM SITS ON THE PAGE, BESIDE THE MASK IT DESCRIBES.
              It used to live in a fixed column on the far right, which put the
              whole width of the playbook between the rectangle the coach had
              just drawn and the box they typed the answer into. Absolutely
              positioned as a SIBLING of the drawing surface, so it takes no
              part in the layout RegionDraw measures its gestures against. */}
          {draft && (
            <RegionAnchoredPanel region={draft.rect} label="New question from this region">
              <RegionQuestionForm
                key={`${draft.rect.x}-${draft.rect.y}`}
                saving={saving}
                defaultPrompt={lastPrompt}
                defaultAnswer={draft.answer}
                onSave={createFromDraft}
                onCancel={() => {
                  setPendingExit(false);
                  setDraft(null);
                }}
              />

              {pendingExit && (
                /* WHY NOTHING CLOSED. The draft, the typed text and the page
                   are all still here - this is the sentence that used to be
                   missing while the question quietly disappeared instead. It
                   travels with the form so the explanation and the unsaved
                   work are never in two different places. */
                <div className={styles.pendingExit} role="alert">
                  <p className={styles.pendingExitLine}>
                    This question hasn&rsquo;t been saved yet, so it isn&rsquo;t in your quiz.
                    Save it first, or discard it.
                  </p>
                  <div className={styles.pendingExitActions}>
                    <button
                      type="button"
                      className={nb.btnSm}
                      onClick={() => setPendingExit(false)}
                    >
                      Keep editing
                    </button>
                    <button type="button" className={nb.btnSm} onClick={exitAuthoring}>
                      Discard it and finish
                    </button>
                  </div>
                </div>
              )}
            </RegionAnchoredPanel>
          )}

          {/* The actions for a selected mask belong next to that mask. They
              were across the page from it, which meant confirming WHICH mask
              was about to be deleted took a glance in each direction. */}
          {selectedRegion && !draft && (
            <RegionAnchoredPanel region={selectedRegion} label="Selected mask">
              <div className={styles.selectedPanel}>
                <div className={styles.selectedTitle}>Selected mask</div>
                <p className={styles.selectedHint}>Drag to move, corners to resize.</p>
                <div className={styles.selectedActions}>
                  <button
                    type="button"
                    className={nb.btnSm}
                    onClick={() => void duplicateSelected()}
                  >
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
            </RegionAnchoredPanel>
          )}
        </div>

      </div>

      {/* WHAT IS ALREADY ON THIS PAGE, under the page it is about.
          This used to be a third column, which cost the playbook 300px of
          width for a list a coach consults between questions rather than
          during one. The masks themselves, numbered on the page, are the
          primary index; this is the way to jump to one that has become hard
          to hit. */}
      {canAuthor && pageQuestions.length > 0 && (
        <div className={styles.created}>
          <div className={styles.createdTitle}>
            {pageQuestions.length} on this page
          </div>
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
    </div>
  );
}
