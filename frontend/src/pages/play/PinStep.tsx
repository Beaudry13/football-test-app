import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorBanner } from '../../components/ErrorBanner';
import { PlayerAvatar } from '../../components/PlayerAvatar';
import { pinErrorMessage } from './playerEntry';
import { playerTag, type RememberedPlayer } from './playerSession';
import styles from './PlayPage.module.css';

/** "Enter your PIN" - the one screen a protected player sees between picking
 *  their name and their quiz or results.
 *
 *  THE PIN IS NEVER KEPT. It lives in this component's state until it is sent,
 *  and the box is cleared after every refusal so a wrong guess is not left on
 *  a phone being passed around. Nothing here writes to storage.
 *
 *  Words a player understands: "Incorrect PIN", "Too many attempts". Never a
 *  reason code, a token, or how the server decided. */
export function PinStep({
  title,
  player,
  notice,
  onSubmitPin,
  onNotYou,
  notYouLabel = 'Not you? Choose your name',
}: {
  title: string;
  player: RememberedPlayer;
  /** Why the player is here when they did not just pick their name - e.g.
   *  their coach reset their PIN. */
  notice?: string | null;
  /** Resolves when the PIN opened what it was for; rejects with the server's
   *  refusal, which this screen words for the player. */
  onSubmitPin: (pin: string) => Promise<void>;
  onNotYou: () => void;
  notYouLabel?: string;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  async function check(value: string) {
    if (value.length !== 6 || isChecking) return;
    setError(null);
    setIsChecking(true);
    try {
      await onSubmitPin(value);
    } catch (err) {
      setError(pinErrorMessage(err));
      setPin('');
      input.current?.focus();
    } finally {
      setIsChecking(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void check(pin);
  }

  const tag = playerTag(player);

  return (
    <form className={`card ${styles.panel}`} onSubmit={handleSubmit}>
      <h1>{title}</h1>
      <div className={styles.pinWho}>
        <PlayerAvatar name={player.name} photoUrl={null} size="sm" tone="neutral" />
        <span className={styles.nameButtonText}>
          <span className={styles.nameButtonName}>{player.name}</span>
          {tag && <span className={styles.nameButtonTag}>{tag}</span>}
        </span>
      </div>
      {notice && <p className={styles.pinNotice}>{notice}</p>}
      <ErrorBanner message={error} />
      <div className="field">
        <label htmlFor="player-pin">Enter your PIN</label>
        <input
          id="player-pin"
          ref={input}
          className={styles.pinInput}
          value={pin}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
            setPin(digits);
            // Six digits is the whole PIN: check it without a second tap.
            if (digits.length === 6) void check(digits);
          }}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={6}
          placeholder="••••••"
          disabled={isChecking}
          aria-describedby="player-pin-help"
        />
        <p id="player-pin-help" className={styles.pinHelp}>
          The 6-digit PIN from your coach.
        </p>
      </div>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pin.length !== 6 || isChecking}
        style={{ width: '100%' }}
      >
        {isChecking ? 'Checking…' : 'Continue'}
      </button>
      <button type="button" className={styles.quietLink} onClick={onNotYou} disabled={isChecking}>
        {notYouLabel}
      </button>
    </form>
  );
}
