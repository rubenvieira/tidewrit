import { KINETIC } from '../config'
import { waveShoreWgsl } from '../reset/wgsl'
import { bedReliefWgsl } from './bed-relief'

// The "Start again" wash. Sand under the water slumps and smooths toward the
// untouched bed while it stays covered, so prints soften and fade instead of
// vanishing the moment the shoreline reaches them. The last frame settles any
// remainder so the tray always ends clean.
export const waveResetShader = `
${waveShoreWgsl}
struct ResetParams {
  grid: vec4f,
  wave: vec4f,
  wash: vec4f,
}
@group(0) @binding(0) var<uniform> params: ResetParams;
@group(0) @binding(1) var<storage, read> source: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> destination: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> moistureA: array<f32>;
@group(0) @binding(4) var<storage, read_write> moistureB: array<f32>;
@group(0) @binding(5) var<storage, read_write> packingA: array<f32>;
@group(0) @binding(6) var<storage, read_write> packingB: array<f32>;

fn address(cell: vec2i) -> u32 {
  let size = i32(params.grid.x);
  let clamped = clamp(cell, vec2i(0), vec2i(size - 1));
  return u32(clamped.y * size + clamped.x);
}
fn location(cell: vec2i) -> vec2f {
  return (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
}
${bedReliefWgsl}
fn initialHeight(cell: vec2i) -> f32 {
  return params.grid.w + bedRelief(location(cell));
}
fn deviation(cell: vec2i) -> f32 {
  let size = i32(params.grid.x);
  let clamped = clamp(cell, vec2i(0), vec2i(size - 1));
  return source[address(clamped)].x - initialHeight(clamped);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(params.grid.x)))) { return; }
  let cell = vec2i(invocation.xy);
  let index = address(cell);
  let center = source[index];
  let position = location(cell);
  let finish = params.wash.z > 0.5;
  let covered = position.y >= shorelineFront(position.x, params.wave.x, params.wave.y);
  if (!covered && !finish) {
    destination[index] = center;
    return;
  }
  let settle = select(params.wave.z, 1.0, finish);
  let smoothing = params.wave.w;
  let own = center.x - initialHeight(cell);
  let neighbours = 0.25 * (deviation(cell + vec2i(1, 0)) + deviation(cell - vec2i(1, 0))
    + deviation(cell + vec2i(0, 1)) + deviation(cell - vec2i(0, 1)));
  let softened = mix(own, neighbours, smoothing) * (1.0 - settle);
  destination[index] = vec4f(initialHeight(cell) + softened, center.yzw * (1.0 - settle));
  moistureA[index] = moistureA[index] * (1.0 - settle);
  moistureB[index] = moistureB[index] * (1.0 - settle);
  packingA[index] = mix(packingA[index], ${KINETIC.initialPacking}, settle);
  packingB[index] = mix(packingB[index], ${KINETIC.initialPacking}, settle);
}
`
