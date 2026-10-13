import { DIG, MOLD, MOLDS, SAND, SYMMETRIES, type MoldShape, type Point, type Symmetry } from '../config'
import type { DigOp, MoldOp } from '../simulation/earthworks'
import { symmetryImages, transformAngle, transformVector } from './symmetry'
import { HeldPath, type HeldSegment } from './held-path'

type Dig = { path: HeldPath; last: number; heading: Point; scooped: number }
type PendingDig = { pointerId: number; digs: DigOp[]; thud: boolean }
type PendingMold = { point: Point; angle: number; shape: number; radius: number; symmetry: Symmetry }

const limit = SAND.extent / 2 - 0.02
// A still shovel throws its spoil to the right and slightly away from the
// viewer; a moving one throws it to the far side of the trench.
const restingHeading = { x: 0.34 / Math.hypot(0.34, 0.94), y: 0.94 / Math.hypot(0.34, 0.94) }
const scoopSeconds = 0.3
const maxPending = 64

/**
 * Shovel and bucket. A held dig removes a steady volume per second from a
 * bowl under the pointer and throws it onto a heap beside the hole; dragging
 * digs a trench with its spoil along one bank. A tap with the bucket turns out
 * the selected mold. Both are scaled by the size slider and replicated by the
 * drawing symmetry.
 */
export class Earthworks {
  size: number = SAND.radius
  symmetry: Symmetry = SYMMETRIES[0]
  shape: MoldShape = 'tower'
  /** Orientation of the next mold, so the hover preview matches it. */
  nextMoldAngle = 0
  private readonly digs = new Map<number, Dig>()
  private readonly molds: PendingMold[] = []
  private readonly pendingDigs: PendingDig[] = []
  private nextDig = 0
  private readonly thuds: number[] = []
  private readonly random: () => number

  constructor(random: () => number = Math.random) {
    this.random = random
    this.nextMoldAngle = this.rollAngle()
  }

  get digging() { return this.digs.size > 0 }

  selectShape(shape: MoldShape) {
    this.shape = shape
    this.nextMoldAngle = this.rollAngle()
  }

  beginDig(point: Point, time: number, pointerId: number) {
    this.digs.set(pointerId, { path: new HeldPath(this.bound(point), time), last: time, heading: restingHeading, scooped: scoopSeconds })
  }

  moveDig(point: Point, pointerId: number, time?: number) {
    const dig = this.digs.get(pointerId)
    if (!dig) return
    const next = this.bound(point)
    const dx = next.x - dig.path.point.x
    const dy = next.y - dig.path.point.y
    const length = Math.hypot(dx, dy)
    if (length > 1e-8) {
      const blend = 1 - Math.exp(-length / 0.012)
      const blended = { x: dig.heading.x * (1 - blend) + dx / length * blend, y: dig.heading.y * (1 - blend) + dy / length * blend }
      const norm = Math.hypot(blended.x, blended.y)
      if (norm > 1e-6) dig.heading = { x: blended.x / norm, y: blended.y / norm }
    }
    dig.path.move(next, time)
  }

  endDig(pointerId: number, time?: number) {
    const dig = this.digs.get(pointerId)
    if (!dig) return
    this.digs.delete(pointerId)
    this.advance(dig, time ?? dig.last)
    while (dig.path.ready) {
      const segment = dig.path.take()!
      if (this.pendingDigs.length === maxPending) this.pendingDigs.shift()
      this.pendingDigs.push({ pointerId, digs: this.operations(dig, segment), thud: this.scooped(dig, segment.seconds) })
    }
  }

  placeMold(point: Point) {
    const shape = MOLDS.findIndex((mold) => mold.id === this.shape)
    if (this.molds.length === maxPending) this.molds.shift()
    this.molds.push({ point: this.bound(point), angle: this.nextMoldAngle, shape: Math.max(0, shape), radius: this.size * MOLD.radius, symmetry: this.symmetry })
    this.nextMoldAngle = this.rollAngle()
  }

  cancel(pointerId?: number) {
    if (pointerId !== undefined) {
      this.digs.delete(pointerId)
      for (let index = this.pendingDigs.length - 1; index >= 0; index--) {
        if (this.pendingDigs[index].pointerId === pointerId) this.pendingDigs.splice(index, 1)
      }
      return
    }
    this.digs.clear()
    this.pendingDigs.length = 0
    this.molds.length = 0
    this.thuds.length = 0
    this.nextDig = 0
  }

