// A bounded grid walk intersects the same two triangles as the rendered bed.
// Ordinary flights visit only the cells they cross. Extreme trajectories are
// limited to a traversable distance before this helper is called.
export const PARTICLE_CONTACT = { maxCells: 16, clearance: 0.00014, restingClearance: 0.00018 } as const

export const particleContactWgsl = `
struct BedImpact { fraction: f32, surface: vec3f }
fn triangleImpact(start: vec3f, finish: vec3f, first: f32, last: f32, cell: vec2i, heights: vec4f) -> BedImpact {
  let base = (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
  let middle = mix(start.xz, finish.xz, (first + last) * 0.5) - base;
  var gradient = vec2f(heights.y - heights.x, heights.z - heights.x) / params.grid.y;
  var intercept = heights.x;
  if (middle.x + middle.y > params.grid.y) {
    gradient = vec2f(heights.w - heights.z, heights.w - heights.y) / params.grid.y;
    intercept = heights.w - (gradient.x + gradient.y) * params.grid.y;
  }
  let segmentStart = mix(start, finish, first);
  let segmentEnd = mix(start, finish, last);
  let fromHeight = intercept + dot(gradient, segmentStart.xz - base);
  let toHeight = intercept + dot(gradient, segmentEnd.xz - base);
  let fromGap = segmentStart.y - fromHeight - ${PARTICLE_CONTACT.clearance};
  let toGap = segmentEnd.y - toHeight - ${PARTICLE_CONTACT.clearance};
  if (fromGap > 0.0 && toGap > 0.0) { return BedImpact(2.0, vec3f(0.0)); }
  // Float roundoff at the skin is not an impact when already separating.
  if (fromGap >= -1e-7 && toGap >= fromGap) { return BedImpact(2.0, vec3f(0.0)); }
  let fraction = mix(first, last, clamp(fromGap / max(fromGap - toGap, 1e-10), 0.0, 1.0));
  let hit = mix(start, finish, fraction);
  return BedImpact(fraction, vec3f(intercept + dot(gradient, hit.xz - base), gradient));
}
fn sweptBedImpact(start: vec3f, finish: vec3f) -> BedImpact {
  let origin = (start.xz + params.grid.z * 0.5) / params.grid.y - 0.5;
  let delta = (finish.xz - start.xz) / params.grid.y;
  var cell = vec2i(floor(origin));
  let direction = vec2i(select(-1, 1, delta.x >= 0.0), select(-1, 1, delta.y >= 0.0));
  let boundary = vec2f(cell) + vec2f(select(0.0, 1.0, delta.x >= 0.0), select(0.0, 1.0, delta.y >= 0.0));
  // Safe denominators also keep stationary axes out of the walk.
  let inverse = vec2f(1.0) / max(abs(delta), vec2f(1e-8));
  var next = abs(boundary - origin) * inverse;
  if (abs(delta.x) < 1e-8) { next.x = 2.0; }
  if (abs(delta.y) < 1e-8) { next.y = 2.0; }
  var first = 0.0;
  for (var step = 0; step < ${PARTICLE_CONTACT.maxCells}; step++) {
    let last = min(1.0, min(next.x, next.y));
    let heights = vec4f(heightAt(cell), heightAt(cell + vec2i(1, 0)), heightAt(cell + vec2i(0, 1)), heightAt(cell + vec2i(1, 1)));
    let diagonalRate = delta.x + delta.y;
    var split = last;
    if (abs(diagonalRate) > 1e-8) {
      let diagonal = (1.0 - (origin.x - f32(cell.x)) - (origin.y - f32(cell.y))) / diagonalRate;
      if (diagonal > first && diagonal < last) { split = diagonal; }
    }
    let initial = triangleImpact(start, finish, first, split, cell, heights);
    if (initial.fraction <= 1.0) { return initial; }
    if (split < last) {
      let lastImpact = triangleImpact(start, finish, split, last, cell, heights);
      if (lastImpact.fraction <= 1.0) { return lastImpact; }
    }
    if (last >= 1.0) { break; }
    if (next.x <= last) { cell.x += direction.x; next.x += inverse.x; }
    if (next.y <= last) { cell.y += direction.y; next.y += inverse.y; }
    first = last;
  }
  return BedImpact(2.0, vec3f(0.0));
}
`
