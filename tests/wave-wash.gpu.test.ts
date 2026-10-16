import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, type Stroke } from '../src/config'
import { WaveResetEffect, shorelineOffsetAt } from '../src/reset/effect'
import { SandSolver } from '../src/simulation/solver'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('GPU tests require hardware WebGPU access; run outside the filesystem sandbox.')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

async function readState(solver: SandSolver) {
  const staging = device.createBuffer({ size: solver.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.state, 0, staging, 0, solver.byteLength)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}

/** Largest height change from the untouched bed along the groove's row. */
function relief(state: Float32Array, initial: Float32Array) {
  const row = Math.floor(SAND.resolution / 2)
  let largest = 0
  for (let x = 0; x < SAND.resolution; x++) {
    const index = (row * SAND.resolution + x) * 4
    largest = Math.max(largest, Math.abs(state[index] - initial[index]))
  }
  return largest
}

test('the wash softens a groove gradually while covered and leaves the bed clean', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const stroke: Stroke = { from: { x: -0.06, y: 0 }, to: { x: 0.06, y: 0 }, velocity: { x: 0.45, y: 0 }, radius: 0.014, pressure: 0.8, active: true, kind: 0, angle: 0 }
    for (let index = 0; index < 80; index++) {
      const encoder = device.createCommandEncoder()
      solver.encode(encoder, [[stroke]])
      device.queue.submit([encoder.finish()])
    }
    const grooved = relief(await readState(solver), initial)
    expect(grooved).toBeGreaterThan(0.001)

    const wave = new WaveResetEffect()
    const duration = 4.754
    wave.start(0, duration)
    let coveredAt = -1
    const samples: number[] = []
    for (let frame = 0; ; frame++) {
      const now = frame * 1000 / 60
      const state = wave.update(now)
      const encoder = device.createCommandEncoder()
      solver.encodeWaveReset(encoder, state)
      device.queue.submit([encoder.finish()])
      if (state.justFinished) break
      const covered = 0 >= state.currentBaseFront + shorelineOffsetAt(0, state.time)
      if (covered && coveredAt < 0) coveredAt = frame
      // Sample the groove a few frames after the water first reaches it.
      if (coveredAt >= 0 && [2, 10, 30].includes(frame - coveredAt)) samples.push(relief(await readState(solver), initial))
    }

    expect(coveredAt).toBeGreaterThan(0)
    // Not erased on contact: most of the print survives the first frames under water...
    expect(samples[0]).toBeGreaterThan(grooved * 0.6)
    // ...then it keeps fading while the water stays over it.
    expect(samples[1]).toBeLessThan(samples[0])
    expect(samples[2]).toBeLessThan(samples[1] * 0.5)
    // The tray always ends clean.
    expect(relief(await readState(solver), initial)).toBeLessThan(1e-6)
    expect(errors).toEqual([])
  } finally {
    solver.dispose()
  }
})