  /** Digs since the last call and pending molds, replicated by symmetry and capped per frame. */
  take(now: number): { digs: DigOp[]; molds: MoldOp[] } {
    const digs: DigOp[] = []
    let kept = 0
    for (const pending of this.pendingDigs) {
      if (digs.length + pending.digs.length > DIG.maxPerFrame) { this.pendingDigs[kept++] = pending; continue }
      digs.push(...pending.digs)
      if (pending.thud) this.thud(0.35)
    }
    this.pendingDigs.length = kept
    const active = Array.from(this.digs.values())
    const start = this.nextDig % Math.max(1, active.length)
    const copies = symmetryImages(this.symmetry).length
    for (let offset = 0; offset < active.length; offset++) {
      const index = (start + offset) % active.length
      const dig = active[index]
      this.advance(dig, now)
      while (dig.path.ready && digs.length + copies <= DIG.maxPerFrame) {
        const segment = dig.path.take()!
        digs.push(...this.operations(dig, segment))
        if (this.scooped(dig, segment.seconds)) this.thud(0.35)
        this.nextDig = index + 1
      }
    }
    const molds: MoldOp[] = []
    kept = 0
    for (const mold of this.molds) {
      const images = symmetryImages(mold.symmetry)
      if (molds.length + images.length > MOLD.maxPerFrame) { this.molds[kept++] = mold; continue }
      for (const image of images) {
        molds.push({ ...this.bound(transformVector(image, mold.point)), radius: mold.radius, angle: transformAngle(image, mold.angle), shape: mold.shape, wetness: MOLD.wetness })
      }
      this.thud(1)
    }
    this.molds.length = kept
    return { digs, molds }
  }

  private advance(dig: Dig, now: number) {
    const time = Number.isFinite(now) ? Math.max(dig.last, now) : dig.last
    dig.path.advance(time)
    dig.last = time
  }

  private operations(dig: Dig, segment: HeldSegment): DigOp[] {
    const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y
    const length = Math.hypot(dx, dy)
    // Each swept scoop throws onto its own far bank, preserving corners even
    // when several coalesced segments are submitted together.
    const heading = length > 1e-8 ? { x: dx / length, y: dy / length } : dig.heading
    const spoil = this.spoilPoint(dig, segment.to, heading)
    const spoilFrom = this.spoilPoint(dig, segment.from, heading)
    const scale = this.size / SAND.radius
    return symmetryImages(this.symmetry).map((image) => ({
      ...this.bound(transformVector(image, segment.to)),
      from: this.bound(transformVector(image, segment.from)),
      radius: this.size * DIG.radius, volume: DIG.rate * scale * scale * segment.seconds,
      spoil: this.bound(transformVector(image, spoil)), spoilRadius: this.size * DIG.spoilRadius, wetness: DIG.spoilWetness,
      spoilFrom: this.bound(transformVector(image, spoilFrom)),
    }))
  }

  private scooped(dig: Dig, seconds: number) {
    dig.scooped += seconds
    if (dig.scooped < scoopSeconds) return false
    dig.scooped %= scoopSeconds
    return true
  }

  private thud(intensity: number) {
    if (this.thuds.length === maxPending) this.thuds.shift()
    this.thuds.push(intensity)
  }

  /** Where spoil is landing, for the falling-grain visual. */
  spoilEmitters(): Point[] {
    const images = symmetryImages(this.symmetry)
    const points: Point[] = []
    for (const dig of this.digs.values()) for (const image of images) points.push(this.bound(transformVector(image, this.spoilPoint(dig))))
    return points
  }

  /** Scoops and mold turn-outs since the last call, as sound intensities. */
  takeThuds() { return this.thuds.splice(0) }

  private spoilPoint(dig: Dig, point = dig.path.point, heading = dig.heading): Point {
    const throwDistance = this.size * DIG.throw
    return this.bound({ x: point.x + heading.y * throwDistance, y: point.y - heading.x * throwDistance })
  }

  private rollAngle() {
    // Towers and castles face the viewer; animals and shells land a little askew.
    const jitter = { tower: 0, castle: 0, starfish: Math.PI * 2, turtle: 0.5, scallop: 0.8 }[this.shape] ?? 0
    return (this.random() - 0.5) * jitter
  }

  private bound(point: Point): Point {
    return { x: Math.max(-limit, Math.min(limit, point.x)), y: Math.max(-limit, Math.min(limit, point.y)) }
  }
}
