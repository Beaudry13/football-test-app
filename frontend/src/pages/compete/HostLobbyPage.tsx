/**
 * The host lobby - the screen on the projector while the room fills up.
 *
 * REBUILT FROM THE SERVER, ALWAYS.
 * The route carries the join code, not the session id, because a coach who
 * refreshes (or reopens the tab, or opens it on a different laptop) must get
 * the room back. Nothing here is recovered from React state or navigation
 * state alone: the code resolves to a session id through the server, and the
 * session id fetches the full view. `location.state` is used only as a
 * first-paint shortcut when we happen to have just created the session.
 *
 * ONE SCREEN, EVERY STAGE.
 * The lobby, the live question, the reveal, the standings and the podium are
 * all this component, chosen from the SERVER's status rather than from
 * anything it remembers. That is why a projector recovers correctly from a
 * refresh at any point in a run - there is no client-side sequence to lose.
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import type { CompetitionHostView, CompetitionPollState } from '../../api/competition';
import { isTerminal } from '../../api/competition';
import { CompetitionShell } from './CompetitionShell';
import { HostQuestionStage, HostRevealStage } from './HostRoundStages';
import { HostLeaderboard } from './LeaderboardStages';
import { HostPodium } from './PodiumStages';
import { JoinQr } from './JoinQr';
import { useCompetitionPoll } from './useCompetitionPoll';
import styles from './Competition.module.css';

/** Sport-neutral wording for the backend's deterministic hints. */
const HINTS: Record<string, string> = {
  first_standings: 'Good time to show the first standings.',
  midpoint_standings: 'A good moment for standings, if you want one.',
  keep_the_finish_a_surprise: 'Consider skipping standings to keep the finish a surprise.',
};

