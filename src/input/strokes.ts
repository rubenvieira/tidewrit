import { FOOT_PRESS_STEPS, GAIT, SAND, SHELL_PRESS_STEPS, SYMMETRIES, TOOL_KIND, TOOL_SHAPE, idleStroke, type ContactTool, type Point, type Stroke, type Symmetry } from '../config'
import { symmetryImages, transformAngle, transformVector, type SymmetryImage } from './symmetry'

type TimedPoint = Point & { time: number }
type Track = {
  tool: ContactTool
  radius: number
  held: boolean
  pressure: number
  start: TimedPoint
  latest: TimedPoint
  latestTime: number | undefined
  segments: Stroke[]
  /** Wind heading latched from the gesture's first segment. */
  windAngle?: number
  /** Walking: centerline point of the last footprint and the next foot. */
  stepFrom?: Point
  footsteps: number
}

const minimumSampleSeconds = 0.0001
const nonAdvancingSampleSeconds = SAND.step * 0.5
const minimumMovement = 1e-7
// Keep enough queued geometry for a legitimate fast stroke while still bounding
// pathological replay after a GPU stall. The solver can consume maxContacts per
// substep and maxSteps per rendered frame, so this caps a pointer at four
// rendered frames of pending contact work rather than a single frame.
export const maxQueuedSegmentsPerPointer = SAND.maxContacts * SAND.maxSteps * 4
// Shell and foot imprints are stationary contacts held for several substeps; at
// most this many may be pressing at once so ordinary strokes always keep slots.
const maxConcurrentPresses = SAND.maxContacts / 2
type Press = { stroke: Stroke; remaining: number }

export class StrokeQueue {
  private readonly tracks = new Map<number, Track>()
  private readonly presses: Press[] = []
  private roundRobin = 0
  private currentPressure = 0.7
  position: Point = { x: 0, y: 0 }
  radius: number = SAND.radius
  tool: ContactTool = 'finger'
  symmetry: Symmetry = SYMMETRIES[0]
  /** Orientation of the next shell press, so the hover preview matches it. */
  nextShellAngle = this.randomAngle()
  /** Which foot steps next: +1 left, -1 right. */
  nextFoot = 1

  begin(point: Point, pressure: number, time?: number, pointerId = 0, tool: ContactTool = this.tool, radius = this.radius) {
    const bounded = this.bound(point)
    const existing = this.tracks.get(pointerId)
    const timestamp = this.timestamp(existing, time)
    const start = { ...bounded, time: timestamp }
    this.position = bounded
    this.currentPressure = this.clampPressure(pressure)
    if (tool === 'shell') this.press(bounded)
    this.tracks.set(pointerId, {
      tool,
      radius,
      held: true,
      pressure: this.currentPressure,
      start,
      latest: start,
      latestTime: timestamp,
      segments: existing?.segments ?? [],
      stepFrom: tool === 'feet' ? bounded : undefined,
      footsteps: 0,
    })
  }

  move(point: Point, pressure: number, time?: number, pointerId = 0) {
    const bounded = this.bound(point)
    this.position = bounded
    this.currentPressure = this.clampPressure(pressure)
    const track = this.tracks.get(pointerId)
    if (!track || !track.held) return
    const timestamp = this.timestamp(track, time)
    track.pressure = this.currentPressure
    track.latestTime = timestamp
    track.latest = { ...bounded, time: timestamp }
    if (track.tool === 'feet') this.walk(track)
    else if (track.tool !== 'shell') this.subdivide(track)
  }

  end(pointerId = 0) {
    const track = this.tracks.get(pointerId)
    if (!track) return
    track.held = false
    // A tap with the feet leaves a single footprint facing up the screen.
    if (track.tool === 'feet' && !track.footsteps) this.step(track, track.start, Math.PI)
    this.flush(track)
    this.prune(pointerId, track)
  }

  cancel(pointerId?: number) {
    if (pointerId === undefined) {
      this.tracks.clear()
      this.presses.length = 0
      this.roundRobin = 0
      return
    }
    this.tracks.delete(pointerId)
    if (this.roundRobin >= this.tracks.size) this.roundRobin = 0
  }

