import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { activateQuiz } from '../../api/accessCodes';
import { updateQuestion } from '../../api/questions';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import { listGroups } from '../../api/groups';
import { createRepRetest, getRepResults, type RepConcept, type RepDecision, type RepResults } from '../../api/reps';
import type { Group } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TeachView, type TeachSlide } from '../../components/teach/TeachView';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { playLink } from '../quiz-editor/playUrl';
import nb from '../../styles/notebook.module.css';
import styles from './RepPage.module.css';

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

  const problems = results?.concepts.filter((c) => c.missed > 0) ?? [];
  const solid = results?.concepts.filter((c) => c.missed === 0 && c.responded > 0) ?? [];
  const who = results?.audience.label ? results.audience.label.toLowerCase() : 'players';
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
                    onTeach={() => setTeaching(problem)}
                    onRetest={async () => {
                      const retest = await createRepRetest(id, problem.concept?.id ?? null);
                      await activateQuiz(retest.id, [], 'PRACTICE');
                      navigate(`/reps/${retest.id}`);
                    }}
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
        <Teach problem={teaching} decisions={results.decisions} onClose={() => setTeaching(null)} />
      )}
    </div>
  );
}

function SendPanel({ results, onSent }: { results: RepResults; onSent: () => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const code = results.audience.code;

  useEffect(() => {
    if (code) return;
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [code]);

  if (code) {
    const link = playLink(code);
    const done = results.players.length;
    return (
      <section className={styles.send} aria-label="Out with players">
        <div className={styles.liveRow}>
          <span className={styles.livePip} aria-hidden="true" />
          <span className={styles.liveText}>
            Out with {results.audience.label ?? 'players'} · {done} of {results.audience.invited} ran it
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
      <div className={styles.groups}>
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
            await activateQuiz(results.quiz_id, picked, 'PRACTICE');
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
  onTeach,
  onRetest,
}: {
  problem: RepConcept;
  who: string;
  decisions: RepDecision[];
  onTeach: () => void;
  onRetest: () => Promise<void>;
}) {
  const [viewing, setViewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = problem.players_missed.slice(0, 8);
  const more = problem.players_missed.length - shown.length;
  const numberOf = (questionId: number) => decisions.find((d) => d.question_id === questionId)?.number;
  return (
    <article className={styles.problem} aria-label={problem.name}>
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
      <div className={styles.actions}>
        <button type="button" className={nb.btnSecondary} aria-expanded={viewing} onClick={() => setViewing((v) => !v)}>
          View players
        </button>
        <button type="button" className={nb.btnSecondary} onClick={onTeach}>
          Teach
        </button>
        <button type="button" className={nb.btnPrimary} onClick={() => setConfirming(true)} disabled={busy}>
          Retest
        </button>
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
function Teach({ problem, decisions, onClose }: { problem: RepConcept; decisions: RepDecision[]; onClose: () => void }) {
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
    };
  });
  return <TeachView title={problem.name} slides={slides} start={Math.max(0, inProblem.indexOf(worst))} onClose={onClose} />;
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

function Decisions({ results, quizId, onChanged }: { results: RepResults; quizId: number; onChanged: () => void }) {
  return (
    <section className={styles.section} aria-label="Decisions">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Decisions</h2>
        <Link to={`/quizzes/${quizId}?tab=questions`} className={styles.edit}>
          Edit
        </Link>
      </div>
      <ol className={styles.decisions}>
        {results.decisions.map((d) => {
          const total = d.choices.reduce((n, c) => n + c.count, 0);
          return (
            <li key={d.question_id} className={styles.decision}>
              {d.image && <img className={styles.thumb} src={resolveMediaUrl(d.image.image_url)} alt="" />}
              <div className={styles.decisionBody}>
                <RoleField quizId={quizId} decision={d} onChanged={onChanged} />
                <span className={styles.decisionPrompt}>{d.question_text}</span>
                <ul className={styles.bars}>
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
                {d.median_ms !== null && <span className={styles.median}>{(d.median_ms / 1000).toFixed(1)} s to decide</span>}
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
