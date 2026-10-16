import { test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { create, globals } from 'webgpu'
import { POUR, SAND, SHELL_PRESS_STEPS, SYMMETRIES, idleStroke, type Point } from '../src/config'
import { ZenAutopilot } from '../src/input/autopilot'
import { Earthworks } from '../src/input/earthworks'
import { SandPourer } from '../src/input/pour'
import { StrokeQueue } from '../src/input/strokes'
import { DaylightCycle } from '../src/render/daylight'
import { WaveResetEffect, idleWaveResetState } from '../src/reset/effect'
import { waveResetViewport } from '../src/reset/viewport'
import { SandRenderer } from '../src/render/renderer'
import { SandSolver } from '../src/simulation/solver'

// The cover, at golden hour: the untouched bed; a rake draws an eight-fold mandala; shells
// press a ring between its petals; bucket molds turn out a castle in the middle
// and a starfish, turtle and tower around it while a stream of sand pours into
// a cone; then the Start again wave washes it all away and the loop ends on the
// same calm bed it opened on. Everything is driven through the app's own input
// classes, and frames are stepped at exactly 1/30 s.
const WIDTH = 1024
const HEIGHT = 640
const FPS = 30
const OUT = process.env.COVER_OUT ?? 'cover'
const WAVE_SECONDS = 4.754
const SIM_STEPS_PER_FRAME = 4 // SAND.step is 1/120 s
const RAKE_RADIUS = 0.0045
const RAKE_SPEED = 0.075
let gpu: GPU

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
}
const polar = (radius: number, angle: number): Point => ({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
function curve(count: number, at: (t: number) => Point) {
  return Array.from({ length: count + 1 }, (_, index) => at(index / count))
}

/** One sector of the mandala; ×8 mirror symmetry about the bed centre completes it. */
function mandalaPaths(): Point[][] {
  return [
    curve(80, (t) => polar(0.024 + 0.088 * t, 0.36 * Math.sin(Math.PI * t))),
    curve(40, (t) => polar(0.02 + 0.042 * t, Math.PI / 8 + 0.22 * Math.sin(Math.PI * t))),
    curve(40, (t) => polar(0.124, -0.03 + t * (Math.PI / 8 + 0.06))),
  ]
}

test('record the cover loop', async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const device = await (await gpu.requestAdapter())!.requestDevice()
  device.addEventListener('uncapturederror', (event) => { throw new Error(event.error.message) })
  const solver = new SandSolver(device); await solver.initialize()
  const renderer = new SandRenderer(device, solver, 'rgba8unorm'); await renderer.initialize()
  renderer.resize(WIDTH, HEIGHT)
  // Golden hour: the low sun throws every groove and mold into relief.
  const daylight = new DaylightCycle()
  daylight.next(-1e9)
  renderer.setDaylight(daylight.sample(0))
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

  const strokes = new StrokeQueue()
  const autopilot = new ZenAutopilot(strokes)
  const earthworks = new Earthworks(seeded(7))
  const pourer = new SandPourer(seeded(11))
  pourer.size = 0.02
  function simulate() {
    solver.setPour(pourer.emitters(), pourer.size * POUR.streamRadius)
    const encoder = device.createCommandEncoder()
    const { digs, molds } = earthworks.take(now())
    solver.encodeEarthworks(encoder, digs, molds)
    solver.encodeDeposits(encoder, pourer.take(now(), 48))
    solver.encode(encoder, Array.from({ length: SIM_STEPS_PER_FRAME }, () => strokes.nextBatch()))
    device.queue.submit([encoder.finish()])
  }
  async function hold(seconds: number) {
    for (let i = 0; i < Math.round(seconds * FPS); i++) { simulate(); await draw() }
  }

  // A calm beat on the untouched bed.
  await hold(0.6)
  // The rake draws the mandala.
  strokes.symmetry = SYMMETRIES[4]
  autopilot.start(mandalaPaths(), { tool: 'rake', radius: RAKE_RADIUS, speed: RAKE_SPEED }, now())
  while (autopilot.update(now())) { simulate(); await draw() }
  await hold(0.2)
  // A ring of shell imprints between the petals.
  strokes.radius = 0.0055
  strokes.nextShellAngle = Math.PI / 8 + Math.PI / 2
  strokes.begin(polar(0.088, Math.PI / 8), 0.75, now(), 1, 'shell')
  strokes.end(1)
  await hold(SHELL_PRESS_STEPS / SIM_STEPS_PER_FRAME / FPS + 0.25)
  strokes.symmetry = SYMMETRIES[0]
  // Molds turn out one by one while a stream of sand pours into a cone.
  const place = async (shape: 'castle' | 'starfish' | 'turtle' | 'tower' | 'scallop', at: Point, angle: number, size = SAND.radius) => {
    earthworks.selectShape(shape)
    earthworks.size = size
    earthworks.nextMoldAngle = angle
    earthworks.placeMold(at)
    await hold(0.3)
  }
  await place('castle', { x: 0, y: 0 }, 0, 0.0125)
  pourer.begin({ x: -0.175, y: 0.03 }, now(), 2, 'pour')
  await place('starfish', { x: -0.185, y: -0.095 }, 0.3)
  await place('turtle', { x: 0.185, y: -0.095 }, -0.4)
  await place('tower', { x: 0.168, y: 0.03 }, 0, 0.0105)
  await hold(0.5)
  pourer.end(2, now())
  // Let the falling grains land, then hold on the finished beach (the poster).
  await hold(1.0)
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
  const concat = spawnSync('sh', ['-c', `cat "${frames}"/*.rgba | ffmpeg -y -loglevel error ${raw.join(' ')} -r ${FPS} -i - -an -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart "${join(OUT, 'cover-loop.mp4')}"`], { stdio: 'inherit' })
  if (concat.status !== 0) throw new Error('ffmpeg failed to encode the loop')
  const poster = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...raw, '-i', join(frames, `${String(posterFrame).padStart(4, '0')}.rgba`), '-q:v', '3', join(OUT, 'cover-poster.jpg')], { stdio: 'inherit' })
  if (poster.status !== 0) throw new Error('ffmpeg failed to write the poster')
  rmSync(frames, { recursive: true, force: true })
  console.log(`cover: ${frame} frames, ${(frame / FPS).toFixed(1)} s, poster frame ${posterFrame}`)
})