export function HostLobbyPage() {
  const { code = '' } = useParams<{ code: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [sessionId, setSessionId] = useState<number | null>(
    (location.state as { sessionId?: number } | null)?.sessionId ?? null,
  );
  const [view, setView] = useState<CompetitionHostView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * THE COACH RECONNECT. Resolve the code in the URL to a session this coach
   * owns, entirely from the server - no reliance on React memory or on the
   * navigation state that only exists right after creation.
   *
   * A coach from another organization gets a 404 here, exactly as they would
   * from a session id, so the code grants no access it did not already imply.
   */
  useEffect(() => {
    if (sessionId !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const hostView = await competitionApi.getHostViewByCode(code);
        if (cancelled) return;
        setView(hostView);
        setSessionId(hostView.id);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'That competition is not available to your account.'
            : 'Could not load this competition.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, sessionId]);

  const loadView = useCallback(async () => {
    if (sessionId === null) return;
    try {
      setView(await competitionApi.getHostView(sessionId));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError('This competition is not available to your account.');
      }
    }
  }, [sessionId]);

  const { state, degraded, refresh } = useCompetitionPoll({
    enabled: sessionId !== null,
    poll: useCallback(
      () => competitionApi.getHostState(sessionId as number),
      [sessionId],
    ),
    // The heavy view is fetched here and ONLY here - on mount and whenever the
    // version moves. A player joining bumps it, so names appear without the
    // coach touching anything, and without a per-second roster fetch.
    onVersionChange: useCallback(
      (_next: CompetitionPollState) => loadView(),
      [loadView],
    ),
    onFatal: useCallback(() => setError('This competition is no longer available.'), []),
  });

  const remove = useCallback(
    async (participantId: number, name: string) => {
      if (sessionId === null) return;
      if (!window.confirm(`Remove ${name} from this competition?`)) return;
      setBusy(true);
      try {
        setView(await competitionApi.removeParticipant(sessionId, participantId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not remove that player.');
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [sessionId, refresh],
  );

  /** Move the room forward. The version guard makes two tabs safe. */
  const advance = useCallback(
    async (action: string) => {
      if (sessionId === null || !state) return;
      setBusy(true);
      try {
        setView(await competitionApi.transition(sessionId, action, state.version));
      } catch (err) {
        if (err instanceof ApiError && err.reason === 'stale_transition') {
          // Another tab moved first. Resync rather than argue.
          await loadView();
        } else {
          setError(err instanceof Error ? err.message : 'Could not move on.');
        }
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [sessionId, state, loadView, refresh],
  );

  /**
   * Finish now, and confirm first if the coach is leaving questions unplayed.
   *
   * FINISH is a one-way door: the transition table has no row back into
   * QUESTION_OPEN from PODIUM, by design. Now that this button sits next to
   * Next question on every reveal rather than only on the last one, a misclick
   * in front of a live room would end the competition several questions early
   * with no way to undo it - so the same guard End competition already uses
   * applies here, but ONLY when there is something left to lose. On the last
   * question there is nothing to warn about and a prompt would just be noise.
   */
  const finish = useCallback(async () => {
    const played = view?.round?.round_number ?? 0;
    const total = view?.round?.total_rounds ?? 0;
    const remaining = Math.max(0, total - played);
    if (
      remaining > 0 &&
      !window.confirm(
        `Finish now and go to the podium? ${remaining} ` +
          `${remaining === 1 ? 'question' : 'questions'} will not be played.`,
      )
    ) {
      return;
    }
    await advance('FINISH');
  }, [view, advance]);

  const end = useCallback(async () => {
    if (sessionId === null) return;
    if (!window.confirm('End this competition? Players will be returned to the join screen.')) return;
    setBusy(true);
    try {
      setView(await competitionApi.endSession(sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not end the competition.');
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const status = view?.status ?? state?.status;
  const ended = status ? isTerminal(status) : false;

  if (error && !view) {
    return (
      <CompetitionShell>
        <h1 className={styles.headline}>Competition unavailable</h1>
        <p className={styles.subhead}>{error}</p>
        <div className={styles.controls}>
          <button type="button" className={styles.button} onClick={() => navigate('/dashboard')}>
            Back to dashboard
          </button>
        </div>
      </CompetitionShell>
    );
  }

  // --- The ending -----------------------------------------------------------
  if (view?.podium && (status === 'PODIUM' || status === 'COMPLETE')) {
    const podium = view.podium;
    const atEnd = podium.step >= podium.last_step;
    return (
      <CompetitionShell live={status === 'PODIUM'}>
        <HostPodium podium={podium} />
        {status === 'COMPLETE' && podium.winners.length > 0 && (
          <p className={styles.subhead} style={{ textAlign: 'center' }}>
            {podium.winners.length === 1 ? 'Winner: ' : 'Winners: '}
            <strong>{podium.winners.join(' · ')}</strong>
          </p>
        )}
        <div className={styles.controls}>
          {status === 'PODIUM' && !atEnd && (
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => advance('ADVANCE_PODIUM')}
              disabled={busy}
            >
              Reveal next
            </button>
          )}
          {status === 'PODIUM' && atEnd && (
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => advance('COMPLETE')}
              disabled={busy}
            >
              Finish
            </button>
          )}
          <button
            type="button"
            className={styles.button}
            onClick={() => navigate('/dashboard')}
          >
            Back to dashboard
          </button>
        </div>
      </CompetitionShell>
    );
  }

  if (ended) {
    return (
      <CompetitionShell>
        <h1 className={styles.headline}>Competition ended</h1>
        <p className={styles.subhead}>
          The join code no longer works and every player has been returned to the join screen.
        </p>
        <div className={styles.controls}>
          <button type="button" className={styles.button} onClick={() => navigate('/dashboard')}>
            Back to dashboard
          </button>
        </div>
      </CompetitionShell>
    );
  }

  const participants = view?.participants ?? [];
  const round = view?.round ?? null;
  const actions = view?.available_actions ?? [];

  // --- A round is running: the stage takes the whole screen ---------------
  if (round && status && status !== 'LOBBY') {
    const revealing = status === 'QUESTION_REVEAL';
    const showingBoard = status === 'LEADERBOARD';
    return (
      <CompetitionShell live>
        {showingBoard ? (
          <HostLeaderboard standings={view?.standings ?? []} />
        ) : revealing ? (
          <HostRevealStage round={round} />
        ) : (
          <HostQuestionStage round={round} poll={state} />
        )}

        <div className={styles.controls}>
          {actions.includes('SHOW_ANSWER') && (
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => advance('SHOW_ANSWER')}
              disabled={busy}
            >
              Show answer
            </button>
          )}
          {actions.includes('SHOW_LEADERBOARD') && (
            <button
              type="button"
              className={styles.button}
              onClick={() => advance('SHOW_LEADERBOARD')}
              disabled={busy}
            >
              Show standings
            </button>
          )}
          {actions.includes('FINISH') && (
            /* SHOWN WHENEVER THE SERVER OFFERS IT, which is every reveal.
               This used to carry `&& !actions.includes('NEXT_QUESTION')`, so
               it appeared only once the quiz ran out of questions - encoding
               "finish means there is nothing left to play" when the rule is
               "finish means the coach has decided to stop". The server never
               shared that reading: (QUESTION_REVEAL, FINISH) -> PODIUM has no
               round condition.

               The cost was a coach running a short competition off a long
               quiz - five questions from a bank of thirty - having NO way to
               end it properly. The only early exit was End competition, which
               always abandons, so the room lost its podium and every player
               got "your coach has ended this competition" instead of a result.
               Found on a real projector at round 3 of 13. */
            <button
              type="button"
              className={styles.button}
              onClick={finish}
              disabled={busy}
            >
              Finish competition
            </button>
          )}
          {actions.includes('NEXT_QUESTION') && (
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => advance('NEXT_QUESTION')}
              disabled={busy}
            >
              Next question
            </button>
          )}
          {/* END is always available and always ABANDONS - it is the "stop, we
              are not doing this" control, not a way to finish. A competition
              finishes by walking the podium to its end. */}
          <button
            type="button"
            className={`${styles.button} ${styles.buttonDanger}`}
            onClick={end}
            disabled={busy}
          >
            End competition
          </button>
        </div>

        {/* The backend owns WHEN to suggest; this only renders the wording.
            Informational: it never transitions, hides or disables a control. */}
        {view?.leaderboard_hint && (
          <p className={styles.hint} role="note">
            {HINTS[view.leaderboard_hint] ?? ''}
          </p>
        )}

        {degraded && (
          <div className={styles.notice} role="status" style={{ marginTop: '1rem' }}>
            Reconnecting… the room is still live.
          </div>
        )}
      </CompetitionShell>
    );
  }

  return (
    <CompetitionShell live>
      <div className={styles.hostGrid}>
        <div>
          <div className={styles.codePanel}>
            <div className={styles.codeLabel}>Join code</div>
            {/* The code comes from the URL so it renders immediately, before
                any request settles - a projector should never show a blank. */}
            <div className={styles.code}>{(view?.join_code ?? code).toUpperCase()}</div>
            {/* The scannable shortcut to the same public join screen, rendered
                from the same code as the letters above so the two cannot
                disagree.

                SHOWN ONLY WHILE THE ROOM ACCEPTS JOINS. The gate is the
                server's own rule - JOINABLE_STATUSES is (LOBBY,) - not "which
                branch of this component happened to render". Those differ: if
                the current question disappears mid-competition the host falls
                back to this grid, and without the status check the projector
                would invite a room to join a competition already in progress.
                `undefined` is included so the first paint, before any request
                settles, still shows it rather than flashing it in. */}
            {(!status || status === 'LOBBY') && <JoinQr code={view?.join_code ?? code} />}
            <div className={styles.codeHint}>Or go to this site and tap Join a competition</div>
          </div>

          <div className={styles.countRow}>
            <div className={styles.countCard}>
              <div className={styles.countValue}>{participants.length}</div>
              <div className={styles.countLabel}>Players joined</div>
            </div>
            <div className={styles.countCard}>
              <div className={styles.countValue}>{view?.eligible_count ?? '—'}</div>
              <div className={styles.countLabel}>On the roster</div>
            </div>
          </div>

          <div className={styles.controls}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => advance('START_QUESTION')}
              disabled={busy || participants.length === 0}
              title={
                participants.length === 0 ? 'Wait for at least one player to join' : undefined
              }
            >
              Start Competition
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonDanger}`}
              onClick={end}
              disabled={busy}
            >
              End lobby
            </button>
          </div>
          {/* This caption said "Standings and the final podium arrive in the
              next release" until M2.6. It was true when M1 shipped the lobby
              and stopped being true at M2.4 and M2.5, which is exactly the
              trap: nothing fails when a caption goes stale, so a coach was
              being told on the projector that shipped features did not exist.
              It now describes the room, which cannot go out of date. */}
          <p className={styles.subhead} style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
            {view
              ? `${view.question_time_seconds} seconds per question · you control the pace`
              : 'Players join with the code above.'}
          </p>

          {degraded && (
            <div className={styles.notice} style={{ marginTop: '1rem' }} role="status">
              Reconnecting… the room is still live.
            </div>
          )}
          {error && (
            <div className={`${styles.notice} ${styles.noticeError}`} style={{ marginTop: '1rem' }} role="alert">
              {error}
            </div>
          )}
        </div>

        <div>
          <div className={styles.sectionTitle}>In the room</div>
          {participants.length === 0 ? (
            <div className={styles.notice}>Waiting for the first player to join…</div>
          ) : (
            <div className={styles.tileGrid}>
              {participants.map((participant) => (
                <div key={participant.id} className={styles.tile}>
                  <span className={styles.tileName}>{participant.display_name}</span>
                  <button
                    type="button"
                    className={styles.tileRemove}
                    onClick={() => remove(participant.id, participant.display_name)}
                    disabled={busy}
                    aria-label={`Remove ${participant.display_name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {(view?.not_joined?.length ?? 0) > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Not here yet</div>
              <div className={styles.tileGrid}>
                {view?.not_joined.map((entry) => (
                  <div
                    key={entry.player_id}
                    className={`${styles.tile} ${styles.waitingTile}`}
                  >
                    <span className={styles.tileName}>{entry.display_name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </CompetitionShell>
  );
}

export default HostLobbyPage;
