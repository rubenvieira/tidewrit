// Return a parcel to the same triangle that supports its contact point. The
// ledger uses integer height units, so the third share receives the exact
// remainder instead of independently rounding away mass at every landing.
export const particleDepositionWgsl = `
fn depositUnits(cell: vec2i, units: i32) {
  if (units <= 0) { return; }
  let bounded = vec2u(clamp(cell, vec2i(0), vec2i(i32(params.grid.x) - 1)));
  atomicAdd(&ledger[bounded.y * u32(params.grid.x) + bounded.x], units);
}
fn depositGrain(position: vec2f, mass: f32) {
  let units = max(0, i32(round(mass * 1e9)));
  if (units == 0) { return; }
  let coordinate = clamp((position / params.grid.z + 0.5) * params.grid.x - 0.5,
    vec2f(0.0), vec2f(params.grid.x - 1.0));
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  var firstCell = cell;
  var secondCell = cell + vec2i(1, 0);
  var thirdCell = cell + vec2i(0, 1);
  var weights = vec3f(1.0 - blend.x - blend.y, blend.x, blend.y);
  if (blend.x + blend.y > 1.0) {
    firstCell = cell + vec2i(1, 1);
    secondCell = cell + vec2i(0, 1);
    thirdCell = cell + vec2i(1, 0);
    weights = vec3f(blend.x + blend.y - 1.0, 1.0 - blend.x, 1.0 - blend.y);
  }
  let first = clamp(i32(floor(f32(units) * weights.x)), 0, units);
  let second = clamp(i32(floor(f32(units) * weights.y)), 0, units - first);
  depositUnits(firstCell, first);
  depositUnits(secondCell, second);
  depositUnits(thirdCell, units - first - second);
}
`
