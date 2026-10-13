import type { Point } from '../config'

export type HeldSegment = { from: Point; to: Point; seconds: number }

const maxSeconds = 0.1
const maxSegments = 64

/** Time-weighted geometry for a continuous source, with bounded recent work. */
export class HeldPath {
  point: Point
  private time: number
  private seconds = 0
  private readonly segments: HeldSegment[] = []

  constructor(point: Point, time: number) { this.point = point; this.time = time }

  get ready() { return this.segments.length > 0 }

  move(point: Point, time?: number) {
    // Untimed programmatic moves retain the historical endpoint behavior.
    if (time === undefined || !Number.isFinite(time) || time <= this.time) { this.point = point; return }
    this.append({ from: this.point, to: point, seconds: (time - this.time) / 1000 })
    this.point = point
    this.time = time
  }

  advance(time: number) { this.move(this.point, time) }

  take() {
    const segment = this.segments.shift()
    if (segment) this.seconds = Math.max(0, this.seconds - segment.seconds)
    return segment
  }

  private append(segment: HeldSegment) {
    const previous = this.segments.at(-1)
    if (previous && this.mergeable(previous, segment)) {
      previous.to = segment.to
      previous.seconds += segment.seconds
    } else this.segments.push(segment)
    this.seconds += segment.seconds
    while (this.segments.length > maxSegments) this.take()
    // Trim time and geometry together, so a stalled frame cannot turn stale
    // travel into a burst at the current pointer position.
    while (this.seconds > maxSeconds + 1e-12) {
      const first = this.segments[0]
      const excess = this.seconds - maxSeconds
      if (first.seconds <= excess + 1e-12) this.take()
      else {
        const fraction = excess / first.seconds
        first.from = { x: first.from.x + (first.to.x - first.from.x) * fraction, y: first.from.y + (first.to.y - first.from.y) * fraction }
        first.seconds -= excess
        this.seconds -= excess
      }
    }
  }

  private mergeable(a: HeldSegment, b: HeldSegment) {
    if (Math.hypot(a.to.x - b.from.x, a.to.y - b.from.y) > 1e-8) return false
    const ax = (a.to.x - a.from.x) / a.seconds, ay = (a.to.y - a.from.y) / a.seconds
    const bx = (b.to.x - b.from.x) / b.seconds, by = (b.to.y - b.from.y) / b.seconds
    // Equal velocities merge coalesced samples without changing residence
    // time. Turns, stops and speed changes keep their own contribution.
    return Math.hypot(ax - bx, ay - by) <= 1e-5 * Math.max(1, Math.hypot(ax, ay), Math.hypot(bx, by))
  }
}
