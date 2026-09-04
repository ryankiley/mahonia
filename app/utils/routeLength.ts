// The distance a trip's chart and map are scaled to: the bigger of the route's own
// length and what its days add up to. The route leads, because it says something
// true from the first moment; the days can only exceed it once the itinerary has
// been typed past what the route knows, and then the itinerary is the truth.
// Takes the DAYS rather than the list, because the two callers disagree about
// which days count — the read view scales to the stored ones, the plan panel to
// the ones its calendar currently shows (see TrailPlanPanel's `days`). Nuxt
// auto-imports app/utils, so callers use routeLengthM(...) bare.
export function routeLengthM(
  trailDistanceM: number | undefined,
  days: readonly ({ distanceM?: number } | null | undefined)[],
): number {
  return Math.max(trailDistanceM ?? 0, days.reduce((s, d) => s + (d?.distanceM ?? 0), 0));
}
