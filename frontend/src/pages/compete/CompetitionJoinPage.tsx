/**
 * Code entry, then "who are you?".
 *
 * TWO RULES FROM THE PRODUCT, NOT FROM CONVENIENCE
 * ------------------------------------------------
 * 1. No free-text name box. Identity is a canonical roster player, chosen from
 *    a list. A typed name would let a player invent an identity the coach's
 *    results cannot be attributed to.
 * 2. No database ids on screen. The picker renders names; the id travels in
 *    the request body because the server needs it, but a player never sees or
 *    types one, and it is never treated as a credential.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import type { CompetitionLobby } from '../../api/competition';
import { CompetitionShell } from './CompetitionShell';
import { clearSeat, seatFor, writeSeat } from './competitionSeat';
import styles from './Competition.module.css';

export function CompetitionJoinPage() {
  const { code: codeParam } = useParams<{ code?: string }>();
  const navigate = useNavigate();

  const [code, setCode] = useState(codeParam?.toUpperCase() ?? '');
  const [lobby, setLobby] = useState<CompetitionLobby | null>(null);
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** A player who already holds a seat here should not be asked again. */
  useEffect(() => {
    if (!codeParam) return;
    const seat = seatFor(codeParam);
    if (seat) navigate(`/compete/${codeParam.toUpperCase()}`, { replace: true });
  }, [codeParam, navigate]);

  /**
   * Fetch the lobby.
   *
   * `keepError` exists for one case: after `identity_taken` we refresh the
   * roster so the seat shows as taken, but that refresh must NOT wipe the
   * explanation we just set. Without it the player watched their name grey
   * out with no reason given - which reads as the app breaking.
   */
  const openLobby = useCallback(async (rawCode: string, keepError = false) => {
    const trimmed = rawCode.trim().toUpperCase();
    if (!trimmed) return;
    setLoading(true);
    if (!keepError) setError(null);
    try {
      setLobby(await competitionApi.getLobby(trimmed));
      setCode(trimmed);
    } catch (err) {
      setLobby(null);
      if (err instanceof ApiError) {
        // Branch on the machine-readable reason, never on the message text.
        if (err.status === 404) setError('That code is not valid. Check it and try again.');
        else if (err.status === 410) setError('That competition has already finished.');
        else setError(err.message);
      } else {
        setError('Could not reach the competition. Check your connection.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (codeParam) void openLobby(codeParam);
  }, [codeParam, openLobby]);

  const choose = useCallback(
    async (playerId: number, displayName: string) => {
      setJoining(playerId);
      setError(null);
      try {
        const result = await competitionApi.joinCompetition(code, playerId);
        // Store the seat BEFORE navigating: a player who closes the tab in
        // between would otherwise hold a seat they can never return to.
        writeSeat({
          joinCode: result.join_code,
          token: result.reconnect_token,
          displayName: result.participant.display_name,
        });
        navigate(`/compete/${result.join_code}`);
      } catch (err) {
        if (err instanceof ApiError && err.reason === 'identity_taken') {
          // Do NOT silently take the seat, and do not reveal anything about
          // whoever holds it. The coach is the one who can see the room.
          setError(
            `${displayName} is already in this competition. If that's you, ask your coach to ` +
              'remove the old connection, then tap your name again.',
          );
          // Whatever we thought we held for this code was wrong.
          clearSeat();
          void openLobby(code, true);
        } else if (err instanceof ApiError && err.reason === 'already_started') {
          setError('This competition has already started.');
        } else if (err instanceof ApiError && err.reason === 'session_expired') {
          setError('This competition code has expired.');
        } else if (err instanceof ApiError && err.reason === 'session_ended') {
          setError('This competition has ended.');
        } else {
          setError('Could not join. Please try again.');
        }
      } finally {
        setJoining(null);
      }
    },
    [code, navigate, openLobby],
  );

  // --- Code entry ---------------------------------------------------------

  if (!lobby) {
    return (
      <CompetitionShell>
        <div className={styles.waitingRoom}>
          <h1 className={styles.headline}>Join a competition</h1>
          <p className={styles.subhead}>Enter the code on your coach’s screen.</p>
        </div>
        <form
          className={styles.joinForm}
          style={{ marginTop: '2rem' }}
          onSubmit={(event) => {
            event.preventDefault();
            void openLobby(code);
          }}
        >
          <label className={styles.fieldLabel} htmlFor="join-code">
            Competition code
          </label>
          <input
            id="join-code"
            className={styles.codeInput}
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="ABC123"
            maxLength={8}
            // A phone keyboard that opens on caps with no autocorrect: the
            // code is six characters read off a screen, not a word.
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            aria-describedby={error ? 'join-error' : undefined}
          />
          {error && (
            <div id="join-error" className={`${styles.notice} ${styles.noticeError}`} role="alert">
              {error}
            </div>
          )}
          <button
            type="submit"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={loading || !code.trim()}
          >
            {loading ? 'Checking…' : 'Enter'}
          </button>
        </form>
      </CompetitionShell>
    );
  }

  // --- Identity picker ----------------------------------------------------

  return (
    <CompetitionShell live>
      <div className={styles.waitingRoom}>
        <h1 className={styles.headline}>Who are you?</h1>
        <p className={styles.subhead}>Tap your name to join {lobby.quiz_title ?? 'the competition'}.</p>
      </div>

      {error && (
        <div
          className={`${styles.notice} ${styles.noticeError}`}
          role="alert"
          style={{ maxWidth: '30rem', margin: '1.5rem auto 0' }}
        >
          {error}
        </div>
      )}

      <div className={styles.identityList} style={{ marginTop: '1.5rem' }}>
        {lobby.roster.length === 0 && (
          <div className={styles.notice}>No players are on the roster for this competition yet.</div>
        )}
        {lobby.roster.map((entry) => (
          <button
            key={entry.player_id}
            type="button"
            className={styles.identityButton}
            onClick={() => choose(entry.player_id, entry.display_name)}
            disabled={entry.taken || joining !== null}
          >
            <span>{entry.display_name}</span>
            {entry.taken ? (
              <span className={styles.takenTag}>Already in</span>
            ) : (
              joining === entry.player_id && <span className={styles.takenTag}>Joining…</span>
            )}
          </button>
        ))}
      </div>
    </CompetitionShell>
  );
}

export default CompetitionJoinPage;
