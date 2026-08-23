import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getQuiz } from '../../api/quizzes';
import { saveAnnotations, uploadQuestionImage } from '../../api/questions';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import type { Question } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { AnnotationCanvas, type AnnotationCanvasHandle } from '../../components/annotation/AnnotationCanvas';
import nb from '../../styles/notebook.module.css';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import styles from './AnnotationPage.module.css';
import { LoadingState } from '../../components/ui/LoadingState';
import { Icon } from '../../components/ui/Icon';

const MAX_UPLOAD_DIMENSION = 1920;
const SKIP_RESIZE_UNDER_BYTES = 5 * 1024 * 1024;

/** Downscales/re-encodes large images client-side before upload - a raw
 * clipboard screenshot (especially from a high-DPI display) can exceed the
 * backend's 10MB limit despite looking like an ordinary screen snip to the
 * person pasting it, and the annotation canvas never displays wider than
 * ~900px anyway, so there's no reason to ship it at native resolution. */
async function resizeImageForUpload(file: File): Promise<File> {
  if (file.size <= SKIP_RESIZE_UNDER_BYTES) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // let the server validate/reject it rather than fail the upload here
  }

  const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) return file;

  const baseName = file.name.replace(/\.[^./\\]+$/, '') || 'image';
  return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
}

