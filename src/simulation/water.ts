import { KINETIC, SAND, WATER, type Deposit } from '../config'
import { checkedShader } from '../platform/shader'
import { fluxLayout } from './flux'

const dropParamVectors = 3 + WATER.maxDropsPerFrame * 2
const dropParamBytes = dropParamVectors * 16

// Lands deposits: soft moisture disks, a zero-mean impact profile
// -(1 - r²)·exp(-r²) whose depression and rim integrate to zero (so pits move
// sand without creating or destroying it), and Gaussian mounds of new sand
// for pouring and dripping. Only the deposits' bounding region is dispatched.
const dropShader = `
struct DropParams {
  grid: vec4f,
  region: vec4f,
  limits: vec4f,
  drops: array<vec4f, ${WATER.maxDropsPerFrame * 2}>,
}
@group(0) @binding(0) var<uniform> params: DropParams;
@group(0) @binding(1) var<storage, read_write> state: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> moisture: array<f32>;
@group(0) @binding(3) var<storage, read_write> glow: array<f32>;
@group(0) @binding(4) var<storage, read_write> packing: array<f32>;

@compute @workgroup_size(8, 8)
fn wet(@builtin(global_invocation_id) invocation: vec3u) {
  if (f32(invocation.x) >= params.region.z || f32(invocation.y) >= params.region.w) { return; }
  let cell = vec2u(params.region.xy) + invocation.xy;
  let resolution = u32(params.grid.x);
  if (any(cell >= vec2u(resolution))) { return; }
  let index = cell.y * resolution + cell.x;
  let position = (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
  var wetness = moisture[index];
  var height = state[index].x;
  var light = glow[index];
  var packed = packing[index];
  for (var drop = 0u; drop < u32(params.grid.w); drop++) {
    let shape = params.drops[drop * 2u];
    let impact = params.drops[drop * 2u + 1u];
    let offset = position - shape.xy;
    let distanceSquared = dot(offset, offset);
    let radial = distanceSquared / max(impact.y * impact.y, 1e-12);
    if (radial < 9.0) { height -= impact.x * (1.0 - radial) * exp(-radial); }
    let mound = distanceSquared / max(shape.z * shape.z * 0.25, 1e-12);
    if (mound < 12.0) {
      // New dry sand mixes into the surface layer by volume before any water
      // the deposit carries is added.
      let added = impact.z * exp(-mound);
      height += added;
      wetness *= ${WATER.surfaceLayer} / (${WATER.surfaceLayer} + added);
      // Poured and dripped sand lands loose.
      packed = (packed * ${WATER.surfaceLayer} + ${KINETIC.loosePacking} * added) / (${WATER.surfaceLayer} + added);
    }
    let splash = shape.w * (1.0 - smoothstep(0.55, 1.0, sqrt(distanceSquared) / max(shape.z, 1e-7)));
    wetness += splash;
    // Landing water stirs the plankton it carries.
    light += splash * 0.8;
  }
  glow[index] = min(light, 1.5);
  packing[index] = packed;
  moisture[index] = min(wetness, params.limits.x);
  state[index].x = max(height, params.limits.y);
}
`

