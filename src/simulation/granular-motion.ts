// Runout is confined to a loose surface layer: bulk bed velocity is a contact
// response, not permission to advect the full eight-centimeter column.
export const GRANULAR_MOTION = {
  layer: 0.001,
  linkCourant: 0.45,
  gravity: 9.81,
} as const

export const granularMotionWgsl = `
fn dryMobility(wetness: f32, kinetic: bool) -> f32 {
  return select(1.0 - smoothstep(0.02, 0.08, wetness), 0.0, kinetic);
}
fn stoppedVelocity(velocity: vec2f) -> vec2f {
  let loss = ${GRANULAR_MOTION.gravity} * params.physics.w * params.grid.w;
  let squared = dot(velocity, velocity);
  if (squared <= loss * loss) { return vec2f(0.0); }
  let speed = sqrt(squared);
  return velocity * ((speed - loss) / speed);
}
fn runoutFraction(velocity: vec2f, direction: vec2f, rise: f32, linkLength: f32) -> f32 {
  let forward = max(0.0, dot(velocity, direction));
  if (forward <= 0.0) { return 0.0; }
  // Spend kinetic energy on real uphill height before crossing a link. A
  // subcritical bank arrests a slow moving layer instead of being climbed by
  // an arbitrary fraction of its velocity every frame.
  let speedSquared = forward * forward - 2.0 * ${GRANULAR_MOTION.gravity} * max(rise, 0.0);
  let speed = sqrt(max(0.0, speedSquared));
  return min(${GRANULAR_MOTION.linkCourant}, speed * params.grid.w / (params.grid.y * linkLength));
}
`
