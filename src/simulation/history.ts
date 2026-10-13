import { checkedShader } from '../platform/shader'
import type { SandSolver } from './solver'

// Undo and redo together keep at most this many 12-byte-per-cell snapshots
// (3 MiB each at 512²), so history memory stays bounded at 48 MiB.
export const HISTORY_LEVELS = 16

// Snapshots hold only the conserved bed (height), its moisture and packing. Activity,
// velocity, flux, contact and airborne state are transient and are cleared on
// restore, so a restored bed starts at rest exactly as it was captured.
const historyShader = `
@group(0) @binding(0) var<uniform> grid: vec4f;
@group(0) @binding(1) var<storage, read_write> state: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> moisture: array<f32>;
struct Saved { height: f32, moisture: f32, packing: f32 }
@group(0) @binding(3) var<storage, read_write> snapshot: array<Saved>;
@group(0) @binding(4) var<storage, read_write> packing: array<f32>;
fn cellIndex(invocation: vec3u) -> i32 {
  let resolution = u32(grid.x);
  if (any(invocation.xy >= vec2u(resolution))) { return -1; }
  return i32(invocation.y * resolution + invocation.x);
}
@compute @workgroup_size(8, 8)
fn capture(@builtin(global_invocation_id) invocation: vec3u) {
  let index = cellIndex(invocation);
  if (index < 0) { return; }
  snapshot[index] = Saved(state[index].x, moisture[index], packing[index]);
}
@compute @workgroup_size(8, 8)
fn restore(@builtin(global_invocation_id) invocation: vec3u) {
  let index = cellIndex(invocation);
  if (index < 0) { return; }
  let saved = snapshot[index];
  state[index] = vec4f(saved.height, 0.0, 0.0, 0.0);
  moisture[index] = saved.moisture;
  packing[index] = saved.packing;
}
`

export class SandHistory {
  private readonly undoStack: GPUBuffer[] = []
  private readonly redoStack: GPUBuffer[] = []
  private readonly spare: GPUBuffer[] = []
  private readonly groups = new Map<GPUBuffer, GPUBindGroup[]>()
  private readonly uniform: GPUBuffer
  private layout!: GPUBindGroupLayout
  private capturePipeline!: GPUComputePipeline
  private restorePipeline!: GPUComputePipeline

  private readonly device: GPUDevice
  private readonly solver: SandSolver
  constructor(device: GPUDevice, solver: SandSolver) {
    this.device = device
    this.solver = solver
    this.uniform = device.createBuffer({ label: 'History grid', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(this.uniform, 0, new Float32Array([solver.resolution, 0, 0, 0]))
  }

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  async initialize() {
    const module = await checkedShader(this.device, 'Sand history WGSL', historyShader)
    this.layout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
    ] })
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    ;[this.capturePipeline, this.restorePipeline] = await Promise.all(['capture', 'restore'].map((entryPoint) =>
      this.device.createComputePipelineAsync({ label: `History ${entryPoint}`, layout, compute: { module, entryPoint } })))
  }

  /** Records the bed as it is before the next change; clears redo. */
  capture(encoder: GPUCommandEncoder) {
    this.release(this.redoStack.splice(0))
    if (this.undoStack.length >= HISTORY_LEVELS) this.release(this.undoStack.splice(0, 1))
    this.undoStack.push(this.snapshot(encoder))
  }

  undo(encoder: GPUCommandEncoder) { return this.step(encoder, this.undoStack, this.redoStack) }
  redo(encoder: GPUCommandEncoder) { return this.step(encoder, this.redoStack, this.undoStack) }

  /** Forgets all history, e.g. after the bed is rebuilt from scratch. */
  clear() { this.release([...this.undoStack.splice(0), ...this.redoStack.splice(0)]) }

  private step(encoder: GPUCommandEncoder, from: GPUBuffer[], to: GPUBuffer[]) {
    const target = from.pop()
    if (!target) return false
    // Popping first keeps the combined stacks within HISTORY_LEVELS.
    to.push(this.snapshot(encoder))
    this.solver.clearTransientState(encoder)
    this.dispatch(encoder, this.restorePipeline, target)
    this.solver.markChanged()
    this.release([target])
    return true
  }

  private snapshot(encoder: GPUCommandEncoder) {
    const buffer = this.spare.pop() ?? this.device.createBuffer({ label: 'Bed snapshot', size: this.solver.resolution ** 2 * 12, usage: GPUBufferUsage.STORAGE })
    this.dispatch(encoder, this.capturePipeline, buffer)
    return buffer
  }

  private dispatch(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, snapshot: GPUBuffer) {
    let groups = this.groups.get(snapshot)
    if (!groups) {
      groups = this.solver.buffers.map((state, index) => this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: state } },
        { binding: 2, resource: { buffer: this.solver.water.moisture[index] } },
        { binding: 3, resource: { buffer: snapshot } },
        { binding: 4, resource: { buffer: this.solver.water.packing[index] } },
      ] }))
      this.groups.set(snapshot, groups)
    }
    const pass = encoder.beginComputePass({ label: 'Sand history' })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, groups[this.solver.stateIndex])
    pass.dispatchWorkgroups(Math.ceil(this.solver.resolution / 8), Math.ceil(this.solver.resolution / 8))
    pass.end()
  }

  private release(buffers: GPUBuffer[]) { this.spare.push(...buffers) }

  dispose() {
    for (const buffer of [...this.undoStack, ...this.redoStack, ...this.spare]) buffer.destroy()
    this.uniform.destroy()
  }
}