  private clampPressure(pressure: number) { return Math.max(0.1, Math.min(1, pressure)) }

  private bound(point: Point) {
    const limit = SAND.extent / 2 - 0.03
    return { x: Math.max(-limit, Math.min(limit, point.x)), y: Math.max(-limit, Math.min(limit, point.y)) }
  }

  private timestamp(track: Track | undefined, time?: number) {
    const previous = track?.latestTime
    const fallback = (previous ?? -SAND.step * 1000) + SAND.step * 1000
    const candidate = time !== undefined && Number.isFinite(time) ? time : fallback
    return previous === undefined ? candidate : Math.max(previous, candidate)
  }

  private spacing(track: Track) { return Math.max(SAND.extent / SAND.resolution * 1.5, track.radius * TOOL_SHAPE[track.tool].feature * 0.5) }

  private randomAngle() { return (Math.random() - 0.5) * Math.PI * 2 }

  private image(stroke: Stroke, image: SymmetryImage): Stroke {
    return {
      ...stroke,
      from: this.bound(transformVector(image, stroke.from)), to: this.bound(transformVector(image, stroke.to)),
      velocity: transformVector(image, stroke.velocity), angle: transformAngle(image, stroke.angle),
      // A mirrored left foot is a right foot.
      variant: image.flip ? -stroke.variant : stroke.variant,
    }
  }

  /** Wind blows one way per gesture: the heading of its first segment. */
  private windAngle(track: Track, from: Point, to: Point) {
    track.windAngle ??= Math.atan2(-(to.x - from.x), to.y - from.y)
    return track.windAngle
  }

  private toolPressure(tool: ContactTool, pressure: number) {
    const shape = TOOL_SHAPE[tool]
    return shape.pressure ?? pressure * (shape.pressureScale ?? 1)
  }

  private press(point: Point, tool: 'shell' | 'feet' = 'shell', angle = this.nextShellAngle, variant = 0, radius = this.radius) {
    if (this.presses.length >= maxConcurrentPresses) this.presses.shift()
    this.presses.push({ remaining: tool === 'feet' ? FOOT_PRESS_STEPS : SHELL_PRESS_STEPS, stroke: {
      from: { ...point }, to: { ...point }, velocity: { x: 0, y: 0 },
      radius: radius * TOOL_SHAPE[tool].reach, pressure: this.toolPressure(tool, 1),
      active: true, kind: TOOL_KIND[tool], angle, variant,
    } })
    if (tool === 'shell') this.nextShellAngle = this.randomAngle()
  }

  /** Places a footprint beside the walking centerline at `center`, toes along `angle`. */
  private step(track: Track, center: Point, angle: number) {
    const foot = this.nextFoot
    const side = { x: Math.cos(angle), y: Math.sin(angle) }
    const offset = GAIT.offset * track.radius * -foot
    this.press(this.bound({ x: center.x + side.x * offset, y: center.y + side.y * offset }), 'feet', angle, foot, track.radius)
    this.nextFoot = -foot
    track.footsteps++
  }

  /** Walking: a footprint every stride along the path, alternating feet. */
  private walk(track: Track) {
    const from = track.stepFrom ?? track.start
    const dx = track.latest.x - from.x
    const dy = track.latest.y - from.y
    const travelled = Math.hypot(dx, dy)
    const stride = GAIT.stride * track.radius
    // The first step lands as soon as the heading is known.
    if (travelled < (track.footsteps ? stride : stride * 0.25)) return
    const angle = Math.atan2(-dx, dy)
    this.step(track, track.latest, angle)
    track.stepFrom = { x: track.latest.x, y: track.latest.y }
  }

