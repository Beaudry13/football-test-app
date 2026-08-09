import { api } from './client';

/** Per-coach read state for What's New.
 *
 *  The server stores one opaque string and knows nothing about what a
 *  release contains - release content lives in help/whatsNew/releases.ts,
 *  beside the Help articles, so shipping one is a single entry and a deploy.
 *
 *  Server-side rather than localStorage on purpose: a coach who reads the
 *  notes on a laptop must not see them unread on their phone. */
export interface WhatsNewState {
  /** The newest release id this coach has seen, or null if they never
   *  opened it - which is how every existing coach gets the indicator once. */
  seen_version: string | null;
}

export function getWhatsNew(): Promise<WhatsNewState> {
  return api.get<WhatsNewState>('/whats-new');
}

export function markWhatsNewSeen(version: string): Promise<WhatsNewState> {
  return api.post<WhatsNewState>('/whats-new/seen', { version });
}
