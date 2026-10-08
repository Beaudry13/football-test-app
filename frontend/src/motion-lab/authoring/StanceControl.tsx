import { Fragment, useState } from 'react'
import type { Player, StanceId } from '../engine/formation'
import { FAMILY_NAME, defaultStanceFor, stanceChoices, stanceFamilyOf, stanceFullLabel, stanceLabel, stanceOutOfPosition } from './stances'

/**
 * STANCE (V6): the first row of More › Player.
 *
 * Closed, it reads what he will stand in - his chosen stance, or "Position
 * default" with the stance that means for him underneath. Open, it lists what
 * his position is offered in the same radio rows "After the route" uses, with
 * "Use position default" first. Choosing closes it again.
 *
 * "Use position default" CLEARS the stance (onChange(undefined)); the default
 * is shown, never stored. A stance outside his position's list - he was
 * relabelled after it was chosen - stays chosen and is said to be outside it,
 * until the coach picks something else. Nothing here changes it for him.
 */
export function StanceControl({ player, players, onChange }: { player: Player; players: Player[]; onChange: (stance: StanceId | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const current = player.presnapStance
  const groups = stanceChoices(player, players)
  const fallback = defaultStanceFor(player, players)
  const outside = stanceOutOfPosition(player, players)
  const family = stanceFamilyOf(player, players)
  // "Not an offensive line stance", "Not a receiver stance", "Not a defense stance".
  const whose = family ? FAMILY_NAME[family].toLowerCase() : player.side
  const article = /^[aeiou]/.test(whose) ? 'an' : 'a'
  const choose = (stance: StanceId | undefined) => {
    setOpen(false)
    if (stance !== current) onChange(stance)
  }
  const row = (id: StanceId | undefined, text: string) => {
    const on = current === id
    return (
      <button key={id ?? 'default'} className={`more-choice${on ? ' on' : ''}`} role="radio" aria-checked={on} onClick={() => choose(id)}>
        <span className="more-radio" aria-hidden="true">{on ? '●' : '○'}</span>
        {text}
      </button>
    )
  }

  return (
    <div className="more-row stacked stance-row">
      <button className="stance-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="lbl">Stance</span>
        <span className="stance-value">{current ? (outside ? stanceFullLabel(current) : stanceLabel(current)) : 'Position default'}</span>
        <span className="stance-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {!current && !open && <div className="stance-note">{stanceLabel(fallback)}</div>}
      {outside && (
        <div className="stance-note stance-warn">
          Not {article} {whose} stance — kept until you choose another.
        </div>
      )}
      {open && (
        <div className="more-choices" role="radiogroup" aria-label="Stance">
          {row(undefined, `Use position default (${stanceLabel(fallback)})`)}
          {groups.map((g) => (
            <Fragment key={g.family}>
              {groups.length > 1 && <div className="stance-family">{FAMILY_NAME[g.family]}</div>}
              {g.ids.map((id) => row(id, stanceLabel(id)))}
            </Fragment>
          ))}
          {outside && current && row(current, stanceFullLabel(current))}
        </div>
      )}
    </div>
  )
}
