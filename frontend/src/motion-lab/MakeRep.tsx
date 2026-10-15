import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { getErrorMessage } from '../api/client'
import { createConcept, listConcepts, type Concept } from '../api/concepts'
import { ConceptPicker } from '../components/concepts/ConceptPicker'
import { resolveConcept } from '../components/concepts/conceptMatch'
import { createQuestion } from '../api/questions'
import { createQuiz, listQuizzes } from '../api/quizzes'
import { getRepsForPlay } from '../api/reps'
import type { Quiz } from '../api/types'
import type { Play } from './engine/play'
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH, playImage } from './playImage'
import { playerAt, px } from './playImageLayout'
import { presnapOf, snapSpots } from './presnap'
import {
  addPrompt,
  ANSWER_SETS,
  ballTargetLabel,
  hasMotion,
  readRepMemory,
  repTitle,
  roleName,
  SITUATION_PROMPTS,
  tapTargets,
  writeRepMemory,
} from './playRep'

/**
 * MOTION LAB -> SITUATIONAL REP: "put me in the play, make me prove I know my job."
 *
 * One small panel, no wizard:
 *   tap the man he is        -> "You're the Free safety" (rename it: "Boundary safety")
 *   say the situation        -> "#3 motions across. What is your check?"
 *   give the answers         -> type them, or one tap: Coverage / Leverage / Gap /
 *                               Run-pass / Players; tap the circle on the right one
 *   name the concept         -> "Motion adjustment" (what the coach will see missed)
 *   why (optional)           -> shown to the player after he answers
 * The picture is the play with its motion and without its routes, the man he
 * is ringed. "Make rep" adds the decision to a new Rep named after the play, or
 * to one he already has - so a 3-5 decision Rep is the same panel, again.
 */

interface Answer {
  text: string
  correct: boolean
}

const blankAnswers = (): Answer[] => [
  { text: '', correct: true },
  { text: '', correct: false },
  { text: '', correct: false },
]

