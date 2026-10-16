// WHEN THE PLAYER DECIDES - the decision moment's names, on their own so a
// screen that only labels a question (the quiz editor's list, a Rep page) does
// not load Motion Lab's engine to do it. The timeline itself is presnap.ts.

export type DecisionMoment = 'before' | 'mid' | 'snap' | 'after'

export const MOMENT_LABEL: Record<DecisionMoment, string> = {
  before: 'Before motion',
  mid: 'Mid-motion',
  snap: 'Snap',
  after: 'After the snap',
}

/** The moment a stored pre-snap clip freezes at (absent = the snap). */
export function momentOf(presnap: Record<string, unknown> | null | undefined): DecisionMoment {
  const freeze = presnap?.freeze
  return freeze === 'before' || freeze === 'mid' || freeze === 'after' ? freeze : 'snap'
}
