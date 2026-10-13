import { SAND, SYMMETRIES, type Point, type Symmetry, type Deposit } from '../config'
import { symmetryImages, transformVector } from './symmetry'

type TimedPoint = Point & { time: number }
type Landing = { deposit: Deposit; time: number; pointerId: number; symmetry: Symmetry; intensity?: number }
type Pour = { last: TimedPoint; travelled: number; samples: TimedPoint[] }
export type Splash = { time: number; intensity: number }

// Release speeds (bed m/s) above which lifting the pointer throws the water.
const throwSpeed = 0.35
const velocityWindowMs = 80
const limit = SAND.extent / 2 - 0.01
const maxPending = 256
const maxSounds = 64
const maxSamples = 64
const maxTricklesPerMove = 64

/**
 * Turns water-tool gestures into drops that land over the next few frames.
 * A tap splashes a cupful, dragging pours a trickle along the path, and a
 * flick throws an elongated splat ahead of the release point. Splash patterns
 * are scaled by the size slider and replicated by the drawing symmetry.
 */
export class WaterThrower {
  size: number = SAND.radius
  symmetry: Symmetry = SYMMETRIES[0]
  private readonly pending: Landing[] = []
  private readonly splashes: Splash[] = []
  private readonly pours = new Map<number, Pour>()
  private readonly random: () => number

  constructor(random: () => number = Math.random) { this.random = random }

  get busy() { return this.pending.length > 0 || this.pours.size > 0 }

  begin(point: Point, time: number, pointerId = 0) {
    const start = { ...this.bound(point), time }
    this.pours.set(pointerId, { last: start, travelled: 0, samples: [start] })
    this.splash(start, time, pointerId)
  }

  move(point: Point, time: number, pointerId = 0) {
    const pour = this.pours.get(pointerId)
    if (!pour) return
    const next = this.bound(point)
    const timestamp = Number.isFinite(time) ? Math.max(pour.last.time, time) : pour.last.time
    const dx = next.x - pour.last.x
    const dy = next.y - pour.last.y
    const distance = Math.hypot(dx, dy)
    const spacing = this.size * 0.9
    if (distance > 0 && Number.isFinite(spacing) && spacing > 0) {
      const travelled = pour.travelled + distance
      const steps = Math.min(maxTricklesPerMove, Math.floor(travelled / spacing))
      pour.travelled = travelled % spacing
      // Retain the newest part of a very long move without walking every
      // skipped sample or carrying its work into subsequent input events.
      for (let index = steps - 1; index >= 0; index--) {
        const back = (pour.travelled + index * spacing) / distance
        this.trickle({ x: next.x - dx * back, y: next.y - dy * back }, timestamp, pointerId)
      }
    }
    pour.last = { ...next, time: timestamp }
    pour.samples.push(pour.last)
    while (pour.samples.length > maxSamples || (pour.samples.length > 2 && pour.samples[0].time < timestamp - velocityWindowMs)) pour.samples.shift()
  }

  end(pointerId = 0) {
    const pour = this.pours.get(pointerId)
    this.pours.delete(pointerId)
    if (!pour || pour.samples.length < 2) return
    const first = pour.samples[0]
    const last = pour.samples[pour.samples.length - 1]
    const seconds = (last.time - first.time) / 1000
    if (seconds <= 0) return
    const velocity = { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds }
    const speed = Math.hypot(velocity.x, velocity.y)
    if (speed > throwSpeed) this.fling(last, { x: velocity.x / speed, y: velocity.y / speed }, speed, last.time, pointerId)
  }

  cancel(pointerId?: number) {
    if (pointerId !== undefined) {
      this.pours.delete(pointerId)
      let kept = 0
      for (const drop of this.pending) if (drop.pointerId !== pointerId) this.pending[kept++] = drop
      this.pending.length = kept
      return
    }
    this.pours.clear()
    this.pending.length = 0
    this.splashes.length = 0
  }

  /** Drops that have landed by `now`, replicated by symmetry, at most `max` in total. */
  takeLanded(now: number, max: number): Deposit[] {
    const budget = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0
    const landed: Deposit[] = []
    let kept = 0
    for (const drop of this.pending) {
      const copies = drop.symmetry.rotations * (drop.symmetry.mirror ? 2 : 1)
      if (drop.time > now || landed.length + copies > budget) { this.pending[kept++] = drop; continue }
      const images = symmetryImages(drop.symmetry)
      for (const image of images) {
        const center = this.bound(transformVector(image, drop.deposit))
        landed.push({ ...drop.deposit, ...center })
      }
      if (drop.intensity !== undefined) {
        if (this.splashes.length === maxSounds) this.splashes.shift()
        this.splashes.push({ time: now, intensity: drop.intensity })
      }
    }
    this.pending.length = kept
    return landed
  }