export function MakeRep({
  play,
  motionPlayId,
  onClose,
  intoRep = null,
}: {
  play: Play
  motionPlayId: number | null
  onClose: () => void
  /** Opened from a Rep's "Add decisions": the decision goes there. */
  intoRep?: number | null
}) {
  const navigate = useNavigate()
  /* PICK UP WHERE THE COACH LEFT OFF on this play: the man, his role, the
     concept and the Rep from the last decision made from it. */
  const [memory] = useState(() => readRepMemory())
  const same = memory?.playId === play.id ? memory : null
  const [who, setWho] = useState<string | null>(() =>
    same?.who && play.players.some((p) => p.id === same.who) ? same.who : null,
  )
  const [role, setRole] = useState(same?.role ?? '')
  const [prompt, setPrompt] = useState('')
  const [answers, setAnswers] = useState<Answer[]>(blankAnswers)
  const [concept, setConcept] = useState(same?.concept ?? '')
  const [rememberedRep] = useState<number | null>(intoRep ?? same?.repId ?? null)
  /** Reps that already hold a decision from this play - offered first. */
  const [fromThisPlay, setFromThisPlay] = useState<number[]>([])
  const [why, setWhy] = useState('')
  const [motion, setMotion] = useState(() => hasMotion(play))
  const [routes, setRoutes] = useState(false)
  const [reps, setReps] = useState<Quiz[]>([])
  const [concepts, setConcepts] = useState<Concept[]>([])
  const [repId, setRepId] = useState<number | 'new'>('new')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<{ id: number; title: string; count: number } | null>(null)
  const preview = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    listQuizzes()
      .then((list) => {
        const found = list.filter((q) => q.kind === 'REP').sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        setReps(found)
        // The Rep the last decision from this play went into, if it is still there.
        if (rememberedRep !== null && found.some((r) => r.id === rememberedRep)) setRepId(rememberedRep)
      })
      .catch(() => setReps([]))
    // Without that memory (another device, a cleared browser), the newest Rep
    // already made from this play is the likely home for the next decision.
    if (motionPlayId !== null) {
      getRepsForPlay(motionPlayId)
        .then((list) => {
          setFromThisPlay(list.map((r) => r.id))
          if (rememberedRep === null && list.length > 0) setRepId(list[0].id)
        })
        .catch(() => undefined)
    }
    listConcepts()
      .then((list) => setConcepts(list.filter((c) => !c.is_archived)))
      .catch(() => setConcepts([]))
  }, [rememberedRep, motionPlayId])

  useEffect(() => {
    const canvas = preview.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.setTransform(canvas.width / IMAGE_WIDTH, 0, 0, canvas.height / IMAGE_HEIGHT, 0, 0)
    drawPlay(ctx, play, { routes, motion, highlight: who })
  }, [play, routes, motion, who])

  /* THE PRE-SNAP MOMENT: with "Show motion" on, the player watches the
     authored motion play out and decides at the snap. */
  const presnap = useMemo(() => (motion ? presnapOf(play, who) : null), [play, who, motion])
  /* Answers that are men in the play ("Players", or typed labels) become
     spots in the picture the player taps - where they stand AT THE SNAP when
     the motion plays, since that is the picture he taps on. */
  const targets = useMemo(() => {
    const spots = presnap ? snapSpots(presnap) : null
    return tapTargets(
      play,
      answers.filter((a) => a.text.trim()).map((a) => a.text),
      (p) => {
        const at = spots?.get(p.id) ?? p
        return { x: px(at).x / IMAGE_WIDTH, y: px(at).y / IMAGE_HEIGHT }
      },
    )
  }, [play, answers, presnap])

  const ready = useMemo(() => {
    const filled = answers.filter((a) => a.text.trim())
    return !!prompt.trim() && filled.length >= 2 && filled.some((a) => a.correct)
  }, [answers, prompt])

  const tapPicture = (e: MouseEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    if (!box.width || !box.height) return
    const id = playerAt(play, { x: ((e.clientX - box.left) / box.width) * IMAGE_WIDTH, y: ((e.clientY - box.top) / box.height) * IMAGE_HEIGHT })
    if (!id) return
    const man = play.players.find((p) => p.id === id)!
    if (id === who) {
      setWho(null)
      return
    }
    setWho(id)
    setRole(roleName(man))
  }

  const setAnswer = (i: number, patch: Partial<Answer>) =>
    setAnswers((list) =>
      list.map((a, j) => (patch.correct ? { ...a, correct: j === i } : j === i ? { ...a, ...patch } : a)),
    )

  /* One tap of answers. For the play's own men, the right one is the man the
     play gives the ball to, when PEIRA knows it. */
  const quickFill = (texts: string[], setId?: string) => {
    if (texts.length < 2) return
    const target = setId === 'players' ? ballTargetLabel(play) : null
    const right = target && texts.includes(target) ? target : texts[0]
    setAnswers(texts.map((text) => ({ text, correct: text === right })))
  }

  /* A prompt fills its answers too, unless the coach has typed his own. */
  const applyPrompt = (p: (typeof SITUATION_PROMPTS)[number]) => {
    setPrompt((now) => addPrompt(now, p.text))
    const set = p.answers ? ANSWER_SETS.find((s) => s.id === p.answers) : null
    if (set && answers.every((a) => !a.text.trim())) quickFill(set.answers(play), set.id)
  }

  async function make() {
    setBusy(true)
    setError(null)
    try {
      const conceptName = concept.trim()
      // The concept the team already has, however it was typed; a new one only when it is new.
      const conceptId = conceptName ? (resolveConcept(conceptName, concepts) ?? (await createConcept(conceptName))).id : null
      let target = repId === 'new' ? null : reps.find((r) => r.id === repId) ?? null
      if (!target) target = await createQuiz({ title: repTitle(play, role), kind: 'REP' })
      const blob = await playImage(play, { routes, motion, highlight: who })
      const image = new File([blob], `${play.name.replace(/[^\w-]+/g, '-').slice(0, 40) || 'rep'}.png`, { type: 'image/png' })
      const filled = answers.filter((a) => a.text.trim())
      await createQuestion(
        target.id,
        {
          question_text: prompt.trim(),
          question_type: 'multiple_choice',
          options: filled.map((a) => ({ option_text: a.text.trim(), is_correct_answer: a.correct })),
          concept_id: conceptId,
          subject_role: role.trim() || null,
          motion_play_id: motionPlayId,
          answer_explanation: why.trim() || null,
          ...(targets ? { tap_targets: targets } : {}),
          ...(presnap ? { presnap } : {}),
        },
        image,
      )
      const count = (target.question_count ?? 0) + 1
      setMade({ id: target.id, title: target.title, count })
      // The next decision goes to the same Rep, about the same man.
      setRepId(target.id)
      setReps((list) => [{ ...target!, question_count: count }, ...list.filter((r) => r.id !== target!.id)])
      if (conceptId !== null && !concepts.some((c) => c.id === conceptId)) {
        setConcepts((list) => [...list, { id: conceptId, name: conceptName, is_archived: false }])
      }
      const usedConcept = concepts.find((c) => c.id === conceptId)?.name ?? conceptName
      writeRepMemory({
        playId: play.id,
        who,
        role: role.trim(),
        concept: usedConcept,
        repId: target.id,
        recentConcepts: [usedConcept, ...(memory?.recentConcepts ?? []).filter((c) => c !== usedConcept)].filter(Boolean).slice(0, 5),
      })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const another = () => {
    setMade(null)
    setPrompt('')
    setAnswers(blankAnswers())
    setWhy('')
  }

  if (made) {
    return (
      <div className="popover make-q-pop make-rep-pop" role="dialog" aria-label="Rep made" onKeyDown={(e) => e.stopPropagation()}>
        <div className="make-rep-done">
          <span className="make-rep-check">✓</span>
          <span>
            Decision {made.count} added to <strong>{made.title}</strong>
          </span>
        </div>
        <div className="make-q-actions">
          <button onClick={another}>Add another decision</button>
          <button className="primary" onClick={() => navigate(`/reps/${made.id}`)}>
            Open rep
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="popover make-q-pop make-rep-pop" role="dialog" aria-label="Make a rep" onKeyDown={(e) => e.stopPropagation()}>
      <div className="pop-title">Make a rep: put him in the play</div>
      <canvas
        ref={preview}
        className="make-q-preview tappable"
        width={344}
        height={180}
        aria-label="The picture the player will see"
        onClick={tapPicture}
      />
      <div className="make-q-check-row">
        <label className="make-q-check">
          <input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} /> Show motion
        </label>
        <label className="make-q-check">
          <input type="checkbox" checked={routes} onChange={(e) => setRoutes(e.target.checked)} /> Show routes
        </label>
      </div>
      <label className="make-q-field">
        <span>You&rsquo;re the… (tap him in the picture)</span>
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Boundary safety" maxLength={60} />
      </label>
      <label className="make-q-field">
        <span>The situation</span>
        <textarea value={prompt} rows={2} onChange={(e) => setPrompt(e.target.value)} placeholder="#3 motions across. What is your check?" />
      </label>
      <div className="make-rep-sets" role="group" aria-label="Quick questions">
        {SITUATION_PROMPTS.map((p) => (
          <button key={p.label} type="button" onClick={() => applyPrompt(p)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="make-q-field">
        <span>Answers - tap the circle on the right one</span>
        <div className="make-rep-sets" role="group" aria-label="Quick answers">
          {ANSWER_SETS.map((set) => (
            <button key={set.id} type="button" onClick={() => quickFill(set.answers(play), set.id)}>
              {set.label}
            </button>
          ))}
        </div>
        {answers.map((a, i) => (
          <div key={i} className="make-rep-answer">
            <button
              type="button"
              role="radio"
              aria-checked={a.correct}
              aria-label={`Answer ${i + 1} is the right one`}
              className={a.correct ? 'make-rep-right on' : 'make-rep-right'}
              onClick={() => setAnswer(i, { correct: true })}
            >
              {a.correct ? '✓' : ''}
            </button>
            <input
              value={a.text}
              onChange={(e) => setAnswer(i, { text: e.target.value })}
              placeholder={i === 0 ? 'Rotate down' : i === 1 ? 'Stay boundary' : 'Another answer'}
              aria-label={`Answer ${i + 1}`}
              maxLength={500}
            />
            {answers.length > 2 && (
              <button
                type="button"
                className="make-rep-drop"
                aria-label={`Remove answer ${i + 1}`}
                onClick={() =>
                  setAnswers((list) => {
                    const next = list.filter((_, j) => j !== i)
                    return next.some((x) => x.correct) ? next : next.map((x, j) => ({ ...x, correct: j === 0 }))
                  })
                }
              >
                ×
              </button>
            )}
          </div>
        ))}
        {targets && <div className="make-q-note">Players tap the man in the picture.</div>}
        {presnap && <div className="make-q-note">Players watch the motion, then decide at the snap.</div>}
        {answers.length < 5 && (
          <button type="button" className="make-rep-add" onClick={() => setAnswers((list) => [...list, { text: '', correct: false }])}>
            + Answer
          </button>
        )}
      </div>
      <ConceptPicker
        label="Concept - what you'll see missed"
        value={concept}
        onChange={setConcept}
        concepts={concepts}
        recent={memory?.recentConcepts ?? []}
        classes={{ field: 'make-q-field make-rep-concept', chips: 'make-rep-sets', chip: '', strong: 'make-rep-mean', note: 'make-q-note' }}
      />
      <label className="make-q-field">
        <span>Why (optional) - he sees it after he answers</span>
        <textarea value={why} rows={2} onChange={(e) => setWhy(e.target.value)} placeholder="He's the new #3 - you rotate down to him." />
      </label>
      <label className="make-q-field">
        <span>Put it in</span>
        <select value={repId} onChange={(e) => setRepId(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
          <option value="new">A new rep: “{repTitle(play, role)}”</option>
          {[...reps]
            .sort((a, b) => Number(fromThisPlay.includes(b.id)) - Number(fromThisPlay.includes(a.id)))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} ({r.question_count}){fromThisPlay.includes(r.id) ? ' - from this play' : ''}
              </option>
            ))}
        </select>
      </label>
      {error && <div className="make-q-error" role="alert">{error}</div>}
      <div className="make-q-actions">
        <button className="primary" disabled={busy || !ready} onClick={() => void make()}>
          {busy ? 'Making it…' : 'Make rep'}
        </button>
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
