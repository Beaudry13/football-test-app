import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { getErrorMessage } from '../api/client'
import { createConcept, listConcepts, type Concept } from '../api/concepts'
import { ConceptPicker } from '../components/concepts/ConceptPicker'
import { resolveConcept } from '../components/concepts/conceptMatch'
import { createQuestion } from '../api/questions'
import { createQuiz, listQuizzes } from '../api/quizzes'
import { getMadeFromPlay, type MadeFromPlay } from '../api/reps'
import type { Quiz } from '../api/types'
import type { Play } from './engine/play'
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH } from './playImage'
import { playerAt, px } from './playImageLayout'
import { readRepMemory, tapTargets, writeRepMemory } from './playRep'
import { TapCheck } from '../components/football/TapCheck'
import { MomentPicker } from './MomentPicker'
import { freezePicture, freezeSpots, hasPresnapMotion, momentsFor, presnapOf, type DecisionMoment } from './presnap'
import { assignmentDrawing, ballChoices, drawText, isBuiltDrawText, playImageFile, playQuestionInput, QUESTION_TEXT, SHOWS_ROUTES, type PlayQuestionKind as Kind } from './playQuestion'

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
 * CREATE ONCE, TEACH EVERYWHERE. It carries what Make rep carries: the concept
 * (what the coach will see missed - started from the one he already named for
 * this play's Rep decisions) and his point, shown after a practice answer, in
 * Review missed and when the question is taught - so nothing is typed twice.
 *
 * A play with pre-snap motion PLAYS IT for the player - the same moving
 * picture a Rep uses - and freezes at the decision moment the coach picks;
 * the answers wait for the freeze. Routes never play, so the picture is the
 * play moving or a still with its routes: one or the other.
 *
 * DON'T ASK FOR WHAT PEIRA KNOWS (connected-system cycle):
 *   - the man selected on the field is the man the Draw question is about;
 *   - the concept is the one he last named for this play - here or in Make
 *     rep, on this device or (from the server) any other;
 *   - "Put it in" is the quiz he last put a question in, else the quiz that
 *     already holds this play's questions;
 *   - making it keeps him in Motion Lab: "Make another" or "Open the quiz".
 * Every one of these is a starting value he can see and change.
 */

const LAST_QUIZ_KEY = 'peira.makeQuestion.quiz.v1'
function readLastQuiz(): number | null {
  try {
    return Number(window.localStorage.getItem(LAST_QUIZ_KEY)) || null
  } catch {
    return null
  }
}
function writeLastQuiz(id: number) {
  try {
    window.localStorage.setItem(LAST_QUIZ_KEY, String(id))
  } catch {
    // A private window: next time starts from the play's own quiz.
  }
}

export function MakeQuestion({
  play,
  motionPlayId = null,
  selectedMan = null,
  onClose,
}: {
  play: Play
  /** The saved Motion Lab play, so the question keeps its source. */
  motionPlayId?: number | null
  /** The man selected on the field when the coach asked: the Draw question is his. */
  selectedMan?: string | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const ball = useMemo(() => ballChoices(play), [play])
  const [kind, setKind] = useState<Kind>('draw')
  const [startMan] = useState(() => (selectedMan && play.players.some((p) => p.id === selectedMan) ? selectedMan : null))
  const [text, setText] = useState(() => drawText(play.players.find((p) => p.id === startMan)?.label))
  const [routes, setRoutes] = useState(false)
  /** The man a Draw question is about, if the coach names one. */
  const [who, setWho] = useState<string | null>(startMan)
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null)
  const [quizId, setQuizId] = useState<number | 'new'>('new')
  /** The coach chose where it goes himself - no default overrides him. */
  const quizChosen = useRef(false)
  const conceptTyped = useRef(false)
  /** This play's quizzes, from the server (where its questions already live). */
  const [fromPlay, setFromPlay] = useState<MadeFromPlay[]>([])
  /** The question just made: "Make another" or "Open the quiz". */
  const [made, setMade] = useState<{ id: number; title: string; count: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  /* What Make rep already knows about this play: the concept he named for it. */
  const [memory] = useState(() => readRepMemory())
  const [concept, setConcept] = useState(() => (memory?.playId === play.id ? memory.concept : '') ?? '')
  const [concepts, setConcepts] = useState<Concept[]>([])
  const [why, setWhy] = useState('')
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
      // A quiz question goes in a quiz; Reps are made with Make rep.
      .then((list) => setQuizzes([...list].filter((q) => q.kind !== 'REP').sort((a, b) => b.updated_at.localeCompare(a.updated_at))))
      .catch(() => setQuizzes([]))
    listConcepts()
      .then((list) => setConcepts(list.filter((c) => !c.is_archived)))
      .catch(() => setConcepts([]))
    if (motionPlayId !== null) {
      getMadeFromPlay(motionPlayId)
        .then(({ made: list, last }) => {
          setFromPlay(list.filter((m) => m.kind === 'QUIZ'))
          // His concept for this play from any device, when this one has none.
          if (last?.concept && !conceptTyped.current) setConcept((now) => now || last.concept!.name)
        })
        .catch(() => undefined)
    }
  }, [motionPlayId])

  // WHERE IT GOES, unless he has chosen: the quiz he last used, else the quiz
  // already holding this play's questions, else a new one named after the play.
  useEffect(() => {
    if (quizChosen.current || quizzes === null) return
    const offered = [readLastQuiz(), fromPlay[0]?.id ?? null].find((id) => id !== null && quizzes.some((q) => q.id === id))
    setQuizId(offered ?? 'new')
  }, [quizzes, fromPlay])

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

  /** Draw your assignment: the man's route from the play, as the answer drawing. */
  const answer = kind === 'draw' ? assignmentDrawing(play, who) : null

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const image = await playImageFile(play, routes, kind === 'draw' ? who : null, presnap)
      const conceptName = concept.trim()
      // The concept the team already has, however it was typed; a new one only when it is new.
      const conceptId = conceptName ? (resolveConcept(conceptName, concepts) ?? (await createConcept(conceptName))).id : null
      const existing = quizId === 'new' ? null : (quizzes ?? []).find((q) => q.id === quizId) ?? null
      const target = existing ? existing.id : (await createQuiz({ title: play.name })).id
      await createQuestion(
        target,
        {
          ...playQuestionInput(play, kind, text),
          ...(presnap ? { presnap } : {}),
          ...(targets ? { tap_targets: targets } : {}),
          ...(motionPlayId !== null ? { motion_play_id: motionPlayId } : {}),
          concept_id: conceptId,
          answer_explanation: why.trim() || null,
          // Which man the question tests, so Teach and a Rep made from it ring him.
          ...(kind === 'draw' && who ? { subject_man: who } : {}),
          // His route in the play IS the answer: no drawing it twice.
          ...(answer ? { answer_drawing: answer } : {}),
        },
        image,
      )
      // STAY IN THE PLAY: the next question goes to the same quiz.
      const count = (existing?.question_count ?? 0) + 1
      const title = existing?.title ?? play.name
      setMade({ id: target, title, count })
      setQuizzes((list) => [{ ...(existing ?? ({ id: target, title } as Quiz)), question_count: count }, ...(list ?? []).filter((q) => q.id !== target)])
      setQuizId(target)
      quizChosen.current = true
      writeLastQuiz(target)
      if (conceptId !== null && !concepts.some((c) => c.id === conceptId)) {
        setConcepts((list) => [...list, { id: conceptId, name: conceptName, is_archived: false }])
      }
      // Make rep starts from what he just said about this play, too.
      const usedConcept = concepts.find((c) => c.id === conceptId)?.name ?? conceptName
      const before = readRepMemory()
      const same = before?.playId === play.id ? before : null
      writeRepMemory({
        playId: play.id,
        who: (kind === 'draw' ? who : null) ?? same?.who ?? null,
        role: same?.role ?? '',
        concept: usedConcept || same?.concept || '',
        repId: same?.repId ?? null,
        recentConcepts: [usedConcept, ...(before?.recentConcepts ?? []).filter((c) => c !== usedConcept)].filter(Boolean).slice(0, 5),
      })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** Another question from the same play, into the same quiz, about the same idea. */
  const another = () => {
    setMade(null)
    setWho(null)
    setText(QUESTION_TEXT[kind])
    setWhy('')
  }

  if (made) {
    return (
      <div className="popover make-q-pop" role="dialog" aria-label="Question made" onKeyDown={(e) => e.stopPropagation()}>
        <div className="make-rep-done">
          <span className="make-rep-check">✓</span>
          <span>
            Question {made.count} added to <strong>{made.title}</strong>
          </span>
        </div>
        <div className="make-q-actions">
          <button onClick={another}>Make another</button>
          <button className="primary" onClick={() => navigate(`/quizzes/${made.id}`)}>
            Open the quiz
          </button>
        </div>
      </div>
    )
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
      {kind === 'draw' && who && (
        <span className="make-q-hint" role="note">
          {answer
            ? '✓ His route in this play becomes the answer you review against.'
            : 'He has no route in this play - you can draw the answer on the question.'}
        </span>
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
          {targets ? ' · players tap the man in the picture ' : ''}
          {targets && (
            <button type="button" className="make-q-link" onClick={() => setChecking(true)}>
              See what they tap
            </button>
          )}
        </div>
      )}
      {checking && targets && ball && (
        <TapCheck
          presnap={presnap}
          drawn={presnap ? undefined : { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, draw: (ctx) => drawPlay(ctx, play, { routes }) }}
          targets={targets}
          answers={ball.choices}
          rightIndex={ball.choices.indexOf(ball.target)}
          onClose={() => setChecking(false)}
          onConfirm={() => setChecking(false)}
        />
      )}
      <label className="make-q-field">
        <span>Question</span>
        <textarea value={text} rows={2} onChange={(e) => setText(e.target.value)} />
      </label>
      <ConceptPicker
        label="Concept - what you'll see missed"
        value={concept}
        onChange={(next) => {
          conceptTyped.current = true
          setConcept(next)
        }}
        concepts={concepts}
        recent={memory?.recentConcepts ?? []}
        classes={{ field: 'make-q-field make-rep-concept', chips: 'make-rep-sets', chip: '', strong: 'make-rep-mean', note: 'make-q-note' }}
      />
      <label className="make-q-field">
        <span>Why (optional) - he sees it after a practice answer, and when you teach it</span>
        <textarea value={why} rows={2} onChange={(e) => setWhy(e.target.value)} placeholder="The corner bails, so X is open on the slant." />
      </label>
      <label className="make-q-field">
        <span>Put it in</span>
        <select
          value={quizId}
          onChange={(e) => {
            quizChosen.current = true
            setQuizId(e.target.value === 'new' ? 'new' : Number(e.target.value))
          }}
          disabled={quizzes === null}
        >
          <option value="new">A new quiz: “{play.name}”</option>
          {(quizzes ?? []).map((q) => (
            <option key={q.id} value={q.id}>
              {q.title} ({q.question_count}){fromPlay.some((m) => m.id === q.id) ? ' · has this play' : ''}
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