  takeSplashes(now: number): Splash[] {
    const due = this.splashes.filter((splash) => splash.time <= now)
    if (due.length) this.splashes.splice(0, this.splashes.length, ...this.splashes.filter((splash) => splash.time > now))
    return due
  }

  private get scale() { return this.size / SAND.radius }

  private bound(point: Point): Point {
    return { x: Math.max(-limit, Math.min(limit, point.x)), y: Math.max(-limit, Math.min(limit, point.y)) }
  }

  private land(drop: Omit<Deposit, 'sand'>, time: number, pointerId: number, intensity?: number) {
    const center = this.bound(drop)
    if (this.pending.length === maxPending) this.pending.shift()
    this.pending.push({ deposit: { ...drop, sand: 0, ...center }, time, pointerId, symmetry: this.symmetry, intensity })
  }

  private splash(point: Point, time: number, pointerId: number) {
    const size = this.size
    const landing = time + 40
    this.land({ ...point, radius: size * 2.2, amount: 1.4, pit: 0.0009 * this.scale, pitRadius: size * 1.1 }, landing, pointerId, 0.55)
    for (let index = 0; index < 12; index++) {
      const angle = this.random() * Math.PI * 2
      const distance = size * 2.2 * (0.9 + 1.4 * this.random() ** 1.6)
      const radius = size * (0.22 + 0.3 * this.random())
      this.land({
        x: point.x + Math.cos(angle) * distance, y: point.y + Math.sin(angle) * distance,
        radius, amount: 1, pit: 0.00035 * this.scale, pitRadius: radius * 0.7,
      }, landing + distance * 400, pointerId)
    }
  }

  private trickle(point: Point, time: number, pointerId: number) {
    const size = this.size
    const radius = size * (0.7 + 0.4 * this.random())
    this.land({ ...point, radius, amount: 0.55, pit: 0.00015 * this.scale, pitRadius: radius * 0.6 }, time + 30, pointerId, 0.12)
    if (this.random() < 0.3) {
      const angle = this.random() * Math.PI * 2
      const distance = size * 2 * this.random()
      this.land({
        x: point.x + Math.cos(angle) * distance, y: point.y + Math.sin(angle) * distance,
        radius: size * 0.25, amount: 0.8, pit: 0.0003 * this.scale, pitRadius: size * 0.18,
      }, time + 45, pointerId)
    }
  }

  private fling(release: Point, direction: Point, speed: number, time: number, pointerId: number) {
    const size = this.size
    const side = { x: -direction.y, y: direction.x }
    const reach = Math.max(0.03, Math.min(0.22, speed * 0.16))
    const center = { x: release.x + direction.x * reach, y: release.y + direction.y * reach }
    const flight = time + 120 + reach * 900
    const sheet = size * 1.2 * (1 + Math.min(speed, 2.5))
    const at = (along: number, across: number) => ({
      x: center.x + direction.x * along + side.x * across,
      y: center.y + direction.y * along + side.y * across,
    })
    const arrival = (along: number) => flight + along / speed * 500
    for (let index = 0; index < 5; index++) {
      const along = (index / 4 - 0.5) * sheet
      this.land({ ...at(along, 0), radius: size * 1.5, amount: 1.2, pit: 0.0007 * this.scale, pitRadius: size * 0.9 }, arrival(along), pointerId, index === 2 ? Math.min(1, 0.4 + 0.35 * speed) : undefined)
    }
    const droplets = Math.round(14 + 10 * Math.min(speed, 2))
    for (let index = 0; index < droplets; index++) {
      const along = (this.random() - 0.3) * sheet * 2.5
      const across = (this.random() + this.random() + this.random() - 1.5) * size * 2.2
      const radius = size * (0.18 + 0.3 * this.random())
      this.land({ ...at(along, across), radius, amount: 1, pit: 0.0005 * this.scale, pitRadius: radius * 0.75 }, arrival(along), pointerId)
    }
  }
}
