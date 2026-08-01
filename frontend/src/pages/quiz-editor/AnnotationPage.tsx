import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getQuiz } from '../../api/quizzes';
import { saveAnnotations, uploadQuestionImage } from '../../api/questions';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import type { Question } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { AnnotationCanvas, type AnnotationCanvasHandle } from '../../components/annotation/AnnotationCanvas';
import styles from './AnnotationPage.module.css';

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

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !quizId || !questionId) return;
    setError(null);
    setIsUploading(true);
    try {
      await uploadQuestionImage(Number(quizId), Number(questionId), file);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsUploading(false);
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
          <p>Upload a screenshot to draw routes, circle players, and add callouts.</p>
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            {isUploading ? 'Uploading…' : 'Choose image'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handleUpload} disabled={isUploading} />
          </label>
        </div>
      )}
    </div>
  );
}
