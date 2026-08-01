import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getQuiz } from '../../api/quizzes';
import { saveAnnotations, uploadQuestionImage } from '../../api/questions';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import type { Question } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { AnnotationCanvas, type AnnotationCanvasHandle } from '../../components/annotation/AnnotationCanvas';
import styles from './AnnotationPage.module.css';

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
  const [question, setQuestion] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const canvasRef = useRef<AnnotationCanvasHandle>(null);

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

  async function handleSave() {
    if (!quizId || !questionId || !canvasRef.current || !isCanvasReady) return;
    setError(null);
    setIsSaving(true);
    try {
      const annotations = canvasRef.current.getAnnotations();
      await saveAnnotations(Number(quizId), Number(questionId), annotations);
      setSavedAt(new Date());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  if (!question) {
    return (
      <div>
        <ErrorBanner message={error} />
        {!error && <p>Loading…</p>}
      </div>
    );
  }

  return (
    <div>
      <div className={styles.header}>
        <Link to={`/quizzes/${quizId}`} className={styles.backLink}>
          ← Back to quiz
        </Link>
        {question.image && (
          <div>
            {savedAt && <span className={styles.savedNote}>Saved {savedAt.toLocaleTimeString()} · </span>}
            <button className="btn btn-primary" onClick={handleSave} disabled={isSaving || !isCanvasReady}>
              {isSaving ? 'Saving…' : 'Save annotations'}
            </button>
          </div>
        )}
      </div>

      <h2>{question.question_text}</h2>

      <ErrorBanner message={error} />

      {question.image ? (
        <AnnotationCanvas
          key={question.image.id}
          ref={canvasRef}
          imageUrl={resolveMediaUrl(question.image.image_url)}
          initialAnnotations={question.image.annotations}
          onReady={() => setIsCanvasReady(true)}
        />
      ) : (
        <div className={`card ${styles.uploadCard}`}>
          <h3>Add a film still</h3>
          <p>Draw routes, circle players, and add callouts on a screenshot.</p>
          <p className={styles.pasteHint}>
            Copy a screenshot (e.g. Windows Snipping Tool or Cmd+Shift+4), then paste it anywhere on this
            page with <strong>Ctrl+V</strong> - or click below.
          </p>
          <div className={styles.uploadActions}>
            <button className="btn btn-primary" onClick={handlePasteButtonClick} disabled={isUploading}>
              {isUploading ? 'Uploading…' : 'Paste image'}
            </button>
            <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
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
      )}
    </div>
  );
}
