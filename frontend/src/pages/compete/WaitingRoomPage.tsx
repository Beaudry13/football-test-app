/**
 * The player's waiting room, and the reconnect that rebuilds it.
 *
 * THE RECONNECT IS THE POINT OF THIS SCREEN
 * ------------------------------------------
 * A phone locks, a browser reloads a backgrounded tab, a player drops wifi.
 * On mount this reads the seat token from sessionStorage and asks the server
 * who that is - it does NOT trust a name or an id kept in memory. If the
 * server rejects the token, the seat is cleared once and the player is offered
 * an honest way back. It never retries a dead token in a loop.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import type { CompetitionPollState } from '../../api/competition';
import { useCompetitionPoll } from './useCompetitionPoll';
import { CompetitionShell } from './CompetitionShell';
import { PlayerQuestionScreen, PlayerRevealScreen } from './PlayerRoundScreens';
import { PlayerStanding } from './LeaderboardStages';
import { PlayerPodium } from './PodiumStages';
import { clearSeat, seatFor } from './competitionSeat';
import styles from './Competition.module.css';

/** Why the seat is gone. Each needs a different sentence to the player. */
type Lost = 'removed' | 'ended' | 'expired' | 'unknown';

export function WaitingRoomPage() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const seat = seatFor(code);
  // Render the stored name immediately so a refresh shows the player's own
  // name rather than a blank screen while the server answers.
  const [displayName, setDisplayName] = useState(seat?.displayName ?? '');
  const [lost, setLost] = useState<Lost | null>(null);
  const [round, setRound] = useState<competitionApi.PlayerRound | null>(null);

  /** Drop the dead credential exactly once, then explain. */
  const loseSeat = useCallback((why: Lost) => {
    clearSeat();
    setLost(why);
  }, []);

  // No seat at all - a bookmark, or a cleared tab. Send them to the picker.
  //
  // NOTE the /join suffix. `/compete/:code` is THIS page, so redirecting there
  // was an infinite loop - caught by the test below, not by reading the code.
  useEffect(() => {
    if (!seat && !lost) navigate(`/compete/${code}/join`, { replace: true });
  }, [seat, lost, code, navigate]);

  /** Verify the token against the server, and restore the real identity. */
  const restore = useCallback(async () => {
    if (!seat) return;
    try {
      const resumed = await competitionApi.resumeCompetition(code, seat.token);
      setDisplayName(resumed.participant.display_name);
      // ABANDONED only. COMPLETE means the competition FINISHED - the player
      // has just been shown their final result, and throwing it away for a
      // generic "your coach ended this" card would delete the payoff at the
      // exact moment it arrives.
      if (resumed.status === 'ABANDONED') loseSeat('ended');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The token is wrong, or the coach removed this participant. The
        // server deliberately does not distinguish those, so neither can we -
        // "removed" is the honest and far more likely explanation.
        loseSeat('removed');
      } else if (err instanceof ApiError && err.status === 410) {
        loseSeat('expired');
      } else if (err instanceof ApiError && err.status === 404) {
        loseSeat('unknown');
      }
      // Anything else is transient; the poll below keeps trying.
    }
  }, [code, seat, loseSeat]);

  /** The current question and this player's own state, from the server.
   *
   * Fetched on mount and on every version change - never on the 1 Hz timer,
   * which stays a handful of scalars. A refresh mid-question therefore comes
   * back to the right screen showing the right remaining time, because the
   * timestamps come from the server rather than from anything kept locally.
   */
  const loadRound = useCallback(async () => {
    if (!seat) return;
    try {
      setRound(await competitionApi.getPlayerRound(code, seat.token));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) loseSeat('removed');
      // Anything else is transient; the poll keeps trying.
    }
  }, [code, seat, loseSeat]);

  useEffect(() => {
    void restore();
    void loadRound();
    // Runs once per mount - this IS the reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The same server errors, given the same words wherever they arrive.
   *
   * `restore()` already distinguished 404 from 410; the poll collapsed both
   * into "your coach has ended this competition", which was harmless while
   * that sentence was generic. M2.6 made it specific - it is now the ABANDONED
   * message - so an expired code started telling a player something that had
   * not happened.
   */
  const lostFromStatus = useCallback(
    (status: number): Lost => (status === 410 ? 'expired' : 'unknown'),
    [],
  );

  const { state, degraded } = useCompetitionPollForPlayer(code, lost === null, {
    // NO LOBBY FETCH. The player count now rides along on the cheap poll, so
    // this screen never pulls the roster - it does not need other people's
    // names, and fetching them was the single biggest source of load in the
    // 30-player harness.
    //
    // The one thing still worth doing on a version change is re-verifying the
    // seat: a removal bumps the version, and that is how a removed player
    // finds out promptly without any per-second private request.
    onVersionChange: useCallback(async () => {
      await restore();
      await loadRound();
    }, [restore, loadRound]),
    onEnded: useCallback(() => loseSeat('ended'), [loseSeat]),
    onGone: useCallback(
      (status: number) => loseSeat(lostFromStatus(status)),
      [loseSeat, lostFromStatus],
    ),
  });

  const participantCount = state?.participant_count ?? null;

  if (lost) {
    const COPY: Record<Lost, { title: string; body: string }> = {
      removed: {
        title: 'You’re no longer in this competition',
        body: 'Your coach removed this connection. You can join again with your name.',
      },
      ended: {
        title: 'Competition ended',
        body: 'Your coach has ended this competition.',
      },
      expired: {
        title: 'This code has expired',
        body: 'Ask your coach to start a new competition.',
      },
      unknown: {
        title: 'Competition unavailable',
        body: 'This competition is no longer available.',
      },
    };
    const copy = COPY[lost];
    return (
      <CompetitionShell>
        <div className={styles.waitingRoom}>
          <h1 className={styles.headline}>{copy.title}</h1>
          <p className={styles.subhead}>{copy.body}</p>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => navigate(`/compete/${code}/join`)}
          >
            {lost === 'removed' ? 'Join again' : 'Back to join'}
          </button>
        </div>
      </CompetitionShell>
    );
  }

  const status = state?.status;

  // --- A round is running --------------------------------------------------
  //
  // Which screen shows is driven by the SERVER's status, not by anything this
  // component remembers - so a refresh, a sleeping phone or a dropped poll all
  // converge on whatever the room is actually doing.
  //
  // THE STATUS COMES FROM `round`, NOT FROM THE POLL, AND THAT MATTERS.
  // The two arrive separately: the 1 Hz poll carries the new status, and the
  // round payload - question, result, standing, podium - is fetched afterwards
  // because the version changed. Driving the screen from the poll therefore
  // rendered one paint with the NEW status and the OLD data, which matched no
  // branch and fell through to the generic waiting screen.
  //
  // Measured with a MutationObserver during the M2.6 walkthrough: 73ms of
  // "Waiting for your coach..." between the locked question and the reveal -
  // a full-screen swap at the exact moment the teaching payoff lands. 73ms is
  // the LOCALHOST floor; that gap is one round-trip, so on a phone over mobile
  // data it is several hundred milliseconds.
  //
  // `round` is internally consistent - its status always describes its own
  // data - so gating on it means the player holds the last coherent screen
  // until the next one is genuinely ready. Nothing is ever half-rendered.
  const roundStatus = round?.status;
  if (round && seat && roundStatus && roundStatus !== 'LOBBY') {
    return (
      <CompetitionShell live>
        {roundStatus === 'QUESTION_OPEN' ? (
          <PlayerQuestionScreen
            round={round}
            joinCode={code}
            token={seat.token}
            onAnswered={loadRound}
          />
        ) : roundStatus === 'QUESTION_REVEAL' && round.result ? (
          <PlayerRevealScreen round={round} />
        ) : roundStatus === 'LEADERBOARD' && round.standing ? (
          <PlayerStanding standing={round.standing} />
        ) : round.podium && round.final_result ? (
          <PlayerPodium podium={round.podium} result={round.final_result} />
        ) : (
          // Genuinely nothing to show for this state. With the gate above
          // reading `round`, reaching here means the server sent a round whose
          // own status carries no renderable payload - not a race.
          <div className={styles.waitingRoom}>
            <h1 className={styles.playerName}>{displayName}</h1>
            <p className={styles.waitingDots}>Waiting for your coach…</p>
          </div>
        )}
        {degraded && (
          <div className={styles.notice} role="status">
            Reconnecting… you’re still in the competition.
          </div>
        )}
      </CompetitionShell>
    );
  }

  return (
    <CompetitionShell live>
      <div className={styles.waitingRoom}>
        <div className={styles.youreIn}>You’re in</div>
        <h1 className={styles.playerName}>{displayName || '…'}</h1>

        {status === 'LOBBY' || status === undefined ? (
          <p className={styles.waitingDots}>Waiting for your coach to start…</p>
        ) : (
          // An M2 status arriving early must not render a fake game screen.
          <p className={styles.waitingDots}>The competition is under way.</p>
        )}

        {participantCount !== null && (
          <div className={styles.countCard} style={{ minWidth: '12rem' }}>
            <div className={styles.countValue}>{participantCount}</div>
            <div className={styles.countLabel}>Players in the room</div>
          </div>
        )}

        <div className={styles.codeHint}>Code {code.toUpperCase()}</div>

        {degraded && (
          <div className={styles.notice} role="status">
            Reconnecting… you’re still in the competition.
          </div>
        )}
      </div>
    </CompetitionShell>
  );
}

/**
 * The player's poll, wrapped so the waiting room reads clearly.
 *
 * Kept in this file rather than the shared hook because the "session ended"
 * translation is player-specific: a terminal status is information to the
 * host and a dead end to the player.
 */
function useCompetitionPollForPlayer(
  code: string,
  enabled: boolean,
  handlers: {
    onVersionChange: () => Promise<void>;
    onEnded: () => void;
    /** The session itself is gone - 404 for an unknown code, 410 for expiry. */
    onGone: (status: number) => void;
  },
) {
  const { onVersionChange, onEnded, onGone } = handlers;
  return useCompetitionPoll({
    enabled,
    poll: useCallback(() => competitionApi.pollState(code), [code]),
    onVersionChange: useCallback(
      async (next: CompetitionPollState) => {
        // A competition that was STOPPED is over for the player. One that ran
        // to COMPLETE still has a final result to show, so it keeps loading.
        if (next.status === 'ABANDONED') {
          onEnded();
          return;
        }
        await onVersionChange();
      },
      [onEnded, onVersionChange],
    ),
    onFatal: useCallback((error: ApiError) => onGone(error.status), [onGone]),
  });
}

export default WaitingRoomPage;
