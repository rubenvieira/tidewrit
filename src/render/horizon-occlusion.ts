// Squared cosine-weighted missing sky, equivalent to the clamped angular
// horizon integral without evaluating trigonometry for every height probe.
export const horizonOcclusionWgsl = `
fn horizonOcclusionSquared(tangentSlope: f32, highestSlope: f32) -> f32 {
  let horizonSlope = max(tangentSlope, highestSlope);
  // Dot((1, horizon), (1, tangent)) <= 0 means their angle is >= pi/2.
  if (1.0 + horizonSlope * tangentSlope <= 0.0) { return 1.0; }
  let difference = horizonSlope - tangentSlope;
  return clamp(difference * difference
    / ((1.0 + horizonSlope * horizonSlope) * (1.0 + tangentSlope * tangentSlope)), 0.0, 1.0);
}
`
