import { DIG, MOLD, MOLDS, SAND, SYMMETRIES, type MoldShape, type Point, type Symmetry } from '../config'
import type { DigOp, MoldOp } from '../simulation/earthworks'
import { symmetryImages, transformAngle, transformVector } from './symmetry'

type Dig = { point: Point; last: number; heading: Point; scooped: number }
type PendingMold = { point: Point; angle: number; shape: number; radius: number }

const limit = SAND.extent / 2 - 0.02
// A still shovel throws its spoil to the right and slightly away from the
// viewer; a moving one throws it to the far side of the trench.
const restingHeading = { x: 0.34 / Math.hypot(0.34, 0.94), y: 0.94 / Math.hypot(0.34, 0.94) }
const scoopSeconds = 0.3

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
    this.digs.set(pointerId, { point: this.bound(point), last: time, heading: restingHeading, scooped: scoopSeconds })
  }

  moveDig(point: Point, pointerId: number) {
    const dig = this.digs.get(pointerId)
    if (!dig) return
    const next = this.bound(point)
    const dx = next.x - dig.point.x
    const dy = next.y - dig.point.y
    const length = Math.hypot(dx, dy)
    if (length > 0.001) {
      const blended = { x: dig.heading.x * 0.7 + dx / length * 0.3, y: dig.heading.y * 0.7 + dy / length * 0.3 }
      const norm = Math.hypot(blended.x, blended.y)
      if (norm > 1e-6) dig.heading = { x: blended.x / norm, y: blended.y / norm }
    }
    dig.point = next
  }

  endDig(pointerId: number) { this.digs.delete(pointerId) }

  placeMold(point: Point) {
    const shape = MOLDS.findIndex((mold) => mold.id === this.shape)
    this.molds.push({ point: this.bound(point), angle: this.nextMoldAngle, shape: Math.max(0, shape), radius: this.size * MOLD.radius })
    this.nextMoldAngle = this.rollAngle()
    this.thuds.push(1)
  }

  cancel(pointerId?: number) {
    if (pointerId !== undefined) { this.digs.delete(pointerId); return }
    this.digs.clear()
    this.molds.length = 0
  }

  /** Digs since the last call and pending molds, replicated by symmetry and capped per frame. */
  take(now: number): { digs: DigOp[]; molds: MoldOp[] } {
    const images = symmetryImages(this.symmetry)
    const scale = this.size / SAND.radius
    const digs: DigOp[] = []
    for (const dig of this.digs.values()) {
      const seconds = Math.max(0, Math.min(0.1, (now - dig.last) / 1000))
      dig.last = now
      dig.scooped += seconds
      if (dig.scooped >= scoopSeconds) { dig.scooped = 0; this.thuds.push(0.35) }
      if (seconds <= 0 || digs.length + images.length > DIG.maxPerFrame) continue
      const spoil = this.spoilPoint(dig)
      for (const image of images) {
        digs.push({
          ...this.bound(transformVector(image, dig.point)),
          radius: this.size * DIG.radius, volume: DIG.rate * scale * scale * seconds,
          spoil: this.bound(transformVector(image, spoil)), spoilRadius: this.size * DIG.spoilRadius, wetness: DIG.spoilWetness,
        })
      }
    }
    const molds: MoldOp[] = []
    while (this.molds.length && molds.length + images.length <= MOLD.maxPerFrame) {
      const mold = this.molds.shift()!
      for (const image of images) {
        molds.push({ ...this.bound(transformVector(image, mold.point)), radius: mold.radius, angle: transformAngle(image, mold.angle), shape: mold.shape, wetness: MOLD.wetness })
      }
    }
    return { digs, molds }
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

  private spoilPoint(dig: Dig): Point {
    const throwDistance = this.size * DIG.throw
    return this.bound({ x: dig.point.x + dig.heading.y * throwDistance, y: dig.point.y - dig.heading.x * throwDistance })
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
