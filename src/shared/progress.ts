/** Converts ratio-style or byte-style progress events to a clamped percentage. */
export function progressPercentage(
  event: Pick<ProgressEvent, 'lengthComputable' | 'loaded' | 'total'>,
): number {
  const ratio =
    event.lengthComputable && event.total > 0 ? event.loaded / event.total : event.loaded;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}
