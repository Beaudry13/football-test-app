import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { activateQuiz } from '../../api/accessCodes';
import { deleteQuestion, reorderQuestions, updateQuestion, uploadQuestionImage } from '../../api/questions';
import { duplicateQuiz, updateQuiz } from '../../api/quizzes';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { AddDecisions } from './AddDecisions';
import { createConcept, listConcepts, type Concept } from '../../api/concepts';
import { ConceptPicker } from '../../components/concepts/ConceptPicker';
import { resolveConcept } from '../../components/concepts/conceptMatch';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import { listGroups } from '../../api/groups';
import { listPlayers } from '../../api/players';
import { addRosterMembers } from '../../api/roster';
import { audiencesFrom, chosenPlayerIds, familyOf, groupPlayerIds, pluralFor, suggestedFamily } from './audiences';
import { PositionChips } from './PositionChips';
import { taughtLine } from './taught';
import {
  createRepRetest,
  getRepResults,
  markRepTaught,
  type RepConcept,
  type RepDecision,
  type RepResults,
  type RepTaught,
} from '../../api/reps';
import type { Group, Player } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TeachView, type TeachSlide } from '../../components/teach/TeachView';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import { PlayPicture } from '../../components/football/PlayPicture';
import { spreadTargets, usableTargets, type TapTarget } from '../../components/football/tapTargets';
import { TapCheck } from '../../components/football/TapCheck';
import { TapResult } from '../../components/football/TapResult';
import type { PresnapClip } from '../../motion-lab/presnap';
import type { PlayDraft } from '../../motion-lab/DecisionPlay';
import type { Choice, Retarget } from '../../motion-lab/retargetRep';
import { MOMENT_LABEL, momentOf, type DecisionMoment } from '../../motion-lab/moments';

/* Who it tests and when he decides - Motion Lab's code, loaded only to edit one. */
const DecisionPlay = lazy(() => import('../../motion-lab/DecisionPlay'));
/* Two men with one label: the coach taps the one he means. */
const ChooseMan = lazy(() => import('../../motion-lab/ChooseMan'));
import { playLink } from '../quiz-editor/playUrl';
import nb from '../../styles/notebook.module.css';
import styles from './RepPage.module.css';


/** A decision's tap targets when usable (one per choice, a picture to tap). */
const targetsOf = (d: RepDecision) => usableTargets(d.tap_targets, d.choices.length, !!(d.image || d.presnap));
/** A decision's choices as the picture's answers. */
const choicesOf = (d: RepDecision) => d.choices.map((c) => ({ id: c.option_id, option_text: c.text }));

