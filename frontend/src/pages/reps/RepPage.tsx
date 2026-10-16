import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { activateQuiz } from '../../api/accessCodes';
import { reorderQuestions, updateQuestion } from '../../api/questions';
import { AddDecisions } from './AddDecisions';
import { createConcept, listConcepts, type Concept } from '../../api/concepts';
import { ConceptPicker } from '../../components/concepts/ConceptPicker';
import { resolveConcept } from '../../components/concepts/conceptMatch';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import { listGroups } from '../../api/groups';
import { listPlayers } from '../../api/players';
import { addRosterMembers } from '../../api/roster';
import { audiencesFrom, chosenPlayerIds, groupPlayerIds, pluralFor, suggestedFamily } from './audiences';
import { PositionChips } from './PositionChips';
import { createRepRetest, getRepResults, type RepConcept, type RepDecision, type RepResults } from '../../api/reps';
import type { Group, Player } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TeachView, type TeachSlide } from '../../components/teach/TeachView';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import type { PresnapClip } from '../../motion-lab/presnap';
import { playLink } from '../quiz-editor/playUrl';
import nb from '../../styles/notebook.module.css';
import styles from './RepPage.module.css';

/* Teach runs the motion for the room when a decision has some. */
const PresnapPicture = lazy(() => import('../../motion-lab/PresnapPicture'));

/** Which problems this coach has opened Teach on, per Rep - so Retest becomes the next step. */
const TAUGHT_KEY = 'peira.repTaught.v1';
const conceptKey = (c: RepConcept) => String(c.concept?.id ?? 'general');
function readTaught(repId: number): string[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(TAUGHT_KEY) ?? '{}') as Record<string, string[]>;
    return all[repId] ?? [];
  } catch {
    return [];
  }
}
function writeTaught(repId: number, keys: string[]): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(TAUGHT_KEY) ?? '{}') as Record<string, string[]>;
    window.localStorage.setItem(TAUGHT_KEY, JSON.stringify({ ...all, [repId]: keys }));
  } catch {
    // Private window: Teach still works, Retest is just not pushed forward.
  }
}

/**
 * A SITUATIONAL REP, FOR THE COACH: send it, then see the FOOTBALL PROBLEM.
 *
 * Not "safeties scored 72%". Each concept the players missed is a card:
 *
 *     MOTION ADJUSTMENT
 *     4 of 11 safeties missed  ·  most chose "Stay boundary"
 *     [who]                       VIEW PLAYERS   TEACH   RETEST
 *
 * VIEW PLAYERS - who missed it and what each one answered.
 * TEACH        - the decision, big, with the right answer and the coach's
 *                reason; and the Motion Lab play it came from, one tap away.
 * RETEST       - the same decisions, straight back out to exactly the players
 *                who missed them. One tap, then the link to share.
 *
 * Every number is from each player's FIRST try (api/reps).
 */
