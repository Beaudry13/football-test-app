import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { getErrorMessage } from '../api/client'
import { createQuestion } from '../api/questions'
import { createQuiz, listQuizzes } from '../api/quizzes'
import type { Quiz } from '../api/types'
import type { Play } from './engine/play'
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH } from './playImage'
import { playerAt, px } from './playImageLayout'
import { tapTargets } from './playRep'
import { MomentPicker } from './MomentPicker'
import { freezePicture, freezeSpots, hasPresnapMotion, momentsFor, presnapOf, type DecisionMoment } from './presnap'
import { ballChoices, drawText, isBuiltDrawText, playImageFile, playQuestionInput, QUESTION_TEXT, SHOWS_ROUTES, type PlayQuestionKind as Kind } from './playQuestion'

/**
 * MOTION LAB -> QUIZ: turn the play on the field into a quiz question.
 *
 * Two questions a coach asks about a play, built from it in one click:
 *   "Draw your assignment"  a Draw question on a picture of the formation -
 *                           routes hidden, so the picture is not the answer.
 *                           Tap a man (or pick him) and it becomes HIS
 *                           question: "You're the X." with X ringed;
 *   "Who gets the ball?"    multiple choice, offered when the play gives the
 *                           ball to someone: the receivers and backs are the
 *                           choices and the play's own target is the answer.
 * The question lands in a quiz the coach picks (or a new one named after the
 * play) and opens in the quiz editor, where everything about it can be changed.
 *
 * A play with pre-snap motion PLAYS IT for the player - the same moving
 * picture a Rep uses - and freezes at the decision moment the coach picks;
 * the answers wait for the freeze. Routes never play, so the picture is the
 * play moving or a still with its routes: one or the other.
 */

export function MakeQuestion({
  play,
  motionPlayId = null,
  onClose,
}: {
  play: Play
  /** The saved Motion Lab play, so the question keeps its source. */
  motionPlayId?: number | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const ball = useMemo(() => ballChoices(play), [play])
  const [kind, setKind] = useState<Kind>('draw')
  const [text, setText] = useState(QUESTION_TEXT.draw)
  const [routes, setRoutes] = useState(false)
  /** The man a Draw question is about, if the coach names one. */
  const [who, setWho] = useState<string | null>(null)
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null)
  const [quizId, setQuizId] = useState<number | 'new'>('new')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = useRef<HTMLCanvasElement>(null)
  const hasMotion = useMemo(() => hasPresnapMotion(play), [play])
  const [motion, setMotion] = useState(hasMotion)
  const [moment, setMoment] = useState<DecisionMoment>('snap')
  const moments = useMemo(() => momentsFor(play), [play])
  const presnap = useMemo(
    () => (motion ? presnapOf(play, kind === 'draw' ? who : null, moment) : null),
    [play, kind, who, motion, moment],
  )
  /** With the motion playing, the small picture is the decision moment. */
  const frozen = useMemo(() => (presnap ? freezePicture(presnap) : null), [presnap])
  /* "Who gets the ball?" is answered by tapping the man, as in a Rep - where
     he stands in the picture the player answers on (the frozen moment). */
  const targets = useMemo(() => {
    if (kind !== 'ball' || !ball) return null
    const spots = presnap ? freezeSpots(presnap) : null
    return tapTargets(play, ball.choices, (p) => {
      const at = spots?.get(p.id) ?? p
      return { x: px(at).x / IMAGE_WIDTH, y: px(at).y / IMAGE_HEIGHT }
    })
  }, [kind, ball, play, presnap])

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
    if (frozen) drawPlay(ctx, frozen.play, frozen.options)
    else drawPlay(ctx, play, { routes, highlight: kind === 'draw' ? who : null })
  }, [play, routes, kind, who, frozen])

  const offense = play.players.filter((p) => p.side === 'offense')
  const defense = play.players.filter((p) => p.side === 'defense')

  /** Make it his question - rewriting the words only if they are still ours. */
  const mark = (id: string | null) => {
    setWho(id)
    if (isBuiltDrawText(text)) setText(drawText(play.players.find((p) => p.id === id)?.label))
  }

  /** A tap on the picture picks the man under it; a second tap on him lets go. */
  const tapPicture = (e: MouseEvent<HTMLCanvasElement>) => {
    if (kind !== 'draw') return
    const box = e.currentTarget.getBoundingClientRect()
    if (!box.width || !box.height) return
    const id = playerAt(frozen?.play ?? play, { x: ((e.clientX - box.left) / box.width) * IMAGE_WIDTH, y: ((e.clientY - box.top) / box.height) * IMAGE_HEIGHT })
    if (id) mark(id === who ? null : id)
  }

  const choose = (next: Kind) => {
    setKind(next)
    setText(next === 'draw' ? drawText(play.players.find((p) => p.id === who)?.label) : QUESTION_TEXT[next])
    // To answer "who gets it" a player reads the concept, so the routes show
    // (and a still with routes is not the play moving).
    setRoutes(SHOWS_ROUTES[next])
    setMotion(hasMotion && !SHOWS_ROUTES[next])
  }

  const showMotion = (on: boolean) => {
    setMotion(on)
    if (on) setRoutes(false)
  }
  const showRoutes = (on: boolean) => {
    setRoutes(on)
    if (on) setMotion(false)
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const image = await playImageFile(play, routes, kind === 'draw' ? who : null, presnap)
      const target = quizId === 'new' ? (await createQuiz({ title: play.name })).id : quizId
      await createQuestion(
        target,
        {
          ...playQuestionInput(play, kind, text),
          ...(presnap ? { presnap } : {}),
          ...(targets ? { tap_targets: targets } : {}),
          ...(motionPlayId !== null ? { motion_play_id: motionPlayId } : {}),
        },
        image,
      )
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
      <canvas
        ref={preview}
        className={kind === 'draw' ? 'make-q-preview tappable' : 'make-q-preview'}
        width={344}
        height={180}
        aria-label="The picture players will see"
        onClick={tapPicture}
      />
      {kind === 'draw' && (
        <label className="make-q-field">
          <span>Whose job? Tap him in the picture, or pick him</span>
          <select value={who ?? ''} onChange={(e) => mark(e.target.value || null)}>
            <option value="">Anyone - nobody marked</option>
            <optgroup label="Offense">
              {offense.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Defense">
              {defense.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
      )}
      {hasMotion && (
        <label className="make-q-check">
          <input type="checkbox" checked={motion} onChange={(e) => showMotion(e.target.checked)} /> Play the motion
        </label>
      )}
      <label className="make-q-check">
        <input type="checkbox" checked={routes} onChange={(e) => showRoutes(e.target.checked)} /> Show the routes
      </label>
      <MomentPicker moments={motion ? moments : []} value={moment} onChange={setMoment} clip={presnap} />
      {kind === 'ball' && ball && (
        <div className="make-q-note">
          Choices: {ball.choices.join(', ')} · answer {ball.target}
          {targets ? ' · players tap the man in the picture' : ''}
        </div>
      )}
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
