import { useEffect, useState } from 'react';
import { getOrganization } from '../api/organizations';

/** DOES THIS ORGANIZATION USE PLAYER PIN SECURITY?
 *
 *  PIN security is optional and OFF by default, so PIN management must not
 *  appear on roster screens until a staff admin has chosen it (Team →
 *  Coaches). An organization that has not opted in should see the Players page
 *  it had before PINs existed - no PIN column, no "players don't have a PIN
 *  yet" count, nothing that reads as unfinished setup.
 *
 *  FALSE WHILE LOADING, deliberately: a page must never flash a missing-PIN
 *  warning at an organization that does not use PINs.
 *
 *  This only decides what is DRAWN. Whether a PIN is actually required is the
 *  server's answer (services/player_enforcement), which also needs the
 *  platform switch - see docs/PLAYER-PIN-SECURITY.md.
 */
export function usePinSecurity(): { enabled: boolean; isLoading: boolean } {
  const [enabled, setEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getOrganization()
      .then((organization) => {
        if (!cancelled) setEnabled(organization.player_pin_security_enabled === true);
      })
      .catch(() => {
        // The roster is what the coach came for; it must render either way.
        // Unknown means "do not show PIN management", the quieter mistake.
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { enabled, isLoading };
}