  private makeStroke(track: Track, from: TimedPoint, to: TimedPoint, pressure: number): Stroke {
    const tool = track.tool
    const rawDuration = (to.time - from.time) / 1000
    // WebKit can deliver coalesced samples with the same timestamp after a
    // scheduling hitch. Treat that as missing timing data rather than a
    // near-zero-duration impact, which would inject an enormous fake speed.
    const duration = rawDuration > 0 ? Math.max(minimumSampleSeconds, rawDuration) : nonAdvancingSampleSeconds
    return {
      from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
      velocity: { x: (to.x - from.x) / duration, y: (to.y - from.y) / duration },
      radius: track.radius * TOOL_SHAPE[tool].reach, pressure: this.toolPressure(tool, pressure),
      active: true, kind: TOOL_KIND[tool], angle: tool === 'wind' ? this.windAngle(track, from, to) : 0, variant: 0,
    }
  }

  private subdivide(track: Track) {
    const spacing = this.spacing(track)
    let distance = Math.hypot(track.latest.x - track.start.x, track.latest.y - track.start.y)
    while (distance >= spacing) {
      const fraction = spacing / distance
      const to: TimedPoint = {
        x: track.start.x + (track.latest.x - track.start.x) * fraction,
        y: track.start.y + (track.latest.y - track.start.y) * fraction,
        time: track.start.time + (track.latest.time - track.start.time) * fraction,
      }
      track.segments.push(this.makeStroke(track, track.start, to, track.pressure))
      this.trimBacklog(track)
      track.start = to
      distance = Math.hypot(track.latest.x - track.start.x, track.latest.y - track.start.y)
    }
  }

  private flush(track: Track) {
    const distance = Math.hypot(track.latest.x - track.start.x, track.latest.y - track.start.y)
    if (track.tool !== 'shell' && track.tool !== 'feet' && distance > minimumMovement) {
      track.segments.push(this.makeStroke(track, track.start, track.latest, track.pressure))
      this.trimBacklog(track)
    }
    track.start = track.latest
  }

  private trimBacklog(track: Track) {
    const overflow = track.segments.length - maxQueuedSegmentsPerPointer
    if (overflow > 0) track.segments.splice(0, overflow)
  }

  private prune(pointerId: number, track: Track) {
    if (!track.held && track.segments.length === 0) this.tracks.delete(pointerId)
  }

  private drain(limit: number): Stroke[] {
    for (const track of this.tracks.values()) if (track.held) this.flush(track)
    // Presses are stationary contacts that hold their shape across substeps,
    // so each contributes one contact per batch until its hold expires.
    // Each queued contact is replicated once per symmetry image; a contact is
    // only taken when all of its images fit in this batch.
    const images = symmetryImages(this.symmetry)
    const result: Stroke[] = []
    const take = (stroke: Stroke) => { for (const image of images) result.push(images.length > 1 ? this.image(stroke, image) : stroke) }
    for (const press of this.presses) {
      if (result.length + images.length > limit) break
      take(press.stroke)
      press.remaining--
    }
    for (let index = this.presses.length - 1; index >= 0; index--) if (this.presses[index].remaining <= 0) this.presses.splice(index, 1)
    const entries = [...this.tracks.entries()]
    if (!entries.length) return result
    let emptyPasses = 0
    let cursor = this.roundRobin % entries.length
    while (result.length + images.length <= limit && emptyPasses < entries.length) {
      const [pointerId, track] = entries[cursor]
      const stroke = track.segments.shift()
      if (stroke) {
        take(stroke)
        emptyPasses = 0
        this.prune(pointerId, track)
      } else {
        emptyPasses++
      }
      cursor = (cursor + 1) % entries.length
    }
    this.roundRobin = cursor
    return result
  }

  /** Whether a pointer is currently held down in the queue. */
  holds(pointerId: number) { return this.tracks.get(pointerId)?.held === true }

  nextBatch(): Stroke[] { return this.drain(SAND.maxContacts) }

  next(): Stroke { return this.drain(1)[0] ?? { ...idleStroke(), from: this.position, to: this.position, radius: this.radius, pressure: this.currentPressure } }

  get cursor(): Stroke { return { ...idleStroke(), from: this.position, to: this.position, radius: this.radius * TOOL_SHAPE[this.tool].reach } }
}