// Runs after integration each substep. Moisture rides with the sand that the
// conservative flux moved and spreads slowly by capillary diffusion. Water above
// saturation is a surface film that flows down the water-surface gradient, so it
// spreads across flats and runs into grooves, then evaporates or soaks in.
const hydrateShader = `
${fluxLayout}
struct Params { grid: vec4f, physics: vec4f, tool: vec4f, material: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> flux: array<Flux>;
@group(0) @binding(2) var<storage, read> source: array<vec4f>;
@group(0) @binding(3) var<storage, read> moistureSource: array<f32>;
@group(0) @binding(4) var<storage, read_write> moistureDestination: array<f32>;
@group(0) @binding(5) var<storage, read> contactField: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> glow: array<f32>;
@group(0) @binding(7) var<storage, read> packingSource: array<f32>;
@group(0) @binding(8) var<storage, read_write> packingDestination: array<f32>;

fn address(cell: vec2i) -> u32 {
  return u32(cell.y) * u32(params.grid.x) + u32(cell.x);
}
fn inside(cell: vec2i) -> bool {
  return all(cell >= vec2i(0)) && all(cell < vec2i(i32(params.grid.x)));
}
fn surfaceWater(index: u32) -> f32 {
  return max(0.0, moistureSource[index] - 1.0);
}

@compute @workgroup_size(8, 8)
fn hydrate(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(params.grid.x)))) { return; }
  let cell = vec2i(invocation.xy);
  let index = address(cell);
  let wetness = moistureSource[index];
  let height = source[index].x;
  let remaining = max(0.0, height - totalFlux(flux[index]));
  var water = wetness * remaining;
  // Packing describes the surface layer. Sand a tool shoves into a cell is
  // compressed and keeps its packing; sand that arrives by flowing on its own
  // (slumping, creeping) tumbles loose. What stays keeps its packing.
  let shoved = params.tool.x > 0.0 && contactField[index].y > 0.05;
  let arrival = select(0.5, 1.0, shoved);
  var packed = packingSource[index] * ${WATER.surfaceLayer};
  var layer = ${WATER.surfaceLayer};
  var carried = remaining;
  var exchange = 0.0;
  let film = surfaceWater(index);
  for (var axis = 0u; axis < 8u; axis++) {
    let neighbor = cell + neighbors[axis];
    if (!inside(neighbor)) { continue; }
    let other = address(neighbor);
    let otherWetness = moistureSource[other];
    let amount = component(flux[other], axis ^ 1u);
    water += amount * otherWetness;
    packed += amount * packingSource[other] * arrival;
    layer += amount;
    carried += amount;
    if (axis >= 4u) { continue; }
    // Symmetric per-link exchanges, so every pair agrees and water is conserved.
    // Capillary wicking needs grain contact: cells at very different heights
    // (a castle wall and the beach beside it) touch only at the wall's foot.
    let contact = exp(-abs(height - source[other].x) / 0.002);
    exchange += 0.004 * contact * (otherWetness - wetness);
    let otherFilm = surfaceWater(other);
    let head = (height + film * ${WATER.filmThickness}) - (source[other].x + otherFilm * ${WATER.filmThickness});
    exchange -= clamp(head / ${WATER.filmThickness} * 0.25, -otherFilm * 0.24, film * 0.24);
  }
  let advected = select(wetness, water / carried, carried > 1e-9);
  let mixed = max(0.0, advected + exchange);
  let damp = min(mixed, 1.0) * exp(-params.grid.w / ${WATER.dampEvaporation.toFixed(1)});
  let standing = max(0.0, mixed - 1.0) * exp(-params.grid.w / ${WATER.filmInfiltration.toFixed(1)});
  var result = min(damp + standing, ${WATER.maxMoisture});
  // Groundwater seeps into anything dug below the water table as a standing
  // pool, and keeps the capillary fringe just above it damp.
  let table = ${WATER.waterTable.toFixed(6)};
  if (height < table) {
    result = max(result, min(${WATER.maxMoisture}, 1.0 + (table - height) / ${WATER.filmThickness}));
  } else if (height < table + ${WATER.capillaryFringe}) {
    result = max(result, 0.75 * (1.0 - (height - table) / ${WATER.capillaryFringe}));
  }
  // Below the sun-dried top layer the beach is damp, so a hole dug deeper than
  // that exposes cohesive walls (finger strokes never reach this deep).
  let buried = ${SAND.depth.toFixed(6)} - height;
  result = max(result, ${WATER.subsurfaceWetness} * smoothstep(${WATER.dryLayer}, ${WATER.dryLayer + 0.015}, buried));
  moistureDestination[index] = result;

  // Bioluminescence: plankton in wet sand flash when the grains around them
  // are disturbed and fade within a couple of seconds. Moving tools stir more
  // than a still press; the disturbed shell around a contact glows faintly.
  var light = glow[index] * exp(-params.grid.w / ${WATER.glowFade.toFixed(3)});
  if (params.tool.x > 0.0) {
    let contact = contactField[index];
    let stir = contact.x * (0.35 + min(1.0, length(contact.zw) / 0.2)) + contact.y * 0.12;
    light += stir * smoothstep(${WATER.glowWetness}, ${(WATER.glowWetness + 0.5).toFixed(3)}, result) * params.grid.w * 14.0;
  }
  glow[index] = min(light, 1.5);

  // A tool's core presses the sand under it firm.
  var firmness = packed / layer;
  if (params.tool.x > 0.0) { firmness += contactField[index].x * (1.0 - firmness) * 0.06; }
  packingDestination[index] = clamp(firmness, 0.0, 1.0);
}
`

export class SandWater {
  readonly moisture: GPUBuffer[]
  /** Bioluminescent glow per cell (updated in place: each cell reads only itself). */
  readonly glow: GPUBuffer
  /** How packed the surface sand is, 0 loose to 1 molded (ping-pong with the state). */
  readonly packing: GPUBuffer[]
  private readonly initialPacking: Float32Array
  private readonly dropUniform: GPUBuffer
  private readonly dropData = new Float32Array(dropParamVectors * 4)
  private dropPipeline!: GPUComputePipeline
  private dropGroups: GPUBindGroup[] = []
  private hydratePipeline!: GPUComputePipeline
  private hydrateGroups: GPUBindGroup[][] = []