export function AnnotationPage() {
  const { quizId, questionId } = useParams<{ quizId: string; questionId: string }>();
  const onPhone = useCoarsePointer();
  const [question, setQuestion] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  const navigate = useNavigate();
  /** The annotations as last written to the server, so "is there unsaved
   *  work" is answered by comparison rather than by a flag. */
  const savedJsonRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!quizId || !questionId) return;
    try {
      const quiz = await getQuiz(Number(quizId));
      const found = quiz.questions?.find((q) => q.id === Number(questionId));
      if (!found) {
        setError('Question not found.');
        return;
      }
      setQuestion(found);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [quizId, questionId]);

  useEffect(() => {
    load();
  }, [load]);

  // AnnotationCanvas remounts (via its `key`) whenever the image changes, but
  // this component's own isCanvasReady flag doesn't reset on a child remount -
  // without this it would stay stuck "ready" from the previous image.
  useEffect(() => {
    setIsCanvasReady(false);
  }, [question?.image?.id]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!quizId || !questionId) return;
      setError(null);
      setIsUploading(true);
      try {
        const uploadable = await resizeImageForUpload(file);
        await uploadQuestionImage(Number(quizId), Number(questionId), uploadable);
        await load();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setIsUploading(false);
      }
    },
    [quizId, questionId, load],
  );

  function handleFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) uploadFile(file);
  }

  // Lets a coach paste a screenshot (e.g. Windows Snipping Tool, Cmd+Shift+4)
  // straight in with Ctrl+V, without saving it to disk first - the workflow
  // coaches actually use when clipping frames from film-review software.
  useEffect(() => {
    if (question?.image || isUploading) return;

    function handlePaste(event: ClipboardEvent) {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            uploadFile(file);
          }
          return;
        }
      }
    }

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [question?.image, isUploading, uploadFile]);

  async function handlePasteButtonClick() {
    if (!navigator.clipboard?.read) {
      setError('Your browser doesn’t support the paste button - use Ctrl+V instead.');
      return;
    }
    setError(null);
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const extension = imageType.split('/')[1] ?? 'png';
          await uploadFile(new File([blob], `pasted.${extension}`, { type: imageType }));
          return;
        }
      }
      setError('No image found on the clipboard. Copy a screenshot first, then try again.');
    } catch {
      setError('Could not read the clipboard - use Ctrl+V instead.');
    }
  }

  /** What is on the canvas right now, as the server would store it. */
  const currentAnnotationsJson = useCallback(() => {
    if (!canvasRef.current) return null;
    return JSON.stringify(canvasRef.current.getAnnotations());
  }, []);

  async function persist(): Promise<boolean> {
    if (!quizId || !questionId || !canvasRef.current || !isCanvasReady) return false;
    setError(null);
    setIsSaving(true);
    try {
      const annotations = canvasRef.current.getAnnotations();
      const canvasWidth = canvasRef.current.getCanvasWidth();
      await saveAnnotations(Number(quizId), Number(questionId), annotations, canvasWidth);
      savedJsonRef.current = JSON.stringify(annotations);
      setSavedAt(new Date());
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  /** THE ONE WAY TO FINISH. Save, then go back to the question it belongs to.
   *  There is no second "save and stay" concept: the workspace exists to draw
   *  on one image, and finishing it means returning to the quiz. */
  async function handleDone() {
    if (await persist()) navigate(`/quizzes/${quizId}`);
  }

  /** LEAVING WITHOUT SAVING IS A REAL LOSS, so it asks - annotations live in
   *  the canvas until something calls saveAnnotations, and nothing else does.
   *  It only asks when there is genuinely something to lose, compared against
   *  what was last written rather than against a flag that could drift. */
  function handleExit() {
    const current = currentAnnotationsJson();
    const dirty = current !== null && current !== savedJsonRef.current;
    if (dirty && !window.confirm('Leave without saving? Your annotation changes will be lost.')) {
      return;
    }
    navigate(`/quizzes/${quizId}`);
  }

  if (!question) {
    return (
      <div>
        <ErrorBanner message={error} />
        {!error && <LoadingState />}
      </div>
    );
  }

  // nb.coachTokens, because this route is deliberately OUTSIDE NotebookLayout
  // and so has no .page ancestor to inherit the coach token scope from.
  // Without it the uploader's empty state renders --peira-text on index.css's
  // player surface, at 1.1 : 1 - see notebook.module.css.
  return (
    <div className={`${nb.coachTokens} ${styles.workspace}`}>
      {/* THE ONLY CHROME LEFT: how to get out, what you are drawing on, and
          how to finish. Everything else a coach can see is the image. */}
      <div className={styles.bar}>
        <button type="button" className={styles.exit} onClick={handleExit}>
          <Icon name="back" size={14} /> Back to quiz
        </button>
        <span className={styles.divider} aria-hidden="true" />
        <span className={styles.context} title={question.question_text}>
          {question.question_text}
        </span>
        <span className={styles.spacer} />
        {savedAt && (
          <span className={styles.savedNote}>Saved {savedAt.toLocaleTimeString()}</span>
        )}
        {question.image && (
          <button
            type="button"
            className={styles.done}
            onClick={handleDone}
            disabled={isSaving || !isCanvasReady}
          >
            {isSaving ? 'Saving…' : 'Done'}
          </button>
        )}
      </div>

      <ErrorBanner message={error} />

      {question.image ? (
        <div className={styles.stage}>
          <AnnotationCanvas
            key={question.image.id}
            ref={canvasRef}
            imageUrl={resolveMediaUrl(question.image.image_url)}
            initialAnnotations={question.image.annotations}
            savedCanvasWidth={question.image.canvas_width}
            onReady={() => {
              setIsCanvasReady(true);
              savedJsonRef.current = JSON.stringify(canvasRef.current?.getAnnotations() ?? []);
            }}
          />
        </div>
      ) : (
        <div className={styles.emptyStage}>
          <div className={`${nb.card} ${styles.uploadCard}`}>
            <h2 className={nb.subheading}>{onPhone ? 'Add a photo' : 'Add a film still'}</h2>
            <p>
              {onPhone
                ? 'Draw routes, circle players, and add callouts on the photo.'
                : 'Draw routes, circle players, and add callouts on a screenshot.'}
            </p>
            {/* THE PRIMARY ACTION USED TO BE THE ONE A PHONE CANNOT DO. This
                screen led with "Paste image" and explained the Windows
                Snipping Tool and Cmd+Shift+4 - three desktop idioms, in the
                largest button and the only paragraph, on the screen a coach
                reaches from a field. The desktop copy is untouched; the phone
                gets the camera instead, and no instructions it cannot follow. */}
            {!onPhone && (
              <p className={styles.pasteHint}>
                Copy a screenshot (e.g. Windows Snipping Tool or Cmd+Shift+4), then paste it
                anywhere on this page with <strong>Ctrl+V</strong> - or click below.
              </p>
            )}
            <div className={styles.uploadActions}>
              {onPhone ? (
                <label className={nb.btnPrimary} style={{ cursor: 'pointer' }}>
                  {isUploading ? 'Uploading…' : 'Take photo'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    capture="environment"
                    hidden
                    onChange={handleFileInputChange}
                    disabled={isUploading}
                  />
                </label>
              ) : (
                <button
                  className={nb.btnPrimary}
                  onClick={handlePasteButtonClick}
                  disabled={isUploading}
                >
                  {isUploading ? 'Uploading…' : 'Paste image'}
                </button>
              )}
              <label className={nb.btnSecondary} style={{ cursor: 'pointer' }}>
                Choose image
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={handleFileInputChange}
                  disabled={isUploading}
                />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
