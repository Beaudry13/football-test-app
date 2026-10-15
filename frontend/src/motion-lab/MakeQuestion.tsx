import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getErrorMessage } from '../api/client'
import { createQuestion } from '../api/questions'
import { createQuiz, listQuizzes } from '../api/quizzes'
import type { Quiz } from '../api/types'
import type { Play } from './engine/play'
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH } from './playImage'
import { ballChoices, playImageFile, playQuestionInput, QUESTION_TEXT, SHOWS_ROUTES, type PlayQuestionKind as Kind } from './playQuestion'

/**
 * MOTION LAB -> QUIZ: turn the play on the field into a quiz question.
 *
 * Two questions a coach asks about a play, built from it in one click:
 *   "Draw your assignment"  a Draw question on a picture of the formation -
 *                           routes hidden, so the picture is not the answer;
 *   "Who gets the ball?"    multiple choice, offered when the play gives the
 *                           ball to someone: the receivers and backs are the
 *                           choices and the play's own target is the answer.
 * The question lands in a quiz the coach picks (or a new one named after the
 * play) and opens in the quiz editor, where everything about it can be changed.
 */

export function MakeQuestion({ play, onClose }: { play: Play; onClose: () => void }) {
  const navigate = useNavigate()
  const ball = useMemo(() => ballChoices(play), [play])
  const [kind, setKind] = useState<Kind>('draw')
  const [text, setText] = useState(QUESTION_TEXT.draw)
  const [routes, setRoutes] = useState(false)
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null)
  const [quizId, setQuizId] = useState<number | 'new'>('new')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    listQuizzes()
      .then((list) => setQuizzes([...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at))))
      .catch(() => setQuizzes([]))
  }, [])

  // The picture the player will see, small.
  useEffect(() => {
    const ctx = preview.current?.getContext('2d')
    if (!ctx) return
    ctx.setTransform(preview.current!.width / IMAGE_WIDTH, 0, 0, preview.current!.height / IMAGE_HEIGHT, 0, 0)
    drawPlay(ctx, play, { routes })
  }, [play, routes])

  const choose = (next: Kind) => {
    setKind(next)
    setText(QUESTION_TEXT[next])
    // To answer "who gets it" a player reads the concept, so the routes show.
    setRoutes(SHOWS_ROUTES[next])
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const image = await playImageFile(play, routes)
      const target = quizId === 'new' ? (await createQuiz({ title: play.name })).id : quizId
      await createQuestion(target, playQuestionInput(play, kind, text), image)
      navigate(`/quizzes/${target}`)
    } catch (err) {
      setError(getErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="popover make-q-pop" role="dialog" aria-label="Make a quiz question" onKeyDown={(e) => e.stopPropagation()}>
      <div className="pop-title">Make a quiz question from this play</div>
      <div className="make-q-kinds" role="radiogroup" aria-label="Question">
        <button role="radio" aria-checked={kind === 'draw'} className={kind === 'draw' ? 'active' : ''} onClick={() => choose('draw')}>
          Draw your assignment
        </button>
        {ball && (
          <button role="radio" aria-checked={kind === 'ball'} className={kind === 'ball' ? 'active' : ''} onClick={() => choose('ball')}>
            Who gets the ball?
          </button>
        )}
      </div>
      <canvas ref={preview} className="make-q-preview" width={344} height={180} aria-label="The picture players will see" />
      <label className="make-q-check">
        <input type="checkbox" checked={routes} onChange={(e) => setRoutes(e.target.checked)} /> Show the routes
      </label>
      {kind === 'ball' && ball && <div className="make-q-note">Choices: {ball.choices.join(', ')} · answer {ball.target}</div>}
      <label className="make-q-field">
        <span>Question</span>
        <textarea value={text} rows={2} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="make-q-field">
        <span>Put it in</span>
        <select value={quizId} onChange={(e) => setQuizId(e.target.value === 'new' ? 'new' : Number(e.target.value))} disabled={quizzes === null}>
          <option value="new">A new quiz: “{play.name}”</option>
          {(quizzes ?? []).map((q) => (
            <option key={q.id} value={q.id}>
              {q.title} ({q.question_count})
            </option>
          ))}
        </select>
      </label>
      {error && <div className="make-q-error" role="alert">{error}</div>}
      <div className="make-q-actions">
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void create()}>
          {busy ? 'Making it…' : 'Make question'}
        </button>
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
