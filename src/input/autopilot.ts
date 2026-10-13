import type { ContactTool, Point } from '../config'
import type { StrokeQueue } from './strokes'

export const GARDEN_PATTERNS = ['garden', 'spiral', 'waves'] as const
export type GardenPattern = (typeof GARDEN_PATTERNS)[number]
export type Bounds = { minX: number; maxX: number; minY: number; maxY: number }

const autopilotPointer = -2
const pointSpacing = 0.003
// Bed metres per second: brisk enough to finish a garden in tens of seconds,
// slow enough that the rake carves clean grooves without spray.
export const AUTOPILOT_SPEED = 0.3
export type AutopilotTool = { tool: ContactTool; radius: number; speed: number }

/**
 * Rake half-width for a garden in `bounds`: the user's rake, narrowed so at
 * least ten passes fit across the shorter side of the view.
 */
export function gardenReach(bounds: Bounds, userReach: number) {
  const shorter = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
  return Math.max(0.02, Math.min(userReach, shorter / 20))
}

function polyline(points: Point[]): Point[] {
  const result: Point[] = []
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index]
    const to = points[index + 1]
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / pointSpacing))
    for (let step = 0; step < steps; step++) result.push({ x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps })
  }
  if (points.length) result.push(points[points.length - 1])
  return result
}

function circle(center: Point, radius: number, start: number): Point[] {
  const steps = Math.max(24, Math.ceil(Math.PI * 2 * radius / pointSpacing))
  // Overlap the start slightly so the closing seam is raked through.
  return Array.from({ length: steps + 4 }, (_, index) => {
    const angle = start + index / steps * Math.PI * 2
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }
  })
}

/**
 * Rake paths for a pattern inside `bounds`, as polylines sampled every few
 * millimetres. `reach` is the rake's half-width, so adjacent passes sit one
 * rake width apart and their grooves tile without gaps or overlap.
 */
export function gardenPaths(pattern: GardenPattern, bounds: Bounds, reach: number, random: () => number = Math.random): Point[][] {
  const pitch = reach * 2.04
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  if (pattern === 'spiral') {
    const outer = Math.min(width, height) / 2 - reach
    const points: Point[] = []
    for (let angle = 0, radius = reach * 0.6; radius <= outer;) {
      points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius })
      const step = pointSpacing / Math.max(radius, pointSpacing)
      angle += step
      radius += pitch * step / (Math.PI * 2)
    }
    return points.length > 1 ? [points] : []
  }
  if (pattern === 'waves') {
    const paths: Point[][] = []
    const amplitude = reach * 0.9
    const wavelength = Math.max(0.12, width / 3)
    let row = 0
    for (let y = bounds.minY + reach + amplitude; y <= bounds.maxY - reach - amplitude; y += pitch, row++) {
      const points: Point[] = []
      for (let x = bounds.minX; x <= bounds.maxX; x += pointSpacing) points.push({ x, y: y + amplitude * Math.sin((x - bounds.minX) / wavelength * Math.PI * 2) })
      paths.push(row % 2 ? points.reverse() : points)
    }
    return paths
  }
  // Karesansui: stones ringed by concentric grooves in a sea of straight lines.
  const stoneRadius = reach * 1.1
  const rings = Math.min(3, Math.floor((Math.min(width, height) / 2 - stoneRadius - reach * 0.2) / pitch))
  const outer = stoneRadius + rings * pitch
  const stones: Point[] = []
  const wanted = rings >= 1 ? 1 + Math.floor(random() * 3) : 0
  for (let attempt = 0; attempt < 60 && stones.length < wanted; attempt++) {
    const candidate = {
      x: bounds.minX + outer + random() * Math.max(0, width - outer * 2),
      y: bounds.minY + outer + random() * Math.max(0, height - outer * 2),
    }
    if (stones.every((stone) => Math.hypot(stone.x - candidate.x, stone.y - candidate.y) > outer * 2.1)) stones.push(candidate)
  }
  const paths: Point[][] = []
  let row = 0
  for (let y = bounds.minY + reach; y <= bounds.maxY - reach; y += pitch, row++) {
    // Free spans of this line outside every ring field.
    let spans: [number, number][] = [[bounds.minX, bounds.maxX]]
    for (const stone of stones) {
      const clearance = outer + reach * 0.15
      const dy = y - stone.y
      if (Math.abs(dy) >= clearance) continue
      const half = Math.sqrt(clearance * clearance - dy * dy)
      spans = spans.flatMap(([start, end]): [number, number][] => [[start, Math.min(end, stone.x - half)], [Math.max(start, stone.x + half), end]]).filter(([start, end]) => end - start > reach)
    }
    const line = spans.map(([start, end]) => polyline([{ x: start, y }, { x: end, y }]))
    if (row % 2) line.reverse().forEach((points) => points.reverse())
    paths.push(...line)
  }
  for (const stone of stones) {
    for (let ring = 0; ring < rings; ring++) paths.push(circle(stone, stoneRadius + reach + ring * pitch, random() * Math.PI * 2))
  }
  return paths
}

/** Drives the stroke queue along generated paths with one tool at a steady pace. */
export class ZenAutopilot {
  private paths: Point[][] = []
  private path = 0
  private point = 0
  private offset = 0
  private carry = 0
  private pen: AutopilotTool = { tool: 'rake', radius: 0, speed: AUTOPILOT_SPEED }
  private last = 0
  private drawing = false
  private readonly strokes: StrokeQueue
  constructor(strokes: StrokeQueue) { this.strokes = strokes }

  get active() { return this.path < this.paths.length }

  /** Draws `paths` with `pen` (its radius is the size-slider radius of that tool). */
  start(paths: Point[][], pen: AutopilotTool, now: number) {
    this.stop()
    this.pen = pen
    this.paths = paths.filter((points) => points.length > 1)
    this.path = 0
    this.point = 0
    this.offset = 0
    this.drawing = false
    this.carry = 0
    this.last = now
  }

  stop() {
    if (this.drawing) this.strokes.cancel(autopilotPointer)
    this.drawing = false
    this.paths = []
    this.path = 0
  }

  /** Advances the virtual rake to `now`. Returns false once the pattern is finished. */
  update(now: number) {
    if (!this.active) return false
    const elapsed = Math.min(0.1, Math.max(0, (now - this.last) / 1000))
    this.last = now
    let budget = this.carry + elapsed * this.pen.speed
    // A blur or reset may cancel the virtual pointer; resume where it stopped.
    if (this.drawing && !this.strokes.holds(autopilotPointer)) this.drawing = false
    while (this.active) {
      const points = this.paths[this.path]
      const current = points[this.point]
      const next = points[this.point + 1]
      const segment = Math.hypot(next.x - current.x, next.y - current.y)
      const along = (fraction: number) => ({ x: current.x + (next.x - current.x) * fraction, y: current.y + (next.y - current.y) * fraction })
      if (!this.drawing) {
        this.strokes.begin(along(segment > 0 ? this.offset / segment : 0), 0.75, now, autopilotPointer, this.pen.tool, this.pen.radius)
        this.drawing = true
      }
      const remaining = segment - this.offset
      if (remaining > budget) {
        this.offset += budget
        budget = 0
        this.strokes.move(along(this.offset / segment), 0.75, now, autopilotPointer)
        break
      }
      budget -= remaining
      this.offset = 0
      this.point++
      this.strokes.move(next, 0.75, now, autopilotPointer)
      if (this.point >= points.length - 1) {
        this.strokes.end(autopilotPointer)
        this.drawing = false
        this.point = 0
        this.path++
      }
    }
    this.carry = budget
    return this.active
  }
}
