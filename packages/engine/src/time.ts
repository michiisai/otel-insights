/**
 * Parse a `since` string into a nanosecond timestamp string for SQL
 * comparison against the TEXT columns start_time_unix_nano / timestamp_unix_nano.
 *
 * Accepted formats
 *   Relative:  "30s" | "5m" | "1h" | "6h" | "24h" | "1d" | "7d"
 *   Absolute:  any ISO 8601 string, e.g. "2024-01-15T10:00:00Z"
 *
 * Returns a 19-digit zero-padded nanosecond string, or null when the input is
 * falsy / unparseable.
 *
 * Why text comparison works: current Unix nanosecond timestamps are all exactly
 * 19 digits and will remain so until year 2554, so lexicographic >= is
 * equivalent to numeric >= for all practical values.
 */
export function parseSinceNano(since: string | undefined | null): string | null {
  if (!since?.trim()) { return null; }
  const s = since.trim();

  // Relative duration: <number><unit>  e.g. "5m", "1h", "2d"
  const rel = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(s);
  if (rel) {
    const n    = parseFloat(rel[1]!);
    const unit = rel[2]!.toLowerCase();
    const offsetMs = unit === 's' ? n * 1_000
                   : unit === 'm' ? n * 60_000
                   : unit === 'h' ? n * 3_600_000
                   :                n * 86_400_000; // d
    return msToNanoString(Date.now() - offsetMs);
  }

  // Absolute ISO 8601
  const ts = Date.parse(s);
  if (!isNaN(ts)) { return msToNanoString(ts); }

  return null;
}

/**
 * Parse an `until` string into a nanosecond timestamp string.
 * Relative durations ("1d", "1h") are interpreted as "that far in the past
 * from now" — i.e. the same arithmetic as parseSinceNano. Use this as the
 * upper-bound companion to parseSinceNano.
 *
 * Example: since="2d" until="1d"  →  window = yesterday only
 */
export function parseUntilNano(until: string | undefined | null): string | null {
  // Reuse the same parsing logic — relative means "N ago from now"
  return parseSinceNano(until);
}

/** Convert a millisecond epoch timestamp to a 19-digit nanosecond string. */
function msToNanoString(ms: number): string {
  // Append 6 zeros (ms → ns). String arithmetic avoids JS float precision loss.
  return Math.floor(ms).toString().padStart(13, '0') + '000000';
}