  private readonly device: GPUDevice
  private readonly resolution: number
  constructor(device: GPUDevice, resolution: number) {
    this.device = device
    this.resolution = resolution
    this.moisture = [0, 1].map((index) => device.createBuffer({ label: `Moisture ${index}`, size: resolution * resolution * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }))
    this.packing = [0, 1].map((index) => device.createBuffer({ label: `Packing ${index}`, size: resolution * resolution * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }))
    this.initialPacking = new Float32Array(resolution * resolution).fill(KINETIC.initialPacking)
    this.glow = device.createBuffer({ label: 'Bioluminescence', size: resolution * resolution * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
    this.dropUniform = device.createBuffer({ label: 'Water drops', size: dropParamBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  async initialize(states: GPUBuffer[], flux: GPUBuffer, uniforms: GPUBuffer[], contact: GPUBuffer) {
    const [drops, hydrate] = await Promise.all([
      checkedShader(this.device, 'Water drops WGSL', dropShader),
      checkedShader(this.device, 'Moisture transport WGSL', hydrateShader),
    ])
    ;[this.dropPipeline, this.hydratePipeline] = await Promise.all([
      this.device.createComputePipelineAsync({ label: 'Water drops', layout: 'auto', compute: { module: drops, entryPoint: 'wet' } }),
      this.device.createComputePipelineAsync({ label: 'Moisture transport', layout: 'auto', compute: { module: hydrate, entryPoint: 'hydrate' } }),
    ])
    this.dropGroups = states.map((state, index) => this.device.createBindGroup({ layout: this.dropPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.dropUniform } },
      { binding: 1, resource: { buffer: state } },
      { binding: 2, resource: { buffer: this.moisture[index] } },
      { binding: 3, resource: { buffer: this.glow } },
      { binding: 4, resource: { buffer: this.packing[index] } },
    ] }))
    this.hydrateGroups = uniforms.map((uniform) => states.map((state, index) => this.device.createBindGroup({ layout: this.hydratePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: flux } },
      { binding: 2, resource: { buffer: state } },
      { binding: 3, resource: { buffer: this.moisture[index] } },
      { binding: 4, resource: { buffer: this.moisture[1 - index] } },
      { binding: 5, resource: { buffer: contact } },
      { binding: 6, resource: { buffer: this.glow } },
      { binding: 7, resource: { buffer: this.packing[index] } },
      { binding: 8, resource: { buffer: this.packing[1 - index] } },
    ] })))
  }

  /** Lands deposits on the current state and moisture. Returns whether any work was encoded. */
  encodeDeposits(encoder: GPUCommandEncoder, drops: readonly Deposit[], current: number) {
    const batch = drops.slice(0, WATER.maxDropsPerFrame)
    if (!batch.length) return false
    const spacing = SAND.extent / this.resolution
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    this.dropData.fill(0)
    batch.forEach((drop, index) => {
      const reach = Math.max(drop.radius * (drop.sand > 0 ? 1.75 : 1), drop.pit > 0 ? drop.pitRadius * 3 : 0)
      minX = Math.min(minX, drop.x - reach); maxX = Math.max(maxX, drop.x + reach)
      minY = Math.min(minY, drop.y - reach); maxY = Math.max(maxY, drop.y + reach)
      this.dropData.set([drop.x, drop.y, drop.radius, drop.amount, drop.pit, drop.pitRadius, drop.sand, 0], 12 + index * 8)
    })
    const toCell = (value: number) => (value + SAND.extent / 2) / spacing - 0.5
    const x0 = Math.max(0, Math.floor(toCell(minX)) - 1)
    const y0 = Math.max(0, Math.floor(toCell(minY)) - 1)
    const x1 = Math.min(this.resolution, Math.ceil(toCell(maxX)) + 2)
    const y1 = Math.min(this.resolution, Math.ceil(toCell(maxY)) + 2)
    if (x1 <= x0 || y1 <= y0) return false
    this.dropData.set([this.resolution, spacing, SAND.extent, batch.length, x0, y0, x1 - x0, y1 - y0, WATER.maxMoisture, SAND.floor, 0, 0])
    this.device.queue.writeBuffer(this.dropUniform, 0, this.dropData)
    const pass = encoder.beginComputePass({ label: 'Water drops' })
    pass.setPipeline(this.dropPipeline)
    pass.setBindGroup(0, this.dropGroups[current])
    pass.dispatchWorkgroups(Math.ceil((x1 - x0) / 8), Math.ceil((y1 - y0) / 8))
    pass.end()
    return true
  }

  /** Moisture transport for one substep, reading [current] and writing [1 - current]. */
  encodeHydrate(pass: GPUComputePassEncoder, slot: number, current: number) {
    pass.setPipeline(this.hydratePipeline)
    pass.setBindGroup(0, this.hydrateGroups[slot][current])
    pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(this.resolution / 8))
  }

  /** Dry, dark, freshly settled sand: no moisture or glow, and the tray's starting packing. */
  clear(encoder: GPUCommandEncoder) {
    for (const buffer of [...this.moisture, this.glow]) encoder.clearBuffer(buffer)
    for (const buffer of this.packing) this.device.queue.writeBuffer(buffer, 0, this.initialPacking)
  }

  dispose() { [...this.moisture, ...this.packing, this.glow, this.dropUniform].forEach((buffer) => buffer.destroy()) }
}
