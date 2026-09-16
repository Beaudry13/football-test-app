import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { OverheadBoard } from './OverheadBoard'
import { derive } from '../__characterization__/capture'
import { engineUnderTest } from '../__characterization__/engineUnderTest'
import { gapPlays, panePlays } from '../__characterization__/fixtures'
import { lineToGainY, type Play } from '../engine/play'
import type { Player } from '../engine/formation'

/**
 * OverheadBoard ON ITS OWN - no editor, no authoring state, nothing but a play
 * and what the engine derives from it - draws the same field the editor draws.
 *
 * Compared against the very snapshots authoring/overheadMarkup.test.tsx took
 * from the prototype editor BEFORE the board was extracted. Passing here means
 * a later read-only surface (a library preview, a teaching page) gets the
 * validated board, not an approximation of it.
 */

function readOnlyBoard(play: Play, time: number) {
  const d = derive(engineUnderTest, play)
  const pathVisible = (p: Player) => play.filter === 'all' || play.filter === p.side
  const { container } = render(
    <OverheadBoard
      // The editor's resting class; the read-only default is plain "board".
      className="board mode-move"
      players={play.players}
      ball={play.ball}
      engagements={play.engagements}
      losYard={play.situation.losYard}
      lineToGain={lineToGainY(play.situation)}
      schedule={d.schedule}
      drawnSchedule={d.drawnSchedule}
      snapAt={d.built.snapAt}
      ballTimeline={d.ballTimeline}
      engaged={d.eng.derived}
      orientation={d.orientation}
      time={time}
      showLabels
      pathVisible={pathVisible}
      selectedId={null}
      present={false}
      strokes={[]}
    />,
  )
  return container.querySelector('svg')!.outerHTML.replace(/></g, '>\n<')
}

const snapshot = (name: string) => `../authoring/__snapshots__/overhead/${name}.svg.html`

describe('OverheadBoard, read-only', () => {
  it.each([
    ['Trips Out', 0, 'trips-out-t0'],
    ['Trips Out', 1.6, 'trips-out-t1.6'],
    ['Untitled Play', 0, 'continuation-t0'],
  ] as const)('%s at t=%s matches the editor', async (name, t, file) => {
    await expect(readOnlyBoard(panePlays().find((p) => p.name === name)!, t)).toMatchFileSnapshot(snapshot(file))
  })

  it.each([
    ['fx_motion_pitch', 1.2, 'motion-pitch-t1.2'],
    ['fx_engage_release_delayed', 0.8, 'engage-t0.8'],
    ['fx_settle_throw_from_here', 1.9, 'settle-throw-t1.9'],
  ] as const)('%s at t=%s matches the editor', async (id, t, file) => {
    await expect(readOnlyBoard(gapPlays().find((p) => p.id === id)!, t)).toMatchFileSnapshot(snapshot(file))
  })
})
