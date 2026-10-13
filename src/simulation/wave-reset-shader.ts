import { KINETIC } from '../config'
import { waveShoreWgsl } from '../reset/wgsl'
import { bedReliefWgsl } from './bed-relief'

export const waveResetShader = `
${waveShoreWgsl}
struct ResetParams {
  grid: vec4f,
  wave: vec4f,
  band: vec4f,
}
@group(0) @binding(0) var<uniform> params: ResetParams;
@group(0) @binding(1) var<storage, read_write> state: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> moisture: array<f32>;
@group(0) @binding(3) var<storage, read_write> packing: array<f32>;

fn address(cell: vec2u) -> u32 {
  return cell.y * u32(params.grid.x) + cell.x;
}
fn location(cell: vec2u) -> vec2f {
  return (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
}
${bedReliefWgsl}
fn initialHeight(position: vec2f) -> f32 {
  return params.grid.w + bedRelief(position);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let cell = vec2u(invocation.x, invocation.y + u32(params.band.x));
  if (cell.x >= u32(params.grid.x) || invocation.y >= u32(params.band.y) || cell.y >= u32(params.grid.x)) { return; }
  let position = location(cell);
  let previousFront = shorelineFront(position.x, params.wave.x, params.wave.z);
  let currentFront = shorelineFront(position.x, params.wave.y, params.wave.w);
  let coveredBefore = position.y >= previousFront;
  let coveredNow = position.y >= currentFront;
  if (!coveredNow || coveredBefore) { return; }
  state[address(cell)] = vec4f(initialHeight(position), 0.0, 0.0, 0.0);
  moisture[address(cell)] = 0.0;
  packing[address(cell)] = ${KINETIC.initialPacking};
}
`
