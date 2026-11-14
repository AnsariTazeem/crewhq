export function boundedEventInterval(
  start: Date | undefined,
  end: Date | undefined,
) {
  if (!(start instanceof Date) || !(end instanceof Date)) return null;
  const duration = end.getTime() - start.getTime();
  if (!Number.isFinite(duration) || duration <= 0 || duration > 31 * 86_400_000)
    return null;
  return { start, end };
}
