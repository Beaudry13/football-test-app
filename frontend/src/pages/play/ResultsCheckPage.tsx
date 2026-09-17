import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  getPlayerResults,
  getResultsIdentities,
  type PlayerResultsWithAuth,
  type ResultsIdentity,
} from '../../api/play';
import { getErrorMessage } from '../../api/client';
import type { PlayerResultsResponse } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { PlayerAvatar } from '../../components/PlayerAvatar';
import { PeiraLogo } from '../../components/brand/PeiraLogo';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { clearAttemptToken, readAttemptToken, saveAttemptToken } from './attemptToken';
import { PinStep } from './PinStep';
import { isAuthRefusal, pinNoticeFor } from './playerEntry';
import {
  forgetPlayer,
  playerTag,
  rememberPlayer,
  rememberedPlayer,
  type RememberedPlayer,
} from './playerSession';
import { ResultsView } from './ResultsView';
import player from '../../styles/player.module.css';
import styles from './PlayPage.module.css';

type View =
  | { name: 'code' }
  | { name: 'pick'; code: string; identities: ResultsIdentity[]; remembered: RememberedPlayer | null }
  | { name: 'typed'; code: string }
  | { name: 'pin'; code: string; who: RememberedPlayer & { playerId: number }; notice: string | null }
  | { name: 'results'; results: PlayerResultsResponse };

function identityPlayer(identity: ResultsIdentity): RememberedPlayer {
  return {
    playerId: identity.player_id,
    name: identity.name,
    jerseyNumber: identity.jersey_number ?? null,
    position: identity.position ?? null,
  };
}

/** A player's results, revisitable after the code expires.
 *
 *  /results/:code/:playerName  - the bookmark SubmittedStep offers, opened
 *  straight away for the player it names;
 *  /results                    - the code, then "Choose your name", then a PIN
 *  if (and only if) the server asks for one.
 *
 *  The SAME shared-device rule as the quiz: a token stored on this device is
 *  used only for the player this device remembers for the code. Choosing a
 *  name from the list never uses one. */
