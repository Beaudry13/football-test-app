import { useEffect, useMemo, useRef, useState } from 'react'
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH } from './playImage'
import { frameOptions, MOMENT_LABEL, presnapFrame, presnapTimeline, type PresnapClip } from './presnap'
import styles from './PresnapPicture.module.css'

/**
 * THE PLAY, MOVING: the decision's pre-snap moment run on Motion Lab's own
 * timeline - the motion man goes, the ring goes with the man it marks - and
 * frozen at the decision moment the coach chose (the snap by default).
 * `onDone` fires once, at the freeze; the question waits for it.
 *
 * `still` (a review) and reduced motion skip straight to the frozen moment.
 * `autoplay={false}` (a screen of several questions) waits on the alignment
 * for a tap, so a page of plays does not all start moving at once.
 */
export default function PresnapPicture({
  clip,
  still = false,
  autoplay = true,
  onDone,
  className,
  children,
}: {
  clip: PresnapClip
  still?: boolean
  autoplay?: boolean
  onDone?: () => void
  className?: string
  /** Laid over the picture (the tap targets). */
  children?: React.ReactNode
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const line = useMemo(() => presnapTimeline(clip), [clip])
  const [run, setRun] = useState(0)
  const [frozen, setFrozen] = useState(false)
  const [started, setStarted] = useState(autoplay)
  const done = useRef(onDone)
  done.current = onDone
  const told = useRef(false)

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    const draw = (t: number) => {
      if (!ctx) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      drawPlay(ctx, presnapFrame(clip, line, t), frameOptions(clip, line, t))
    }
    const freeze = () => {
      draw(line.freezeAt)
      setFrozen(true)
      if (!told.current) {
        told.current = true
        done.current?.()
      }
    }
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // Before motion there is nothing to watch: the alignment is the moment.
    if (still || reduced || line.moment === 'before' || !ctx || typeof requestAnimationFrame === 'undefined') {
      freeze()
      return
    }
    setFrozen(false)
    if (!started) {
      draw(line.from)
      return
    }
    let raf = 0
    let began: number | null = null
    // A beat on the alignment first, so the eye is set before anything moves.
    const HOLD = 0.6
    const tick = (now: number) => {
      if (began === null) began = now
      const elapsed = (now - began) / 1000 - HOLD
      const t = line.from + Math.max(0, elapsed)
      if (t >= line.freezeAt) {
        freeze()
        return
      }
      draw(t)
      raf = requestAnimationFrame(tick)
    }
    draw(line.from)
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [clip, line, still, run, started])

  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      <canvas
        ref={canvas}
        className={styles.picture}
        width={IMAGE_WIDTH}
        height={IMAGE_HEIGHT}
        role="img"
        aria-label={frozen ? `The play, ${MOMENT_LABEL[line.moment].toLowerCase()}` : 'The play, moving'}
      />
      {children}
      {!started && !frozen && (
        <button type="button" className={styles.play} onClick={() => setStarted(true)}>
          ▶ Watch the play
        </button>
      )}
      {frozen && <span className={styles.snap}>{MOMENT_LABEL[line.moment]}</span>}
      {frozen && !still && line.moment !== 'before' && (
        <button type="button" className={styles.again} onClick={() => setRun((n) => n + 1)}>
          ↻ Watch again
        </button>
      )}
    </div>
  )
}
