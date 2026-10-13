import { KINETIC, POUR, SAND, type Deposit, type Point, type Stroke } from '../config'
import { checkedShader } from '../platform/shader'
import type { WaveResetState } from '../reset/effect'
import { WAVE_RESET } from '../reset/effect'
import { particleShader, simulationShader } from './shaders'
import { waveResetShader } from './wave-reset-shader'
import { SandWater } from './water'
import { SandEarthworks, type DigOp, type MoldOp } from './earthworks'

const paramVectors = 4 + POUR.maxEmitters + SAND.maxContacts * 3
const pourOffset = 16
const contactOffset = (4 + POUR.maxEmitters) * 4
const paramBytes = paramVectors * 16

export class SandSolver {
  readonly buffers: GPUBuffer[]
  readonly flux: GPUBuffer
  readonly particles: GPUBuffer
  readonly particleCount: number
  readonly water: SandWater
  private readonly earthworks: SandEarthworks
  /** Fixed-point grain exchange, then the frontier impact budget (two grid-sized halves). */
  private readonly ledger: GPUBuffer
  private readonly contact: GPUBuffer
  private readonly contactPressure: GPUBuffer
  private particlePipeline!: GPUComputePipeline
  private particleGroups: GPUBindGroup[][] = []
  private readonly uniforms: GPUBuffer[]
  private readonly waveResetUniform: GPUBuffer
  private waveResetPipeline!: GPUComputePipeline
  private waveResetGroups: GPUBindGroup[] = []
  private pipelines!: Record<'initialize' | 'contact' | 'transport' | 'integrate', GPUComputePipeline>
  private groups: GPUBindGroup[][] = []
  private current = 0
  private generation = 0
  private readonly data = new Float32Array(paramVectors * 4)
  private pour: readonly Point[] = []
  private pourRadius = 0
  private kinetic = false
  readonly byteLength: number