export function ResultsCheckPage() {
  const params = useParams<{ code?: string; playerName?: string }>();
  const [searchParams] = useSearchParams();
  // Set only on the link SubmittedStep generates for a canonical player.
  const playerIdParam = searchParams.get('player_id');
  const linkedPlayerId = playerIdParam ? Number(playerIdParam) : undefined;

  const [view, setView] = useState<View>({ name: 'code' });
  // `?code=` pre-fills the box: the join screen links here when a code expired.
  const [code, setCode] = useState((params.code ?? searchParams.get('code') ?? '').toUpperCase());
  const [typedName, setTypedName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const show = useCallback((codeValue: string, who: RememberedPlayer, found: PlayerResultsWithAuth) => {
    if (found.player_auth && who.playerId !== null) {
      rememberPlayer(codeValue, who);
      saveAttemptToken(codeValue, who.playerId, found.player_auth.attempt_token);
    }
    const { player_auth: _auth, ...shown } = found;
    setView({ name: 'results', results: shown });
  }, []);

  /** Open results for one player. `continuing` = the remembered player on this
   *  device, the only case a stored token is sent. */
  const open = useCallback(
    async (codeValue: string, who: RememberedPlayer, continuing: boolean) => {
      setError(null);
      setIsLoading(true);
      const token =
        continuing && who.playerId !== null ? readAttemptToken(codeValue, who.playerId) : null;
      try {
        const found = await getPlayerResults(
          codeValue,
          who.name,
          who.playerId ?? undefined,
          ...(token ? [{ token }] : []),
        );
        show(codeValue, who, found);
      } catch (err) {
        if (who.playerId !== null && isAuthRefusal(err)) {
          if (token) clearAttemptToken(codeValue, who.playerId);
          setView({
            name: 'pin',
            code: codeValue,
            who: { ...who, playerId: who.playerId },
            notice: pinNoticeFor(err.reason, token !== null),
          });
        } else {
          setError(getErrorMessage(err));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [show],
  );

  useEffect(() => {
    if (params.code && params.playerName) {
      const name = decodeURIComponent(params.playerName);
      const remembered = rememberedPlayer(params.code);
      const who: RememberedPlayer =
        remembered && remembered.playerId === (linkedPlayerId ?? null)
          ? remembered
          : { playerId: linkedPlayerId ?? null, name, jerseyNumber: null, position: null };
      void open(params.code, who, remembered?.playerId === (linkedPlayerId ?? null));
    }
    // Only the route params (and the query param riding alongside them on
    // first load) should re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.code, params.playerName]);

  const results = view.name === 'results' ? view.results : null;
  useDocumentTitle(results ? `${results.quiz_title} | Peira` : undefined);

  async function handleCode(event: FormEvent) {
    event.preventDefault();
    const value = code.trim();
    if (!value) return;
    setError(null);
    setIsLoading(true);
    try {
      const { identities } = await getResultsIdentities(value);
      setView({ name: 'pick', code: value, identities, remembered: rememberedPlayer(value) });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }

  function handleTyped(event: FormEvent) {
    event.preventDefault();
    if (view.name !== 'typed' || !typedName.trim()) return;
    void open(view.code, { playerId: null, name: typedName.trim(), jerseyNumber: null, position: null }, false);
  }

  const shell = (children: ReactNode) => (
    <div className={`${player.playerTheme} ${styles.wrapper}`}>
      <div className={styles.brandRow}>
        <PeiraLogo variant="light" markOnly size={28} />
      </div>
      {children}
    </div>
  );

  if (view.name === 'results') return shell(<ResultsView results={view.results} />);

  if (view.name === 'pin') {
    return shell(
      <PinStep
        title="See your results"
        player={view.who}
        notice={view.notice ?? 'Enter your PIN to see your results.'}
        onSubmitPin={async (pin) => {
          const found = await getPlayerResults(view.code, view.who.name, view.who.playerId, { pin });
          show(view.code, view.who, found);
        }}
        onNotYou={() => {
          forgetPlayer(view.code);
          setError(null);
          setView({ name: 'code' });
        }}
      />,
    );
  }

  if (params.code && params.playerName) {
    // The bookmark: nothing to choose, just what happened.
    return shell(
      <div className={`card ${styles.panel}`}>
        <h1>Your results</h1>
        {isLoading ? <p>Checking…</p> : <ErrorBanner message={error} />}
      </div>,
    );
  }

  if (view.name === 'pick') {
    const { remembered } = view;
    return shell(
      <div className={`card ${styles.panel}`}>
        <h1>Check your results</h1>
        <ErrorBanner message={error} />
        {remembered ? (
          <div className={styles.continueCard}>
            <button
              className="btn btn-primary"
              disabled={isLoading}
              onClick={() => void open(view.code, remembered, true)}
            >
              {`Continue as ${remembered.name}${playerTag(remembered) ? ` · ${playerTag(remembered)}` : ''}`}
            </button>
            <button
              type="button"
              className={styles.quietLink}
              onClick={() => {
                forgetPlayer(view.code);
                setView({ ...view, remembered: null });
              }}
            >
              Not you? Choose your name
            </button>
          </div>
        ) : (
          <>
            <p>Choose your name.</p>
            <div className={styles.nameGrid}>
              {view.identities.map((identity) => {
                const who = identityPlayer(identity);
                const tag = playerTag(who);
                return (
                  <button
                    key={identity.player_id ?? `legacy:${identity.name}`}
                    className={styles.nameButton}
                    disabled={isLoading}
                    aria-label={tag ? `${identity.name} (${tag})` : identity.name}
                    onClick={() => void open(view.code, who, false)}
                  >
                    <PlayerAvatar name={identity.name} photoUrl={null} size="sm" tone="neutral" />
                    <span className={styles.nameButtonText}>
                      <span className={styles.nameButtonName}>{identity.name}</span>
                      {tag && <span className={styles.nameButtonTag}>{tag}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={styles.quietLink}
              onClick={() => {
                setError(null);
                setView({ name: 'typed', code: view.code });
              }}
            >
              My name isn't listed
            </button>
          </>
        )}
      </div>,
    );
  }

  if (view.name === 'typed') {
    return shell(
      <form className={`card ${styles.panel}`} onSubmit={handleTyped}>
        <h1>Check your results</h1>
        <p>Type the name you played under.</p>
        <ErrorBanner message={error} />
        <div className="field">
          <input value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder="Your name" />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={isLoading || !typedName.trim()}
          style={{ width: '100%' }}
        >
          {isLoading ? 'Checking…' : 'View results'}
        </button>
      </form>,
    );
  }

  return shell(
    <form className={`card ${styles.panel}`} onSubmit={handleCode}>
      <h1>Check your results</h1>
      <p>Enter the access code for the quiz.</p>
      <ErrorBanner message={error} />
      <div className="field">
        <input
          className={styles.codeInput}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={16}
          placeholder="CODE"
          aria-label="Access code"
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={isLoading || !code.trim()} style={{ width: '100%' }}>
        {isLoading ? 'Checking…' : 'Continue'}
      </button>
    </form>,
  );
}
