import { test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { create, globals } from 'webgpu'
import { idleStroke, type Stroke } from '../src/config'
import { letteringPaths } from '../src/input/lettering'
import { WaveResetEffect, idleWaveResetState } from '../src/reset/effect'
import { waveResetViewport } from '../src/reset/viewport'
import { SandRenderer } from '../src/render/renderer'
import { SandSolver } from '../src/simulation/solver'

// The cover: the untouched bed, "TIDEWRIT" written with a fingertip, a beat,
// the Start again wave washing it away, and the clean bed again, so the loop
// starts and ends on the same calm frame. Frames are stepped at exactly 1/30 s.
const WIDTH = 1024
const HEIGHT = 640
const FPS = 30
const OUT = process.env.COVER_OUT ?? 'cover'
const WAVE_SECONDS = 4.754
const SIM_STEPS_PER_FRAME = 4 // SAND.step is 1/120 s
let gpu: GPU

function fingerSegments(text: string) {
  const { paths } = letteringPaths(text, { minX: -0.2, maxX: 0.2, minY: -0.08, maxY: 0.08 })
  const segments: Stroke[] = []
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.003))
    for (let j = 0; j < count; j++) {
      const from = { x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count }
      const to = { x: a.x + (b.x - a.x) * (j + 1) / count, y: a.y + (b.y - a.y) * (j + 1) / count }
      segments.push({ from, to, velocity: { x: (to.x - from.x) * 120, y: (to.y - from.y) * 120 }, radius: 0.006, pressure: 0.8, active: true, kind: 0, angle: 0 })
    }
  }
  return segments
}

test('record the cover loop', async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const device = await (await gpu.requestAdapter())!.requestDevice()
  device.addEventListener('uncapturederror', (event) => { throw new Error(event.error.message) })
  const solver = new SandSolver(device); await solver.initialize()
  const renderer = new SandRenderer(device, solver, 'rgba8unorm'); await renderer.initialize()
  renderer.resize(WIDTH, HEIGHT)
  const target = device.createTexture({ size: [WIDTH, HEIGHT], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const readback = device.createBuffer({ size: WIDTH * HEIGHT * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const frames = join(OUT, 'frames')
  rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true })

  let frame = 0
  const now = () => 1000 + frame * 1000 / FPS
  async function draw(wave = idleWaveResetState()) {
    const encoder = device.createCommandEncoder()
    renderer.encode(encoder, target.createView(), idleStroke(), now(), false, wave)
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: WIDTH * 4 }, [WIDTH, HEIGHT])
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    writeFileSync(join(frames, `${String(frame).padStart(4, '0')}.rgba`), new Uint8Array(readback.getMappedRange()))
    readback.unmap()
    frame++
  }
  function simulate(steps: Stroke[][]) {
    const encoder = device.createCommandEncoder()
    solver.encode(encoder, steps)
    device.queue.submit([encoder.finish()])
  }

  // A calm beat on the untouched bed.
  for (let i = 0; i < 0.8 * FPS; i++) { simulate([[], [], [], []]); await draw() }
  // Write the word over about three seconds.
  const segments = fingerSegments('TIDEWRIT')
  const writeFrames = 3 * FPS
  for (let f = 0; f < writeFrames; f++) {
    const start = Math.floor(f * segments.length / writeFrames)
    const end = Math.floor((f + 1) * segments.length / writeFrames)
    const steps: Stroke[][] = []
    for (let s = 0; s < SIM_STEPS_PER_FRAME; s++) {
      steps.push(segments.slice(start + Math.floor(s * (end - start) / SIM_STEPS_PER_FRAME), start + Math.floor((s + 1) * (end - start) / SIM_STEPS_PER_FRAME)))
    }
    simulate(steps); await draw()
  }
  // Let the kicked-up grains land, then hold on the written word (the poster).
  for (let i = 0; i < 1.1 * FPS; i++) { simulate([[], [], [], []]); await draw() }
  const posterFrame = frame - 1
  // The wash.
  const wave = new WaveResetEffect()
  wave.start(now(), WAVE_SECONDS, waveResetViewport(renderer.camera))
  for (;;) {
    const state = wave.update(now())
    const encoder = device.createCommandEncoder()
    if (state.justStarted) solver.clearTransientState(encoder)
    if (state.active || state.justFinished) solver.encodeWaveReset(encoder, state)
    device.queue.submit([encoder.finish()])
    await draw(state)
    if (state.justFinished) break
  }
  // Back to the calm bed the loop opened on.
  for (let i = 0; i < 0.6 * FPS; i++) await draw()

  const raw = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${WIDTH}x${HEIGHT}`]
  const concat = spawnSync('sh', ['-c', `cat "${frames}"/*.rgba | ffmpeg -y -loglevel error ${raw.join(' ')} -r ${FPS} -i - -an -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -movflags +faststart "${join(OUT, 'cover-loop.mp4')}"`], { stdio: 'inherit' })
  if (concat.status !== 0) throw new Error('ffmpeg failed to encode the loop')
  const poster = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...raw, '-i', join(frames, `${String(posterFrame).padStart(4, '0')}.rgba`), '-q:v', '3', join(OUT, 'cover-poster.jpg')], { stdio: 'inherit' })
  if (poster.status !== 0) throw new Error('ffmpeg failed to write the poster')
  rmSync(frames, { recursive: true, force: true })
  console.log(`cover: ${frame} frames, ${(frame / FPS).toFixed(1)} s, poster frame ${posterFrame}`)
})