  readonly device: GPUDevice
  readonly resolution: number
  constructor(device: GPUDevice, resolution: number = SAND.resolution) {
    this.device = device
    this.resolution = resolution
    this.byteLength = resolution * resolution * 16
    this.buffers = [0, 1].map((index) => device.createBuffer({ label: `Sand state ${index}`, size: this.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }))
    this.flux = device.createBuffer({ label: 'Eight-neighbor conservative flux', size: this.byteLength * 2, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.contact = device.createBuffer({ label: 'Pointer contact field', size: this.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.contactPressure = device.createBuffer({ label: 'Pointer contact pressure', size: resolution * resolution * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.particleCount = Math.min(SAND.particles, resolution * resolution)
    this.particles = device.createBuffer({ label: 'Mass carrying grains', size: this.particleCount * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
    this.ledger = device.createBuffer({ label: 'Fixed-point grain exchange and impact budget', size: resolution * resolution * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.uniforms = Array.from({ length: SAND.maxSteps }, () => device.createBuffer({ size: paramBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }))
    this.water = new SandWater(device, resolution)
    this.earthworks = new SandEarthworks(device, resolution, this.water.moisture, this.water.packing)
    this.waveResetUniform = device.createBuffer({ label: 'Wave reset parameters', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }
  get state() { return this.buffers[this.current] }
  get stateIndex() { return this.current }
  get revision() { return this.generation }

  async initialize() {
    const module = await checkedShader(this.device, 'Sand transport WGSL', simulationShader)
    const layout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ] })
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] })
    const make = (entryPoint: string) => this.device.createComputePipelineAsync({ label: entryPoint, layout: pipelineLayout, compute: { module, entryPoint } })
    const [initialize, contact, transport, integrate] = await Promise.all([make('initialize'), make('contact'), make('transport'), make('integrate')])
    this.pipelines = { initialize, contact, transport, integrate }
    this.groups = this.uniforms.map((uniform) => [0, 1].map((index) => this.device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: this.buffers[index] } },
      { binding: 2, resource: { buffer: this.buffers[1 - index] } }, { binding: 3, resource: { buffer: this.flux } },
      { binding: 4, resource: { buffer: this.ledger } }, { binding: 5, resource: { buffer: this.contact } },
      { binding: 6, resource: { buffer: this.contactPressure } },
      { binding: 7, resource: { buffer: this.water.packing[index] } },
      { binding: 8, resource: { buffer: this.water.moisture[index] } },
    ] })))
    const particles = await checkedShader(this.device, 'Mass carrying grains WGSL', particleShader)
    this.particlePipeline = await this.device.createComputePipelineAsync({ layout: 'auto', compute: { module: particles, entryPoint: 'animate' } })
    this.particleGroups = this.uniforms.map((uniform) => this.buffers.map((buffer, index) => this.device.createBindGroup({ layout: this.particlePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer } },
      { binding: 2, resource: { buffer: this.flux } }, { binding: 3, resource: { buffer: this.particles } },
      { binding: 4, resource: { buffer: this.ledger } }, { binding: 5, resource: { buffer: this.contact } },
      { binding: 6, resource: { buffer: this.contactPressure } },
      { binding: 8, resource: { buffer: this.water.moisture[index] } },
    ] })))
    await this.water.initialize(this.buffers, this.flux, this.uniforms, this.contact)
    await this.earthworks.initialize(this.buffers)

    const resetModule = await checkedShader(this.device, 'Wave reset WGSL', waveResetShader)
    this.waveResetPipeline = await this.device.createComputePipelineAsync({ layout: 'auto', compute: { module: resetModule, entryPoint: 'main' } })
    this.waveResetGroups = this.buffers.map((buffer, index) => this.device.createBindGroup({
      layout: this.waveResetPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.waveResetUniform } },
        { binding: 1, resource: { buffer } },
        { binding: 2, resource: { buffer: this.water.moisture[index] } },
        { binding: 3, resource: { buffer: this.water.packing[index] } },
      ],
    }))
    this.reset()
  }

  private writeParams(slot: number, strokes: readonly Stroke[]) {
    const active = strokes.filter((stroke) => stroke.active && stroke.pressure > 0).slice(0, SAND.maxContacts)
    this.data.fill(0)
    this.data.set([
      this.resolution, SAND.extent / this.resolution, SAND.extent, SAND.step,
      SAND.depth, SAND.floor, SAND.repose, SAND.dynamicRepose,
      active.length, SAND.indentation, SAND.rate, this.pour.length,
      this.kinetic ? 1 : 0, KINETIC.creep, 0, 0,
    ])
    const spawnChance = Math.min(1, POUR.streamGrains * this.pour.length / this.particleCount)
    this.pour.forEach((point, index) => this.data.set([point.x, point.y, this.pourRadius, spawnChance], pourOffset + index * 4))
    active.forEach((stroke, index) => {
      const offset = contactOffset + index * 12
      this.data.set([stroke.from.x, stroke.from.y, stroke.radius, stroke.pressure], offset)
      this.data.set([stroke.to.x, stroke.to.y, stroke.kind, stroke.angle], offset + 4)
      this.data.set([stroke.velocity.x, stroke.velocity.y, Math.hypot(stroke.velocity.x, stroke.velocity.y), stroke.variant], offset + 8)
    })
    this.device.queue.writeBuffer(this.uniforms[slot], 0, this.data)
    return active.length
  }

  reset() {
    this.writeParams(0, [])
    const encoder = this.device.createCommandEncoder()
    this.encodeFullReset(encoder)
    this.device.queue.submit([encoder.finish()])
  }

  encodeFullReset(encoder: GPUCommandEncoder) {
    this.generation++
    encoder.clearBuffer(this.particles)
    encoder.clearBuffer(this.ledger)
    this.water.clear(encoder)
    const pass = encoder.beginComputePass({ label: 'Full sand reset' })
    pass.setPipeline(this.pipelines.initialize)
    for (const group of [this.groups[0][0], this.groups[0][1]]) {
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(this.resolution / 8))
    }
    pass.end()
  }

  encodeWaveReset(encoder: GPUCommandEncoder, state: WaveResetState) {
    const spacing = SAND.extent / this.resolution
    const halfExtent = SAND.extent * 0.5
    const shorelineOffsetBound = halfExtent * Math.abs(WAVE_RESET.shorelineTilt)
      + WAVE_RESET.shorelineAmplitude * (1 + Math.abs(WAVE_RESET.shorelineBlend) + 0.55)
    const lowerFront = Math.min(state.erasePreviousBaseFront, state.eraseCurrentBaseFront) - shorelineOffsetBound
    const upperFront = Math.max(state.erasePreviousBaseFront, state.eraseCurrentBaseFront) + shorelineOffsetBound
    const rowStart = Math.max(0, Math.min(this.resolution, Math.floor((lowerFront + halfExtent) / spacing) - 1))
    const rowEnd = Math.max(rowStart, Math.min(this.resolution, Math.ceil((upperFront + halfExtent) / spacing) + 1))
    const rowCount = rowEnd - rowStart
    if (rowCount <= 0) return

    const data = new Float32Array([
      this.resolution, spacing, SAND.extent, SAND.depth,
      state.erasePreviousBaseFront, state.eraseCurrentBaseFront, state.erasePreviousTime, state.eraseCurrentTime,
      rowStart, rowCount, 0, 0,
    ])
    this.device.queue.writeBuffer(this.waveResetUniform, 0, data)
    const pass = encoder.beginComputePass({ label: 'Wave reset' })
    pass.setPipeline(this.waveResetPipeline)
    for (const group of this.waveResetGroups) {
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(rowCount / 8))
    }
    pass.end()
    this.generation++
  }

  clearTransientState(encoder: GPUCommandEncoder) {
    // Reset every non-height field once at wash start. The wave still owns the
    // visible progressive height reset, but no old contact/flux/particle state
    // is allowed to survive into the next interaction.
    encoder.clearBuffer(this.flux)
    encoder.clearBuffer(this.particles)
    encoder.clearBuffer(this.ledger)
    encoder.clearBuffer(this.contact)
    encoder.clearBuffer(this.contactPressure)
  }

  encode(encoder: GPUCommandEncoder, steps: readonly (readonly Stroke[])[]) {
    if (steps.length > SAND.maxSteps) throw new Error('Simulation substep budget exceeded')
    steps.forEach((strokes, slot) => {
      const contactCount = this.writeParams(slot, strokes)
      const pass = encoder.beginComputePass({ label: 'Sand conservative transport' })
      pass.setBindGroup(0, this.groups[slot][this.current])
      if (contactCount > 0) {
        pass.setPipeline(this.pipelines.contact)
        pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(this.resolution / 8))
      }
      pass.setPipeline(this.pipelines.transport)
      pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(this.resolution / 8))
      pass.setPipeline(this.particlePipeline)
      pass.setBindGroup(0, this.particleGroups[slot][this.current])
      pass.dispatchWorkgroups(Math.ceil(this.particleCount / 64))
      pass.setPipeline(this.pipelines.integrate)
      pass.setBindGroup(0, this.groups[slot][this.current])
      pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(this.resolution / 8))
      this.water.encodeHydrate(pass, slot, this.current)
      pass.end()
      this.current = 1 - this.current
      this.generation++
    })
  }

  /** Digging and bucket molds against the current bed before this frame's substeps. */
  encodeEarthworks(encoder: GPUCommandEncoder, digs: readonly DigOp[], molds: readonly MoldOp[]) {
    if (this.earthworks.encode(encoder, digs, molds, this.current)) this.generation++
  }

  /** Switches between beach sand (held by water) and kinetic sand (held by packing). */
  setKinetic(kinetic: boolean) { this.kinetic = kinetic }

  /** Pour stream emitters for the coming substeps (empty when nothing is pouring). */
  setPour(emitters: readonly Point[], radius: number) {
    this.pour = emitters.slice(0, POUR.maxEmitters)
    this.pourRadius = radius
  }

  /** Records an out-of-band edit of the bed so lighting and readers refresh. */
  markChanged() { this.generation++ }

  /** Lands water and new sand on the current bed before this frame's substeps. */
  encodeDeposits(encoder: GPUCommandEncoder, deposits: readonly Deposit[]) {
    if (this.water.encodeDeposits(encoder, deposits, this.current)) this.generation++
  }

  dispose() {
    this.water.dispose()
    this.earthworks.dispose()
    ;[...this.buffers, this.flux, this.particles, this.ledger, this.contact, this.contactPressure, ...this.uniforms, this.waveResetUniform].forEach((buffer) => buffer.destroy()) }
}
