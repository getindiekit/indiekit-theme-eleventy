import { existsSync, readFileSync } from "node:fs";
import { DateTime } from "luxon";

// "Does this ISO-ish timestamp already carry an explicit offset/Z" — the
// question resolveDate()'s Date branch needs answered for a JS Date's
// original front-matter text (a Date has no zone of its own). Exported
// standalone so eleventy.config.js and its test suite can both exercise the
// exact same rule that resolveDate() uses internally.
//
// js-yaml's implicit !!timestamp resolver (which is what turns an unquoted
// front-matter `date:` into a JS Date before this code ever sees it) accepts
// more than strict ISO 8601: a space instead of `T` between date and time,
// a space before the offset, and a two-digit offset with no minutes part.
// All of those are "explicit offset" just as much as `T…Z` is — the prior
// regex (`/T.*(?:Z|[+-]\d{2}:?\d{2})$/`) required a literal `T` and always
// matched at the string's end, so it missed all three.
export const hasExplicitOffset = (isoString) =>
  /[T ].*(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(isoString.trim());

// Resolve any front-matter `date` value (a JS Date from js-yaml's implicit
// timestamp parsing, an ISO string, or nothing) to the Luxon DateTime that
// addDateParsing, isoInstant and humanDate must all agree on. `inputPath` is
// the page's on-disk file (used to re-read the raw front-matter text — a JS
// Date carries no record of whether the original string had an explicit
// offset); pass undefined/a missing path to skip that lookup, which safely
// falls through to the zone-less (keepLocalTime) treatment.
// `key` names the front-matter line to re-read for a Date (default `date`);
// an event's `start`/`end` are unquoted timestamps too and need the same rule.
export function resolveDate(dateValue, inputPath, timeZone, key = "date") {
  let localDate;

  if (dateValue instanceof Date) {
    const raw = inputPath && existsSync(inputPath) ? readFileSync(inputPath, "utf8") : "";
    const dateMatch = raw.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m"));

    if (dateMatch && hasExplicitOffset(dateMatch[1])) {
      // Explicit offset/Z: js-yaml (or Date.parse, for a quoted string that
      // still carries one) already computed the correct instant — trust it,
      // no re-anchoring.
      localDate = DateTime.fromJSDate(dateValue, { zone: "utc" });
    } else {
      // Zone-less (bare date, a zone-less time, or no front-matter line to
      // check): treat the UTC-midnight reading js-yaml produced as a
      // wall-clock time in timeZone instead, so the calendar day the author
      // meant doesn't shift.
      localDate = DateTime.fromJSDate(dateValue, { zone: "utc" }).setZone(timeZone, {
        keepLocalTime: true,
      });
    }
  } else if (typeof dateValue === "string") {
    // `zone: timeZone` only affects display for a string that already
    // carries an offset/Z — the instant survives untouched. For a zone-less
    // string it supplies the missing zone, same intent as the Date branch.
    localDate = DateTime.fromISO(dateValue, { zone: timeZone });
  } else if (inputPath && existsSync(inputPath)) {
    // Virtual templates (e.g. the RSS feed plugin's generated .njk) have no
    // real file to read — the inputPath guard above skips those.
    const raw = readFileSync(inputPath, "utf8");
    const publishedMatch = raw.match(/^published:\s*["']?([^"'\n]+?)["']?\s*$/m);
    if (publishedMatch) {
      localDate = DateTime.fromISO(publishedMatch[1], { zone: timeZone });
    }
  }

  return localDate?.isValid ? localDate : undefined;
}
