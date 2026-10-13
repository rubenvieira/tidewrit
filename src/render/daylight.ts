export type Vector3 = [number, number, number]

/** One lighting state: where the sun is, what color it and the sky are, and how dark it is. */
export type Daylight = {
  /** Unit direction toward the sun (or moon). */
  direction: Vector3
  /** Direct light color times intensity. */
  sun: Vector3
  /** Tint applied to sky light and reflections. */
  sky: Vector3
  /** 0 by day, 1 at night (bioluminescence shows only in the dark). */
  night: number
  /** Opacity scale of the palm-tree shadow. */
  shadow: number
}

type Preset = { id: string; label: string; azimuth: number; elevation: number; sun: Vector3; sky: Vector3; night: number; shadow: number }

const scale = (color: Vector3, intensity: number): Vector3 => [color[0] * intensity, color[1] * intensity, color[2] * intensity]

// Afternoon is the original light: direction (cos -0.8, 0.65, sin -0.8) and a
// warm 2.55-intensity sun. The others move the sun around the bed; golden hour
// rakes in low and orange, night swaps in a cool dim moon over a dark sky.
export const DAYLIGHTS: readonly Preset[] = [
  { id: 'afternoon', label: 'Afternoon', azimuth: -0.8, elevation: Math.atan2(0.65, 1), sun: scale([1, 0.89, 0.69], 2.55), sky: [1, 1, 1], night: 0, shadow: 1 },
  { id: 'golden', label: 'Golden hour', azimuth: -0.42, elevation: 0.17, sun: scale([1, 0.64, 0.34], 2.7), sky: [0.98, 0.78, 0.7], night: 0, shadow: 1 },
  { id: 'night', label: 'Night', azimuth: 0.95, elevation: 0.8, sun: scale([0.55, 0.66, 0.95], 0.38), sky: [0.12, 0.16, 0.3], night: 1, shadow: 0.45 },
  { id: 'morning', label: 'Morning', azimuth: Math.PI + 0.75, elevation: 0.43, sun: scale([1, 0.94, 0.86], 2.35), sky: [0.94, 1, 1.12], night: 0, shadow: 1 },
]

const transitionSeconds = 2.4

function sunDirection(azimuth: number, elevation: number): Vector3 {
  return [Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)]
}

function shortestTurn(from: number, to: number) {
  const turn = (to - from) % (Math.PI * 2)
  return turn > Math.PI ? turn - Math.PI * 2 : turn < -Math.PI ? turn + Math.PI * 2 : turn
}

/**
 * The current preset and the eased sweep between presets. Interpolating
 * azimuth and elevation (not the direction vector) keeps the sun on a sky arc,
 * so shadows swing round rather than shrinking through the vertical.
 */
export class DaylightCycle {
  private index = 0
  private from: Preset = DAYLIGHTS[0]
  private started = -Infinity

  get preset() { return DAYLIGHTS[this.index] }

  /** Advances to the next preset, starting from wherever the sky is now. */
  next(now: number) {
    this.from = this.snapshot(now)
    this.index = (this.index + 1) % DAYLIGHTS.length
    this.started = now
    return this.preset
  }

  sample(now: number): Daylight {
    const preset = this.snapshot(now)
    return { direction: sunDirection(preset.azimuth, preset.elevation), sun: preset.sun, sky: preset.sky, night: preset.night, shadow: preset.shadow }
  }

  /** Whether the sky is still moving, so lighting must be recomputed. */
  moving(now: number) { return now - this.started < transitionSeconds * 1000 }

  private snapshot(now: number): Preset {
    const target = DAYLIGHTS[this.index]
    const linear = Math.min(1, Math.max(0, (now - this.started) / (transitionSeconds * 1000)))
    if (linear >= 1) return target
    const t = linear * linear * (3 - 2 * linear)
    const mix = (a: number, b: number) => a + (b - a) * t
    const mix3 = (a: Vector3, b: Vector3): Vector3 => [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])]
    return {
      ...target,
      azimuth: this.from.azimuth + shortestTurn(this.from.azimuth, target.azimuth) * t,
      elevation: mix(this.from.elevation, target.elevation),
      sun: mix3(this.from.sun, target.sun), sky: mix3(this.from.sky, target.sky),
      night: mix(this.from.night, target.night), shadow: mix(this.from.shadow, target.shadow),
    }
  }
}
