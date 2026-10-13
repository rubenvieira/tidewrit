/** Analytic line averages: one swept source costs one operation, even at high speed. */
export const sweptKernels = `
fn complementaryError(x: f32) -> f32 {
  let t = 1.0 / (1.0 + 0.3275911 * x);
  return (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * exp(-x * x);
}
fn sweptGaussian(position: vec2f, origin: vec2f, to: vec2f, width: f32, cutoff: f32) -> f32 {
  let direction = (to - origin) / width;
  let extent = length(direction);
  let offset = (position - origin) / width;
  if (extent < 0.001) {
    let centered = offset - direction * 0.5;
    let radial = dot(centered, centered);
    return select(0.0, exp(-radial), radial < cutoff);
  }
  let along = dot(offset, direction) / extent;
  let across = (offset.x * direction.y - offset.y * direction.x) / extent;
  let squared = across * across;
  if (squared >= cutoff) { return 0.0; }
  let reach = sqrt(cutoff - squared);
  let low = max(-along, -reach);
  let high = min(extent - along, reach);
  if (high <= low) { return 0.0; }
  var integral: f32;
  if (low >= 0.0) { integral = complementaryError(low) - complementaryError(high); }
  else if (high <= 0.0) { integral = complementaryError(-high) - complementaryError(-low); }
  else { integral = 2.0 - complementaryError(-low) - complementaryError(high); }
  return exp(-squared) * 0.886226925452758 * max(0.0, integral) / extent;
}
fn bowlIntegral(t: f32, a: f32) -> f32 {
  return t * (a * a + t * t * (-0.666666666666667 * a + t * t * 0.2));
}
fn sweptBowl(position: vec2f, origin: vec2f, to: vec2f, radius: f32) -> f32 {
  let direction = (to - origin) / radius;
  let extent = length(direction);
  let offset = (position - origin) / radius;
  if (extent < 0.001) {
    let centered = offset - direction * 0.5;
    let depth = max(0.0, 1.0 - dot(centered, centered));
    return depth * depth;
  }
  let along = dot(offset, direction) / extent;
  let across = (offset.x * direction.y - offset.y * direction.x) / extent;
  let a = 1.0 - across * across;
  if (a <= 0.0) { return 0.0; }
  let reach = sqrt(a);
  let low = max(-along, -reach);
  let high = min(extent - along, reach);
  if (high <= low) { return 0.0; }
  return max(0.0, bowlIntegral(high, a) - bowlIntegral(low, a)) / extent;
}
`