export function RepPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const id = Number(quizId);
  const navigate = useNavigate();
  const [results, setResults] = useState<RepResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teaching, setTeaching] = useState<RepConcept | null>(null);
  /** ?teach=<concept id | general>: arrive straight in Teach (Home's "Teach it"). */
  const [params, setParams] = useSearchParams();
  /** Problems already taught here: their next step is Retest. */
  const [taught, setTaught] = useState<string[]>(() => readTaught(id));
  const teach = (problem: RepConcept) => {
    setTeaching(problem);
    if (!taught.includes(conceptKey(problem))) {
      const next = [...taught, conceptKey(problem)];
      setTaught(next);
      writeTaught(id, next);
    }
  };
  /** Retest = a new Rep of this concept for exactly the players who missed it, sent, opened. */
  const retest = async (problem: RepConcept) => {
    const made = await createRepRetest(id, problem.concept?.id ?? null);
    await activateQuiz(made.id, [], 'PRACTICE');
    navigate(`/reps/${made.id}`);
  };
  useDocumentTitle(results ? `${results.title} - Rep` : 'Rep');

  const load = useCallback(() => {
    getRepResults(id)
      .then(setResults)
      .catch((err) => setError(getErrorMessage(err)));
  }, [id]);

  useEffect(() => {
    setResults(null);
    load();
  }, [load]);

  // Home's "Teach it" lands here: open that problem's Teach once, then drop the ask.
  const teachAsk = params.get('teach');
  useEffect(() => {
    if (!results || !teachAsk) return;
    const asked = results.concepts.find((c) => conceptKey(c) === teachAsk && c.missed > 0);
    if (asked) teach(asked);
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, teachAsk]);

  const problems = results?.concepts.filter((c) => c.missed > 0) ?? [];
  const solid = results?.concepts.filter((c) => c.missed === 0 && c.responded > 0) ?? [];
  // "safeties": the one group's name, else the one position family it went to.
  const who = results?.audience.label
    ? results.audience.label.toLowerCase()
    : (pluralFor(results?.audience.positions ?? []) ?? 'players');
  const roles = [...new Set((results?.decisions ?? []).map((d) => d.subject_role).filter((r): r is string => !!r))];

  return (
    <div>
      <div>
        <Link to="/reps" className={styles.back}>
          ← Reps
        </Link>
        <ErrorBanner message={error} />
        {!results && !error && <LoadingState />}
        {results && (
          <>
            <header className={styles.head}>
              <span className={styles.kicker}>Situational rep</span>
              <h1 className={nb.heading}>{results.title}</h1>
              <span className={styles.meta}>
                {roles.length === 1 ? `You’re the ${roles[0]} · ` : ''}
                {results.decisions.length} {results.decisions.length === 1 ? 'decision' : 'decisions'}
              </span>
            </header>

            <SendPanel results={results} onSent={load} />
            <Waiting results={results} />

            {results.retest_of && <DidItStick results={results} />}

            {results.players.length === 0 ? (
              <p className={styles.waiting}>No one has run it yet. Results land here the moment they do.</p>
            ) : (
              <section aria-label="What they missed">
                {problems.length === 0 && (
                  <p className={styles.allClear}>Nobody missed a decision. They know this job.</p>
                )}
                {problems.map((problem) => (
                  <ProblemCard
                    key={problem.concept?.id ?? 'general'}
                    problem={problem}
                    who={who}
                    decisions={results.decisions}
                    taught={taught.includes(conceptKey(problem))}
                    onTeach={() => teach(problem)}
                    onRetest={() => retest(problem)}
                  />
                ))}
                {solid.length > 0 && (
                  <ul className={styles.solid} aria-label="What they know">
                    {solid.map((c) => (
                      <li key={c.concept?.id ?? 'general'}>
                        <span className={styles.tick}>✓</span> {c.name}
                        <span className={styles.solidCount}>
                          {c.responded} of {c.responded}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <Decisions results={results} quizId={id} onChanged={load} />
            {results.players.length > 0 && <Players results={results} />}
          </>
        )}
      </div>
      {teaching && results && (
        <Teach
          problem={teaching}
          decisions={results.decisions}
          onClose={() => setTeaching(null)}
          onRetest={teaching.retest ? undefined : () => retest(teaching)}
        />
      )}
    </div>
  );
}

function SendPanel({ results, onSent }: { results: RepResults; onSent: () => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  /* WHO, FROM THE ROSTER: position families ("Safeties - FS, S, SS - 11"),
     the one the Rep's "You're the..." points at picked for him. */
  const [players, setPlayers] = useState<Player[]>([]);
  const audiences = audiencesFrom(players);
  const likely = suggestedFamily(results.decisions.map((d) => d.subject_role));
  const [positions, setPositions] = useState<string[] | null>(null);
  const chosen = positions ?? audiences.filter((a) => a.family && a.family === likely).map((a) => a.key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const code = results.audience.code;

  useEffect(() => {
    if (code) return;
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
    listPlayers({ active: 'true' })
      .then(setPlayers)
      .catch(() => setPlayers([]));
  }, [code]);

  if (code) {
    const link = playLink(code);
    const done = results.players.length;
    return (
      <section className={styles.send} aria-label="Out with players">
        <div className={styles.liveRow}>
          <span className={styles.livePip} aria-hidden="true" />
          <span className={styles.liveText}>
            Out with {results.audience.label ?? pluralFor(results.audience.positions ?? []) ?? 'players'} · {done} of{' '}
            {results.audience.invited} ran it
          </span>
        </div>
        <div className={styles.linkRow}>
          <code className={styles.code}>{code}</code>
          <input className={styles.link} readOnly value={link} aria-label="Rep link" onFocus={(e) => e.target.select()} />
          <button
            type="button"
            className={nb.btnPrimary}
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.send} aria-label="Send it">
      <span className={styles.sendLead}>Send it to</span>
      <PositionChips audiences={audiences} chosen={chosen} onChange={setPositions} likely={likely} className={styles.groups} />
      <div className={styles.groups} role="group" aria-label="Groups">
        {(groups ?? []).map((g) => {
          const on = picked.includes(g.id);
          return (
            <button
              key={g.id}
              type="button"
              aria-pressed={on}
              className={on ? `${styles.group} ${styles.groupOn}` : styles.group}
              onClick={() => setPicked((list) => (on ? list.filter((x) => x !== g.id) : [...list, g.id]))}
            >
              {g.name} <span className={styles.groupCount}>{g.players.length}</span>
            </button>
          );
        })}
        {groups?.length === 0 && <span className={styles.hint}>No groups yet - it goes to this rep&rsquo;s roster.</span>}
      </div>
      <ErrorBanner message={error} />
      <button
        type="button"
        className={nb.btnPrimary}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const fromPositions = chosenPlayerIds(audiences, chosen);
            if (fromPositions.length > 0) {
              // Positions go on the Rep's own roster (as Retest does - no
              // throwaway Group); any picked groups' players join them there.
              const fromGroups = groupPlayerIds(groups ?? [], picked);
              await addRosterMembers(results.quiz_id, [...new Set([...fromPositions, ...fromGroups])]);
              await activateQuiz(results.quiz_id, [], 'PRACTICE');
            } else {
              await activateQuiz(results.quiz_id, picked, 'PRACTICE');
            }
            onSent();
          } catch (err) {
            setError(getErrorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Sending…' : 'Send rep'}
      </button>
    </section>
  );
}

function ProblemCard({
  problem,
  who,
  decisions,
  taught,
  onTeach,
  onRetest,
}: {
  problem: RepConcept;
  who: string;
  decisions: RepDecision[];
  /** Teach has been opened on it here: Retest is the next step. */
  taught: boolean;
  onTeach: () => void;
  onRetest: () => Promise<void>;
}) {
  const again = problem.retest ?? null;
  const fixed = !!again && again.responded > 0 && again.missed === 0;
  const toGo = again ? again.invited - again.ran : 0;
  const [viewing, setViewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = problem.players_missed.slice(0, 8);
  const more = problem.players_missed.length - shown.length;
  const numberOf = (questionId: number) => decisions.find((d) => d.question_id === questionId)?.number;
  return (
    <article className={fixed ? `${styles.problem} ${styles.problemFixed}` : styles.problem} aria-label={problem.name}>
      <h2 className={styles.problemName}>{problem.name}</h2>
      <p className={styles.problemLine}>
        <strong>
          {problem.missed} of {problem.responded}
        </strong>{' '}
        {who} missed
        {problem.most_common_wrong && (
          <>
            {' · '}most chose <strong>“{problem.most_common_wrong.text}”</strong>
          </>
        )}
      </p>
      <div className={styles.chips}>
        {shown.map((p) =>
          p.player_id !== null ? (
            <Link key={p.key} to={`/roster/${p.player_id}`} className={styles.chip}>
              {p.display_name}
            </Link>
          ) : (
            <span key={p.key} className={styles.chip}>
              {p.display_name}
            </span>
          ),
        )}
        {more > 0 && <span className={styles.more}>and {more} more</span>}
      </div>
      {/* THE NEXT STEP, SAID. Taught -> retest; retested -> how it went. */}
      {again ? (
        <p className={fixed ? `${styles.nextLine} ${styles.nextFixed}` : styles.nextLine}>
          {again.ran === 0
            ? `Retest is out to ${again.invited} - nobody has run it yet.`
            : fixed
              ? `Fixed on the retest: all ${again.responded} got it.`
              : `Retest: ${again.missed} of ${again.responded} still missing.`}
          {again.ran > 0 && toGo > 0 && <span className={styles.toGo}> {toGo} to go</span>}
        </p>
      ) : (
        taught && <p className={styles.nextLine}>Taught it. Now see if it stuck.</p>
      )}
      <div className={styles.actions}>
        <button type="button" className={nb.btnSecondary} aria-expanded={viewing} onClick={() => setViewing((v) => !v)}>
          View players
        </button>
        {again ? (
          <>
            <button type="button" className={nb.btnSecondary} onClick={onTeach}>
              Teach
            </button>
            <Link to={`/reps/${again.id}`} className={`${nb.btnPrimary} ${styles.linkButton}`}>
              Open retest
            </Link>
          </>
        ) : (
          <>
            <button type="button" className={taught ? nb.btnSecondary : nb.btnPrimary} onClick={onTeach}>
              Teach
            </button>
            <button
              type="button"
              className={taught ? nb.btnPrimary : nb.btnSecondary}
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              Retest
            </button>
          </>
        )}
      </div>
      {confirming && (
        <div className={styles.confirm} role="group" aria-label="Retest">
          <span>
            Send {problem.name} back to the {problem.players_missed.length}{' '}
            {problem.players_missed.length === 1 ? 'player' : 'players'} who missed it?
          </span>
          <button
            type="button"
            className={nb.btnPrimary}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onRetest();
              } catch (err) {
                setError(getErrorMessage(err));
                setBusy(false);
              }
            }}
          >
            {busy ? 'Sending…' : 'Send retest'}
          </button>
          <button type="button" className={nb.btnSm} onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
      <ErrorBanner message={error} />
      {viewing && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Player</th>
              <th>Answered</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {problem.players_missed.map((p) =>
              p.answers.map((a, i) => (
                <tr key={`${p.key}:${a.question_id}`}>
                  <td>{i === 0 ? p.display_name : ''}</td>
                  <td>
                    {problem.question_ids.length > 1 && <span className={styles.qNum}>#{numberOf(a.question_id)} </span>}“
                    {a.chose.join(', ') || '-'}”
                  </td>
                  <td>{a.time_ms ? `${(a.time_ms / 1000).toFixed(1)} s` : '-'}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </article>
  );
}

/** TEACH: the problem's decisions in the meeting-room view, worst first. */
function Teach({
  problem,
  decisions,
  onClose,
  onRetest,
}: {
  problem: RepConcept;
  decisions: RepDecision[];
  onClose: () => void;
  /** Absent once it has been retested. */
  onRetest?: () => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const n = problem.players_missed.length;
  const inProblem = decisions.filter((d) => problem.question_ids.includes(d.question_id));
  const worst = [...inProblem].sort((a, b) => b.missed - a.missed)[0];
  const slides: TeachSlide[] = inProblem.map((d) => {
    const wrong = d.choices.filter((c) => !c.is_correct && c.count > 0).sort((a, b) => b.count - a.count)[0];
    return {
      key: d.question_id,
      imageUrl: d.image ? resolveMediaUrl(d.image.image_url) : null,
      role: d.subject_role,
      prompt: d.question_text,
      right: d.correct_text,
      why: d.answer_explanation,
      wrong: wrong ? { text: wrong.text, count: wrong.count } : null,
      motionPlayId: d.motion_play_id ?? problem.motion_play_id,
      // The play moving to the snap, exactly as the players saw it.
      picture: d.presnap ? (
        <Suspense fallback={null}>
          <PresnapPicture clip={d.presnap as unknown as PresnapClip} />
        </Suspense>
      ) : undefined,
    };
  });
  return (
    <TeachView
      title={problem.name}
      slides={slides}
      start={Math.max(0, inProblem.indexOf(worst))}
      onClose={onClose}
      action={
        onRetest && n > 0 ? (
          <button
            type="button"
            disabled={sending}
            onClick={async () => {
              setSending(true);
              try {
                await onRetest();
              } catch {
                setSending(false);
              }
            }}
          >
            {sending ? 'Sending…' : `Retest the ${n} who missed`}
          </button>
        ) : undefined
      }
    />
  );
}

/** WHO HASN'T RUN IT - while the Rep is out, the names to nudge. */
function Waiting({ results }: { results: RepResults }) {
  if (!results.audience.code) return null;
  const ran = new Set(results.players.map((p) => (p.player_id !== null ? `p${p.player_id}` : p.display_name.toLowerCase())));
  const waiting = results.audience.people.filter(
    (p) => !ran.has(p.player_id !== null ? `p${p.player_id}` : (p.name ?? '').toLowerCase()),
  );
  if (waiting.length === 0 || results.players.length === 0) return null;
  return (
    <p className={styles.waitingOn}>
      <span className={styles.waitingLead}>Hasn&rsquo;t run it:</span> {waiting.map((p) => p.name).join(', ')}
    </p>
  );
}

/** A RETEST'S FIRST QUESTION: did the teaching stick? Before, and now. */
function DidItStick({ results }: { results: RepResults }) {
  const parent = results.retest_of!;
  return (
    <section className={styles.stick} aria-label="Did it stick">
      <span className={styles.stickLead}>
        Retest of <Link to={`/reps/${parent.id}`}>{parent.title}</Link>
      </span>
      <ul className={styles.stickList}>
        {parent.concepts.map((c) => {
          const now = results.concepts.find((x) => (x.concept?.id ?? null) === (c.concept?.id ?? null));
          const waiting = results.audience.invited - (now?.responded ?? 0);
          return (
            <li key={c.concept?.id ?? 'general'} className={styles.stickRow}>
              <span className={styles.stickName}>{c.name}</span>
              <span className={styles.stickBefore}>{c.missed_before ?? '-'} missed before</span>
              <span className={styles.stickArrow} aria-hidden="true">
                →
              </span>
              <span className={now && now.responded > 0 && now.missed === 0 ? styles.stickFixed : styles.stickNow}>
                {now && now.responded > 0
                  ? now.missed === 0
                    ? `all ${now.responded} got it`
                    : `${now.missed} of ${now.responded} still missing`
                  : 'not run yet'}
              </span>
              {waiting > 0 && now && now.responded > 0 && <span className={styles.stickWaiting}>{waiting} to go</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "You're the ___" on a decision, fixable right here - a Rep made from a quiz starts without one. */
function RoleField({ quizId, decision, onChanged }: { quizId: number; decision: RepDecision; onChanged: () => void }) {
  const [value, setValue] = useState(decision.subject_role ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (value.trim() === (decision.subject_role ?? '')) return;
    setSaving(true);
    try {
      await updateQuestion(quizId, decision.question_id, { subject_role: value.trim() || null });
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  return (
    <label className={styles.roleField}>
      <span>You&rsquo;re the</span>
      <input
        value={value}
        placeholder="Boundary safety"
        maxLength={60}
        disabled={saving}
        aria-label={`Who the player is in decision ${decision.number}`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

/**
 * EDIT A DECISION RIGHT HERE: the situation, the answers and which is right,
 * the concept, the reason. Once a player has received it, the answers can be
 * reworded or added to but the right one is locked - changing it would quietly
 * change results players already have.
 */
function DecisionEditor({
  quizId,
  decision,
  concepts,
  onSaved,
  onCancel,
}: {
  quizId: number;
  decision: RepDecision;
  concepts: Concept[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const locked = !!decision.delivered;
  const [prompt, setPrompt] = useState(decision.question_text);
  const [answers, setAnswers] = useState(decision.choices.map((c) => ({ text: c.text, correct: c.is_correct })));
  const [concept, setConcept] = useState(decision.concept?.name ?? '');
  const [why, setWhy] = useState(decision.answer_explanation ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = decision.choices.length;
  const filled = answers.filter((a) => a.text.trim());
  const ready = !!prompt.trim() && filled.length >= 2 && filled.some((a) => a.correct);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = concept.trim();
      const conceptId = name ? (resolveConcept(name, concepts) ?? (await createConcept(name))).id : null;
      await updateQuestion(quizId, decision.question_id, {
        question_text: prompt.trim(),
        options: (locked ? answers : filled).map((a) => ({ option_text: a.text.trim(), is_correct_answer: a.correct })),
        concept_id: conceptId,
        answer_explanation: why.trim(),
      });
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className={styles.editor} role="group" aria-label={`Edit decision ${decision.number}`}>
      <label className={styles.editField}>
        <span>The situation</span>
        <textarea value={prompt} rows={2} onChange={(e) => setPrompt(e.target.value)} aria-label="The situation" />
      </label>
      <div className={styles.editField}>
        <span>Answers {locked ? '- players have this one, so the right answer is locked' : '- tap the circle on the right one'}</span>
        {answers.map((a, i) => (
          <div key={i} className={styles.editAnswer}>
            <button
              type="button"
              role="radio"
              aria-checked={a.correct}
              aria-label={`Answer ${i + 1} is the right one`}
              className={a.correct ? `${styles.editRight} ${styles.editRightOn}` : styles.editRight}
              disabled={locked}
              onClick={() => setAnswers((list) => list.map((x, j) => ({ ...x, correct: j === i })))}
            >
              {a.correct ? '✓' : ''}
            </button>
            <input
              value={a.text}
              aria-label={`Answer ${i + 1}`}
              maxLength={500}
              onChange={(e) => setAnswers((list) => list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
            />
            {!(locked && i < kept) && answers.length > 2 && (
              <button
                type="button"
                className={styles.editDrop}
                aria-label={`Remove answer ${i + 1}`}
                onClick={() =>
                  setAnswers((list) => {
                    const next = list.filter((_, j) => j !== i);
                    return next.some((x) => x.correct) ? next : next.map((x, j) => ({ ...x, correct: j === 0 }));
                  })
                }
              >
                ×
              </button>
            )}
          </div>
        ))}
        {answers.length < 5 && (
          <button type="button" className={styles.editAdd} onClick={() => setAnswers((list) => [...list, { text: '', correct: false }])}>
            + Answer
          </button>
        )}
      </div>
      <ConceptPicker
        label="Concept"
        value={concept}
        onChange={setConcept}
        concepts={concepts}
        classes={{ field: styles.editField, chips: styles.editChips, chip: styles.editChip, strong: styles.editMean, note: styles.editNote }}
      />
      <label className={styles.editField}>
        <span>Why (he sees it after he answers)</span>
        <textarea value={why} rows={2} onChange={(e) => setWhy(e.target.value)} aria-label="Why" />
      </label>
      <ErrorBanner message={error} />
      <div className={styles.editActions}>
        <button type="button" className={nb.btnPrimary} disabled={busy || !ready} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={nb.btnSm} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Decisions({ results, quizId, onChanged }: { results: RepResults; quizId: number; onChanged: () => void }) {
  const motionLab = useMayUseMotionLab();
  const [editing, setEditing] = useState<number | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(false);
  /** Move a decision up or down: the order players meet them in. */
  const move = async (index: number, by: -1 | 1) => {
    const ids = results.decisions.map((d) => d.question_id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    setMoving(true);
    try {
      await reorderQuestions(quizId, ids);
      onChanged();
    } finally {
      setMoving(false);
    }
  };
  const edit = (id: number) => {
    setEditing(id);
    listConcepts()
      .then((list) => setConcepts(list.filter((c) => !c.is_archived)))
      .catch(() => setConcepts([]));
  };
  return (
    <section className={styles.section} aria-label="Decisions">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Decisions</h2>
        <button type="button" className={styles.addOpen} aria-expanded={adding} onClick={() => setAdding((open) => !open)}>
          + Add decisions
        </button>
      </div>
      {adding && (
        <AddDecisions
          repId={quizId}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
      <ol className={styles.decisions}>
        {results.decisions.map((d, i) => {
          const total = d.choices.reduce((n, c) => n + c.count, 0);
          return (
            <li key={d.question_id} className={styles.decision}>
              <div className={styles.order}>
                <button type="button" aria-label={`Move decision ${d.number} up`} disabled={moving || i === 0} onClick={() => void move(i, -1)}>
                  ▲
                </button>
                <span className={styles.orderNum}>{d.number}</span>
                <button
                  type="button"
                  aria-label={`Move decision ${d.number} down`}
                  disabled={moving || i === results.decisions.length - 1}
                  onClick={() => void move(i, 1)}
                >
                  ▼
                </button>
              </div>
              {d.image && <img className={styles.thumb} src={resolveMediaUrl(d.image.image_url)} alt="" />}
              <div className={styles.decisionBody}>
                <div className={styles.decisionTop}>
                  <RoleField quizId={quizId} decision={d} onChanged={onChanged} />
                  {editing !== d.question_id && (
                    <button type="button" className={styles.editOpen} onClick={() => edit(d.question_id)} aria-label={`Edit decision ${d.number}`}>
                      Edit
                    </button>
                  )}
                </div>
                {editing === d.question_id ? (
                  <DecisionEditor
                    quizId={quizId}
                    decision={d}
                    concepts={concepts}
                    onCancel={() => setEditing(null)}
                    onSaved={() => {
                      setEditing(null);
                      onChanged();
                    }}
                  />
                ) : (
                  <span className={styles.decisionPrompt}>{d.question_text}</span>
                )}
                {editing !== d.question_id && d.concept && <span className={styles.decisionConcept}>{d.concept.name}</span>}
                <ul className={styles.bars} hidden={editing === d.question_id}>
                  {d.choices.map((c) => (
                    <li key={c.option_id} className={c.is_correct ? styles.barRight : styles.bar}>
                      <span className={styles.barLabel}>
                        {c.is_correct ? '✓ ' : ''}
                        {c.text}
                      </span>
                      <span className={styles.barTrack}>
                        <span className={styles.barFill} style={{ width: total ? `${(c.count / total) * 100}%` : 0 }} />
                      </span>
                      <span className={styles.barCount}>{c.count}</span>
                    </li>
                  ))}
                </ul>
                <span className={styles.median}>
                  {d.median_ms !== null && `${(d.median_ms / 1000).toFixed(1)} s to decide`}
                  {/* REP RESULT -> MOTION LAB: the play this decision was made from. */}
                  {motionLab && d.motion_play_id !== null && (
                    <>
                      {d.median_ms !== null && ' · '}
                      <Link to={`/motion-lab/plays/${d.motion_play_id}`} className={styles.edit}>
                        Open the play
                      </Link>
                    </>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Players({ results }: { results: RepResults }) {
  return (
    <section className={styles.section} aria-label="Players">
      <h2 className={styles.sectionTitle}>Players</h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Player</th>
            <th>First try</th>
            <th>Time</th>
            <th>Runs</th>
          </tr>
        </thead>
        <tbody>
          {results.players.map((p) => (
            <tr key={p.key}>
              <td>
                {p.display_name}
                {p.position ? <span className={styles.pos}> {p.position}</span> : null}
              </td>
              <td className={p.correct < p.answered ? styles.missedCell : ''}>
                {p.correct} of {p.answered}
              </td>
              <td>{p.total_ms ? `${(p.total_ms / 1000).toFixed(1)} s` : '-'}</td>
              <td>{p.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
