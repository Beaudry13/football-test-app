import { useEffect, useRef } from 'react'
import type { Play } from './engine/play'
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH } from './playImage'

/**
 * The play, small: what a coach recognises before the name. The same picture
 * as a quiz question's (playImage.ts), scaled down - formation, routes, ball.
 */
export function PlayThumb({ play, width, height, className, routes = true }: { play: Play; width: number; height: number; className?: string; routes?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.setTransform(canvas.width / IMAGE_WIDTH, 0, 0, canvas.height / IMAGE_HEIGHT, 0, 0)
    drawPlay(ctx, play, { routes })
  }, [play, routes])
  return <canvas ref={ref} className={className} width={width} height={height} aria-hidden="true" />
}