/** The key a problem is grouped (and marked taught) by: its concept id, or "general". */
const conceptKey = (c: RepConcept) => String(c.concept?.id ?? 'general');


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
  /* TEACH, REMEMBERED ON THE SERVER: opening Teach marks the problem taught on
     this Rep, so its next step is Retest - on every device, for every coach
     who opens the Rep. A failed mark never stops the teaching. */
  const teach = (problem: RepConcept) => {
    setTeaching(problem);
    if (problem.taught) return;
    markRepTaught(id, problem.concept?.id ?? null)
      .then(({ concept_key, taught }) =>
        setResults((r) =>
          r && r.quiz_id === id
            ? { ...r, concepts: r.concepts.map((c) => (conceptKey(c) === concept_key ? { ...c, taught } : c)) }
            : r,
        ),
      )
      .catch(() => undefined);
  };
  /** Retest = a new Rep of this concept for exactly the players who missed it, sent, opened. */
  const retest = async (problem: RepConcept) => {
    const made = await createRepRetest(id, problem.concept?.id ?? null);
    await activateQuiz(made.id, [], 'PRACTICE');
    navigate(`/reps/${made.id}`);
  };
  useDocumentTitle(results ? `${results.title} - Rep` : 'Rep');

  /* A VARIATION: the same Rep copied - every decision with its man, play,
     motion, concept and reason - and opened as a new Rep to change what is
     different. A copy carries no code and no roster: nothing is sent until the
     coach sends it. ?variation=<original> keeps the banner up until Done. */
  const variationOf = Number(params.get('variation')) || null;
  const motionLab = useMayUseMotionLab();
  const [varying, setVarying] = useState(false);
  const makeVariation = async () => {
    if (!results) return;
    setVarying(true);
    setError(null);
    try {
      const copy = await duplicateQuiz(id);
      await updateQuiz(copy.id, { title: `${results.title} - variation` });
      navigate(`/reps/${copy.id}?variation=${id}`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setVarying(false);
    }
  };

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
              {!variationOf && (
                <button type="button" className={styles.variationOpen} disabled={varying} onClick={() => void makeVariation()}>
                  {varying ? 'Copying…' : 'Make a variation'}
                </button>
              )}
            </header>

            {variationOf && (
              <VariationBanner
                key={id}
                results={results}
                quizId={id}
                fromId={variationOf}
                onRenamed={load}
                onDone={() => setParams({}, { replace: true })}
                canOpenPlay={motionLab}
              />
            )}

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
                    taught={problem.taught ?? null}
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
  /* Already on its roster (made for the players who missed a quiz question):
     it goes to them - no position is picked for him. */
  const onRoster = results.audience.code ? [] : results.audience.people;
  const chosen =
    positions ?? (onRoster.length > 0 ? [] : audiences.filter((a) => a.family && a.family === likely).map((a) => a.key));
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
      {onRoster.length > 0 && (
        <span className={styles.hint} role="status">
          Goes to the {onRoster.length} on it: {onRoster.map((p) => p.name).join(', ')}
          {chosen.length > 0 ? ' - and the positions you pick' : ''}
        </span>
      )}
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
  /** Taught on this Rep (any coach, any device): Retest is the next step. */
  taught: RepTaught | null;
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
  /** The problem's most-missed decision answered by tapping - its picture tells the miss. */
  const tapped =
    decisions
      .filter((d) => problem.question_ids.includes(d.question_id) && targetsOf(d))
      .sort((a, b) => b.missed - a.missed)[0] ?? null;
  return (
    <article className={fixed ? `${styles.problem} ${styles.problemFixed}` : styles.problem} aria-label={problem.name}>
      <h2 className={styles.problemName}>
        {/* The problem's history: is it getting better, who still misses it. */}
        {problem.concept ? (
          <Link to={`/reps/concepts/${problem.concept.id}`} className={styles.problemLink}>
            {problem.name}
          </Link>
        ) : (
          problem.name
        )}
      </h2>
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
        taught && <p className={styles.nextLine}>{taughtLine(taught)} Now see if it stuck.</p>
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
      {viewing && tapped && (
        /* WHERE THEY TAPPED, in one glance: the right spot green, every spot
           someone missed to in red, how many on each. */
        <TapResult
          image={tapped.image}
          presnap={tapped.presnap}
          targets={tapped.tap_targets}
          options={choicesOf(tapped)}
          correctIds={tapped.choices.filter((c) => c.is_correct).map((c) => c.option_id)}
          counts={Object.fromEntries(tapped.choices.map((c) => [c.option_id, c.count]))}
          motionKey={`team-${tapped.question_id}`}
        />
      )}
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
      // The play moving to the decision moment, exactly as the players saw
      // it - and, when they tapped, the right spot lit.
      picture: d.presnap || targetsOf(d) ? (
        <PlayPicture
          image={d.image}
          presnap={d.presnap}
          targets={targetsOf(d)}
          options={choicesOf(d)}
          chosen={d.choices.filter((c) => c.is_correct).map((c) => c.option_id)}
          tone="right"
          disabled
          motionKey={d.question_id}
        />
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
/**
 * A VARIATION, JUST MADE: say what it is and that nothing has gone out, let
 * the coach name it, and point at the few things a variation changes - all
 * of them right below, on the same page.
 */
function VariationBanner({
  results,
  quizId,
  fromId,
  onRenamed,
  onDone,
  canOpenPlay = false,
}: {
  results: RepResults;
  quizId: number;
  fromId: number;
  onRenamed: () => void;
  onDone: () => void;
  canOpenPlay?: boolean;
}) {
  const [title, setTitle] = useState(results.title);
  const [error, setError] = useState<string | null>(null);
  /* SAME SITUATION, ANOTHER MAN: every decision re-pointed at him - the ring,
     the words and the picture follow (motion-lab/retargetRep). */
  const [labels, setLabels] = useState<string[]>([]);
  const [label, setLabel] = useState('');
  const [moving, setMoving] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  /* EVERY DECISION AT ONCE: when they decide, and what they are about. */
  const motionDecisions = results.decisions.filter((d) => d.presnap);
  const moments = new Set(motionDecisions.map((d) => momentOf(d.presnap)));
  const sharedMoment = moments.size === 1 ? [...moments][0] : null;
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [concept, setConcept] = useState('');
  useEffect(() => {
    listConcepts()
      .then((list) => setConcepts(list.filter((c) => !c.is_archived)))
      .catch(() => setConcepts([]));
  }, []);
  const everyMoment = async (m: DecisionMoment) => {
    setMoving(true);
    setError(null);
    setSaid(null);
    try {
      const { remomentRep } = await import('../../motion-lab/retargetRep');
      const { changes, skipped } = await remomentRep(results.decisions, m, canOpenPlay);
      for (const c of changes) await updateQuestion(quizId, c.questionId, c.body);
      setSaid(
        [
          `Decide at ${MOMENT_LABEL[m].toLowerCase()}: ${changes.length} ${changes.length === 1 ? 'decision' : 'decisions'} changed.`,
          ...skipped.map((k) => `Decision ${k.number}: ${k.why}.`),
        ].join(' '),
      );
      onRenamed();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setMoving(false);
    }
  };
  const everyConcept = async () => {
    const name = concept.trim();
    if (!name) return;
    setMoving(true);
    setError(null);
    setSaid(null);
    try {
      const picked = resolveConcept(name, concepts) ?? (await createConcept(name));
      for (const d of results.decisions) await updateQuestion(quizId, d.question_id, { concept_id: picked.id });
      setSaid(`Every decision is now about ${picked.name}.`);
      setConcept('');
      onRenamed();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setMoving(false);
    }
  };
  const apply = async (c: Retarget) => {
    await updateQuestion(quizId, c.questionId, c.body);
    if (c.image) await uploadQuestionImage(quizId, c.questionId, c.image);
  };
  const fromPlays = results.decisions.some((d) => d.presnap || d.motion_play_id !== null);
  useEffect(() => {
    if (!fromPlays) return;
    let gone = false;
    import('../../motion-lab/retargetRep')
      .then((m) => m.testableLabels(results.decisions, canOpenPlay))
      .then((found) => !gone && setLabels(found))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [fromPlays, results.decisions, canOpenPlay]);
  const testHim = async () => {
    if (!label) return;
    setMoving(true);
    setError(null);
    setSaid(null);
    setPicked([]);
    try {
      const { retargetRep } = await import('../../motion-lab/retargetRep');
      const { changes, skipped, choose } = await retargetRep(results.decisions, label, canOpenPlay);
      for (const c of changes) await apply(c);
      setChoices(choose);
      const check = changes.filter((c) => c.checkSpots).map((c) => c.number);
      setSaid(
        [
          `Now testing the ${label} in ${changes.length} of ${results.decisions.length} ${results.decisions.length === 1 ? 'decision' : 'decisions'}.`,
          ...skipped.map((k) => `Decision ${k.number}: ${k.why}.`),
          ...(check.length ? [`Check the spots on ${check.map((n) => `decision ${n}`).join(', ')} - they stay where you put them.`] : []),
        ].join(' '),
      );
      onRenamed();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setMoving(false);
    }
  };
  const rename = async () => {
    const next = title.trim();
    if (!next || next === results.title) return;
    setError(null);
    try {
      await updateQuiz(quizId, { title: next });
      onRenamed();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  return (
    <section className={styles.variation} aria-label="Variation">
      <div className={styles.variationTop}>
        <span className={styles.variationKicker}>Variation</span>
        <span className={styles.variationOf}>
          of <Link to={`/reps/${fromId}`}>the original rep</Link> · nothing sent yet
        </span>
        <button type="button" className={nb.btnSm} onClick={onDone}>
          Done
        </button>
      </div>
      <label className={styles.variationName}>
        <span>Name</span>
        <input
          value={title}
          maxLength={200}
          aria-label="Variation name"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
      {labels.length > 0 && (
        <div className={styles.variationMan}>
          <label>
            <span>Same situation, test the </span>
            <select value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Test another man">
              <option value="">pick a man</option>
              {labels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={nb.btnSm} disabled={!label || moving} onClick={() => void testHim()}>
            {moving ? 'Changing…' : 'Test him in every decision'}
          </button>
        </div>
      )}
      {motionDecisions.length > 0 && (
        <div className={styles.variationMan} role="radiogroup" aria-label="Decide at, every decision">
          <span>Decide at</span>
          {(['before', 'mid', 'snap', 'after'] as DecisionMoment[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={sharedMoment === m}
              className={sharedMoment === m ? `${styles.group} ${styles.groupOn}` : styles.group}
              disabled={moving}
              onClick={() => void everyMoment(m)}
            >
              {MOMENT_LABEL[m]}
            </button>
          ))}
        </div>
      )}
      <div className={styles.variationMan}>
        <ConceptPicker
          label="Concept for every decision"
          value={concept}
          onChange={setConcept}
          concepts={concepts}
          classes={{ field: styles.editField, chips: styles.editChips, chip: styles.editChip, strong: styles.editMean, note: styles.editNote }}
        />
        <button type="button" className={nb.btnSm} disabled={!concept.trim() || moving} onClick={() => void everyConcept()}>
          Use it for every decision
        </button>
      </div>
      {said && (
        <p className={styles.variationSaid} role="status">
          {said}
          {picked.length > 0 && ` ${picked.join(' ')}`}
        </p>
      )}
      {choices.map((choice) => (
        <Suspense key={choice.decision.question_id} fallback={null}>
          <ChooseMan
            choice={choice}
            label={label}
            onChosen={async (r) => {
              try {
                await apply(r);
                setChoices((list) => list.filter((c) => c.decision.question_id !== r.questionId));
                setPicked((list) => [...list, `Decision ${r.number}: the ${label} you picked.`]);
                onRenamed();
              } catch (err) {
                setError(getErrorMessage(err));
              }
            }}
          />
        </Suspense>
      ))}
      <p className={styles.variationHint}>
        Change what&rsquo;s different below: the man (Edit → Change man), the question or its answers (Edit), or a new
        play or formation (+ Add decisions, then Remove the old one). Then pick who it goes to and send it.
      </p>
      <ErrorBanner message={error} />
    </section>
  );
}

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
  /* THE WORDS AND THE RING: rewording is fine (same man), but words that name
     another job than the ringed man's would test one man and show another. */
  const ring = decision.subject_man?.label ?? null;
  const wordsJob = suggestedFamily([value]);
  const ringJob = familyOf(ring);
  const mismatch = !!(ring && wordsJob && ringJob && wordsJob !== ringJob);
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
      {ring && <span className={styles.ringNote}>ring on {ring}</span>}
      {mismatch && (
        <span className={styles.ringWarn} role="alert">
          The ring is on the {ring}. To test another man, use Edit → Change man.
        </span>
      )}
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
  canOpenPlay = false,
}: {
  quizId: number;
  decision: RepDecision;
  concepts: Concept[];
  onSaved: () => void;
  onCancel: () => void;
  /** Motion Lab is open to this coach (the play itself can be read). */
  canOpenPlay?: boolean;
}) {
  const locked = !!decision.delivered;
  /* WHO IT TESTS, WHEN HE DECIDES, WHERE HE TAPS - one draft, saved with the
     rest. Once players have it, all three are locked (the server agrees). */
  const fromPlay = !!(decision.presnap || decision.motion_play_id);
  const [draft, setDraft] = useState<PlayDraft>(() => ({
    clip: (decision.presnap as unknown as PresnapClip | null) ?? null,
    man: decision.subject_man ? { id: decision.subject_man.id, label: decision.subject_man.label } : null,
    role: decision.subject_role,
    targets: decision.tap_targets ?? null,
    image: null,
  }));
  const [checking, setChecking] = useState<false | 'look' | 'before-save'>(false);
  const [prompt, setPrompt] = useState(decision.question_text);
  const [answers, setAnswers] = useState(decision.choices.map((c) => ({ text: c.text, correct: c.is_correct })));
  const [concept, setConcept] = useState(decision.concept?.name ?? '');
  const [why, setWhy] = useState(decision.answer_explanation ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = decision.choices.length;
  const filled = answers.filter((a) => a.text.trim());
  const ready = !!prompt.trim() && filled.length >= 2 && filled.some((a) => a.correct);
  const sentCount = (locked ? answers : filled).length;
  const hasPicture = !!(decision.image || draft.clip);
  const targets = draft.targets && draft.targets.length === sentCount && hasPicture ? draft.targets : null;
  const spotIndex = (k: number) => answers.indexOf(filled[k]);
  const moveSpot = (k: number, at: { x: number; y: number }) =>
    setDraft((d) => ({ ...d, targets: (d.targets ?? []).map((t, j) => (j === k ? { ...t, ...at } : t)) as TapTarget[] }));
  const renameSpot = (k: number, text: string) =>
    setAnswers((list) => list.map((a, j) => (j === spotIndex(k) ? { ...a, text } : a)));

  const save = async (spotsChecked = !draft.spotsSuggested) => {
    // Suggested spots are saved only once the coach has seen and confirmed them.
    if (!locked && !spotsChecked && targets) {
      setChecking('before-save');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const name = concept.trim();
      const conceptId = name ? (resolveConcept(name, concepts) ?? (await createConcept(name))).id : null;
      const play: Record<string, unknown> = {};
      if (!locked) {
        const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        if (!same(draft.clip, decision.presnap)) play.presnap = draft.clip;
        if ((draft.man?.id ?? null) !== (decision.subject_man?.id ?? null)) {
          play.subject_man = draft.man?.id ?? null;
          play.subject_role = draft.role;
        }
        // Spots go with exactly one per answer; otherwise the buttons answer.
        if (!same(draft.targets, decision.tap_targets) && (!draft.targets || draft.targets.length === sentCount)) {
          play.tap_targets = draft.targets;
        }
      }
      await updateQuestion(quizId, decision.question_id, {
        question_text: prompt.trim(),
        options: (locked ? answers : filled).map((a) => ({ option_text: a.text.trim(), is_correct_answer: a.correct })),
        concept_id: conceptId,
        answer_explanation: why.trim(),
        ...play,
      });
      // The still follows the ring.
      if (!locked && draft.image && play.subject_man !== undefined) {
        await uploadQuestionImage(quizId, decision.question_id, draft.image);
      }
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className={styles.editor} role="group" aria-label={`Edit decision ${decision.number}`}>
      {locked
        ? (fromPlay || decision.tap_targets) && (
            <p className={styles.editLocked}>
              Players have this one, so who it tests, when they decide and where they tap are locked. Make a variation
              to test something different.
            </p>
          )
        : fromPlay && (
            <Suspense fallback={null}>
              <DecisionPlay
                draft={draft}
                onChange={setDraft}
                playId={decision.motion_play_id}
                canOpenPlay={canOpenPlay}
                answers={filled.map((a) => a.text)}
                firstMan={decision.subject_man?.id ?? null}
              />
            </Suspense>
          )}
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
        {/* WHAT THEY TAP - checked on the very picture the player gets. */}
        {targets ? (
          <>
            {draft.spotsSuggested && <span className={styles.editLocked}>PEIRA suggested these spots - check them.</span>}
            <button type="button" className={styles.editAdd} onClick={() => setChecking('look')}>
              See what they tap
            </button>
          </>
        ) : (
          !locked &&
          hasPicture &&
          filled.length >= 2 && (
            <button
              type="button"
              className={styles.editAdd}
              onClick={() => {
                setDraft((d) => ({ ...d, targets: spreadTargets(filled.length), spotsSuggested: true }));
                setChecking('look');
              }}
            >
              Put them on the field - players tap the spot
            </button>
          )
        )}
      </div>
      {checking && targets && (
        <TapCheck
          image={decision.image}
          presnap={draft.clip}
          targets={targets}
          answers={(locked ? answers : filled).map((a) => a.text)}
          rightIndex={(locked ? answers : filled).findIndex((a) => a.correct)}
          onMove={locked ? undefined : moveSpot}
          onRename={locked ? undefined : renameSpot}
          locked={locked ? 'Players have this one, so its spots are locked.' : undefined}
          lead={checking === 'before-save' ? 'Check the spots before you save.' : undefined}
          onClose={() => setChecking(false)}
          onConfirm={() => {
            const goOn = checking === 'before-save';
            setDraft((d) => ({ ...d, spotsSuggested: false }));
            setChecking(false);
            if (goOn) void save(true);
          }}
        />
      )}
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
  const { confirm, dialog } = useConfirmDialog();
  /** Only a decision nobody has received can go - nothing a player has is lost. */
  const remove = (d: RepDecision) =>
    confirm({
      title: 'Remove this decision?',
      body: 'No player has received it, so nothing is lost but the decision itself.',
      confirmLabel: 'Remove',
      action: async () => {
        await deleteQuestion(quizId, d.question_id);
        onChanged();
      },
    }).catch(() => undefined);
  /** Put decision `from` at `to`: the order players meet them in. */
  const place = async (from: number, to: number) => {
    const ids = results.decisions.map((d) => d.question_id);
    if (from === to || to < 0 || to >= ids.length) return;
    const [picked] = ids.splice(from, 1);
    ids.splice(to, 0, picked);
    setMoving(true);
    try {
      await reorderQuestions(quizId, ids);
      onChanged();
    } finally {
      setMoving(false);
    }
  };
  /** ▲ / ▼ - one step, by keyboard or tap (and the way on a phone). */
  const move = (index: number, by: -1 | 1) => place(index, index + by);
  /* DRAG A DECISION BY ITS GRIP to where it goes - a finger, a mouse or a pen
     alike (pointer events, not the mouse-only drag-and-drop). Only the grip
     starts it, so typing in a decision's fields never does. */
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };
  const grip = (i: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (moving) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDragging(i);
      setOver(i);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (dragging === null) return;
      // The row under the finger - or the nearest one, past either end.
      let best = over ?? dragging;
      let bestD = Infinity;
      rowRefs.current.forEach((row, j) => {
        const box = row?.getBoundingClientRect();
        if (!box) return;
        const d = e.clientY < box.top ? box.top - e.clientY : e.clientY > box.bottom ? e.clientY - box.bottom : 0;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      if (best !== over) setOver(best);
    },
    onPointerUp: () => {
      const from = dragging;
      const to = over;
      endDrag();
      if (from !== null && to !== null && from !== to) void place(from, to);
    },
    onPointerCancel: endDrag,
  });
  const edit = (id: number) => {
    setEditing(id);
    listConcepts()
      .then((list) => setConcepts(list.filter((c) => !c.is_archived)))
      .catch(() => setConcepts([]));
  };
  return (
    <section className={styles.section} aria-label="Decisions">
      {dialog}
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
          const rowClass = [
            styles.decision,
            dragging === i ? styles.dragging : '',
            over === i && dragging !== null && dragging !== i ? (dragging < i ? styles.dropAfter : styles.dropBefore) : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li
              key={d.question_id}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              className={rowClass}
            >
              <div className={styles.order}>
                <span
                  className={styles.grip}
                  title="Drag to move it - or use the arrows"
                  aria-hidden="true"
                  data-testid={`grip-${d.number}`}
                  {...grip(i)}
                >
                  ⠿
                </span>
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
                  <RoleField key={`${d.question_id}-${d.subject_role}`} quizId={quizId} decision={d} onChanged={onChanged} />
                  {editing !== d.question_id && (
                    <button type="button" className={styles.editOpen} onClick={() => edit(d.question_id)} aria-label={`Edit decision ${d.number}`}>
                      Edit
                    </button>
                  )}
                  {editing !== d.question_id && !d.delivered && results.decisions.length > 1 && (
                    <button
                      type="button"
                      className={styles.editOpen}
                      onClick={() => void remove(d)}
                      aria-label={`Remove decision ${d.number}`}
                    >
                      Remove
                    </button>
                  )}
                </div>
                {editing === d.question_id ? (
                  <DecisionEditor
                    quizId={quizId}
                    decision={d}
                    canOpenPlay={motionLab}
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
                {editing !== d.question_id && (d.presnap || targetsOf(d)) && (
                  <span className={styles.decisionHow}>
                    {[
                      d.presnap ? `▶ Decides at ${MOMENT_LABEL[momentOf(d.presnap)].toLowerCase()}` : null,
                      targetsOf(d) ? (d.tap_targets?.some((t) => t.zone) ? '◎ Tap the spot' : '◎ Tap the man') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
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

/** One player's first try, decision by decision. */
function PlayerDecisions({ results, playerKey, name }: { results: RepResults; playerKey: string; name: string }) {
  const first = name.split(' ')[0];
  return (
    <ol className={styles.playerDecisions} aria-label={`${name}'s decisions`}>
      {results.decisions.map((d) => {
        const his = d.answers.find((a) => a.player.key === playerKey);
        if (!his) return null;
        const chosenIds = d.choices.filter((c) => his.chose.includes(c.text)).map((c) => c.option_id);
        return (
          <li key={d.question_id} className={styles.playerDecision}>
            <span className={styles.playerDecisionText}>
              <span className={styles.qNum}>#{d.number}</span> {d.question_text}{' '}
              <strong className={his.is_correct ? styles.tick : styles.missedCell}>
                {his.is_correct ? '✓' : '✕'} {his.chose.join(', ') || '-'}
              </strong>
            </span>
            <TapResult
              image={d.image}
              presnap={d.presnap}
              targets={d.tap_targets}
              options={choicesOf(d)}
              correctIds={d.choices.filter((c) => c.is_correct).map((c) => c.option_id)}
              chosenIds={chosenIds}
              who={`${first} tapped`}
              motionKey={`${playerKey}-${d.question_id}`}
            />
          </li>
        );
      })}
    </ol>
  );
}

function Players({ results }: { results: RepResults }) {
  /* ONE PLAYER, EVERY DECISION: what he answered - and for a tap decision,
     where he tapped against the right spot, on the picture he tapped. */
  const [open, setOpen] = useState<string | null>(null);
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
            <Fragment key={p.key}>
              <tr>
                <td>
                  <button
                    type="button"
                    className={styles.playerOpen}
                    aria-expanded={open === p.key}
                    onClick={() => setOpen((k) => (k === p.key ? null : p.key))}
                  >
                    {open === p.key ? '▾' : '▸'} {p.display_name}
                  </button>
                  {p.position ? <span className={styles.pos}> {p.position}</span> : null}
                </td>
                <td className={p.correct < p.answered ? styles.missedCell : ''}>
                  {p.correct} of {p.answered}
                </td>
                <td>{p.total_ms ? `${(p.total_ms / 1000).toFixed(1)} s` : '-'}</td>
                <td>{p.attempts}</td>
              </tr>
              {open === p.key && (
                <tr className={styles.playerDetail}>
                  <td colSpan={4}>
                    <PlayerDecisions results={results} playerKey={p.key} name={p.display_name} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
