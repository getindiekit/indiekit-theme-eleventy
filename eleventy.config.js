import { existsSync, readFileSync } from "node:fs";
import { DateTime } from "luxon";
import pluginSass from "./_11ty/sassPlugin.js";
import pluginSyntaxHighlight from "./_11ty/syntaxHighlightPlugin.js";
import pluginImage from "./_11ty/imagePlugin.js";
import pluginImageAvatar from "./_11ty/imageAvatarPlugin.js";
import pluginWebmentions from "./_11ty/webmentionsPlugin.js";
import pluginWebc from "@11ty/eleventy-plugin-webc";
import { feedPlugin } from "@11ty/eleventy-plugin-rss";
import { IdAttributePlugin } from "@11ty/eleventy";
import fontAwesomePlugin from "@11ty/font-awesome";

// Site identity comes from _data/site.json, not hardcoded here (source read
// siteData the same way). site.json's url has no trailing slash; the feed
// plugin's `base` needs one — add it explicitly rather than relying on luck.
const siteData = JSON.parse(readFileSync(new URL("./_data/site.json", import.meta.url)));
const feedBase = siteData.url.endsWith("/") ? siteData.url : `${siteData.url}/`;

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(pluginSass);
  eleventyConfig.addPlugin(pluginSyntaxHighlight);
  eleventyConfig.addPlugin(pluginImage);
  eleventyConfig.addPlugin(pluginImageAvatar);
  eleventyConfig.addPlugin(pluginWebmentions);
  eleventyConfig.addPlugin(pluginWebc, { components: "_components/**/*.webc" });
  eleventyConfig.addPlugin(IdAttributePlugin);

  // Source (zachleat.com) passes { transform: false, shortcode: "icon",
  // defaultAttributes: {...} } — reproduced verbatim (paths/site identity
  // are the only things this theme changes; no icon markup uses this yet).
  eleventyConfig.addPlugin(fontAwesomePlugin, {
    transform: false,
    shortcode: "icon",
    defaultAttributes: {
      class: "z-icon",
      width: "20",
      height: "20",
    },
  });

  eleventyConfig.addPlugin(feedPlugin, {
    type: "atom",
    outputPath: "/feed.xml",
    collection: { name: "post", limit: 20 },
    metadata: {
      language: "en",
      title: siteData.name,
      subtitle: siteData.description,
      base: feedBase,
      author: siteData.author,
    },
  });

  // webmention-avatar.liquid's fallback <img> references this path. Source
  // ships the same file at the same path via the same passthrough pattern.
  eleventyConfig.addPassthroughCopy("web/img");

  // Speedlify 2: the score widget footer.liquid links (static/js/*) and the
  // health-score badge component (_components/*) — source merges both into
  // its "static/" output tree via the same passthrough pattern; do the same
  // so health-score.js is actually reachable, not just copied into the repo.
  eleventyConfig.addPassthroughCopy({ static: "/" });
  // Extension-limited (not the whole _components dir): publishing the raw
  // .webc source templates into _site would ship build inputs as if they
  // were output. This theme maps {static: "/"} to root (not the source's
  // "static/" subtree — base.liquid already loads /js/*, and a second
  // /static/ convention would exist for one unused component), so
  // toggle-button.webc's own asset links point at "/toggle-button.*" below.
  eleventyConfig.addPassthroughCopy({ "_components/*.{css,js}": "/" });

  // Source (zachleat.com, eleventy.config.js:656-674) pins one timezone
  // across three date-parsing branches so YAML dates, ISO strings and a
  // fallback all resolve to the same wall-clock day — see
  // https://github.com/11ty/eleventy/issues/3668. Adapted for Indiekit:
  // (1) the zone comes from site.json, not a hardcoded "America/Chicago";
  // (2) Indiekit filenames are slug-based (no YYYY-MM-DD prefix), and
  // `@rmdes/indiekit-preset-eleventy` always writes a `date` front-matter
  // key (renamed from Micropub's `published`, deleting the original) —
  // so a file with no `date` at all is content this preset never
  // produces. The fallback instead looks for a literal `published:` key
  // in the file's own front matter, for content authored outside that
  // preset, reading the raw file the same way the source's regex reads
  // the raw filename.
  // No `timezone` key (a downstream consumer's site.json) falls back to
  // UTC rather than the build process's ambient zone — a fixed zone keeps
  // builds reproducible across machines, the same property this file exists
  // to give configured-timezone sites.
  const TIME_ZONE = siteData.timezone || "utc";

  // An ISO string that already carries an explicit offset or `Z` names an
  // unambiguous instant — `keepLocalTime` must never touch it, that would
  // re-anchor the instant to a different moment. Only a zone-less value (a
  // bare YYYY-MM-DD, or a time with no offset) is meant as a wall-clock
  // reading that should land on the same day in TIME_ZONE.
  const hasExplicitOffset = (isoString) => /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(isoString.trim());

  eleventyConfig.addDateParsing(function (dateValue) {
    let localDate;
    if (dateValue instanceof Date) {
      // js-yaml auto-parses an unquoted front-matter timestamp into a JS
      // Date, which has no zone of its own — by the time it gets here there
      // is no way to tell whether the original string had an explicit
      // offset/Z (Micropub's ISO output, via
      // `@rmdes/indiekit-preset-eleventy` — always unquoted, so this is the
      // branch real Indiekit content actually hits) or was zone-less. Read
      // the file's own front matter to recover that distinction — the same
      // technique the fallback branch below already uses for `published:`.
      const raw = existsSync(this.page.inputPath) ? readFileSync(this.page.inputPath, "utf8") : "";
      const dateMatch = raw.match(/^date:\s*["']?([^"'\n]+?)["']?\s*$/m);

      if (dateMatch && hasExplicitOffset(dateMatch[1])) {
        // Explicit offset/Z: trust the instant js-yaml already parsed
        // correctly — no re-anchoring.
        localDate = DateTime.fromJSDate(dateValue, { zone: "utc" });
      } else {
        // Zone-less (bare date, or no front-matter line to check): treat
        // the UTC-midnight reading js-yaml produced as a wall-clock time in
        // TIME_ZONE instead, so the calendar day the author meant doesn't
        // shift.
        localDate = DateTime.fromJSDate(dateValue, { zone: "utc" }).setZone(TIME_ZONE, {
          keepLocalTime: true,
        });
      }
    } else if (typeof dateValue === "string") {
      // override String dates. `zone: TIME_ZONE` only affects display for a
      // string that already carries an offset/Z — the instant survives
      // untouched (verified: `.toUTC()` matches regardless of this option).
      // For a zone-less string it supplies the missing zone, same intent as
      // the Date branch above.
      localDate = DateTime.fromISO(dateValue, { zone: TIME_ZONE });
    } else if (existsSync(this.page.inputPath)) {
      // Virtual templates (e.g. the RSS feed plugin's generated .njk) have
      // no real file to read — existsSync guards against those.
      const raw = readFileSync(this.page.inputPath, "utf8");
      const publishedMatch = raw.match(/^published:\s*["']?([^"'\n]+?)["']?\s*$/m);
      if (publishedMatch) {
        localDate = DateTime.fromISO(publishedMatch[1], { zone: TIME_ZONE });
      }
    }

    if (localDate?.isValid) {
      return localDate;
    }
  });

  // _includes/types/*.liquid's `dt-published` datetime attribute used to be
  // `{{ date | date: '%Y-%m-%dT%H:%M:%SZ' }}` — that `Z` is a literal
  // strftime character, not a conversion: LiquidJS's `date` filter reads
  // hours/minutes/seconds off the JS Date in the *process's local*
  // timezone, so the attribute stamped local wall-clock time and then
  // asserted it was UTC. Emits true UTC instead, via Luxon rather than the
  // process's ambient timezone — correct regardless of what machine the
  // build runs on. Templates read the data cascade's raw `date` value
  // (addDateParsing's resolved value is never copied back onto it — see
  // eleventy.config.js's addDateParsing comment above), which is a JS Date
  // for the common unquoted-front-matter case and a string otherwise;
  // handle both the same way the addDateParsing branches above do.
  eleventyConfig.addLiquidFilter("isoInstant", (dateValue) => {
    const parsed =
      dateValue instanceof Date
        ? DateTime.fromJSDate(dateValue, { zone: "utc" })
        : DateTime.fromISO(String(dateValue), { zone: TIME_ZONE });
    return parsed.isValid ? parsed.toUTC().toISO({ suppressMilliseconds: true }) : "";
  });

  // The human-readable date text next to `isoInstant`'s machine-readable
  // one (`{{ date | date: "%-d %B %Y" }}` in every _includes/types/*.liquid
  // partial) has the identical defect isoInstant was written to fix: LiquidJS's
  // `date` filter reads the JS Date's fields in the *build process's local*
  // timezone, so the same content renders a different calendar day depending
  // on where it's built. Same instant, same TIME_ZONE, same Date/string
  // branches as isoInstant above — only the output format and target zone
  // (TIME_ZONE for display, not UTC) differ. Luxon's "d MMMM yyyy" is the
  // token-for-token equivalent of strftime's "%-d %B %Y" (unpadded day, full
  // month name, 4-digit year).
  eleventyConfig.addLiquidFilter("humanDate", (dateValue) => {
    const parsed =
      dateValue instanceof Date
        ? DateTime.fromJSDate(dateValue, { zone: "utc" })
        : DateTime.fromISO(String(dateValue), { zone: TIME_ZONE });
    return parsed.isValid ? parsed.setZone(TIME_ZONE).toFormat("d MMMM yyyy") : "";
  });

  return {
    dir: {
      input: "content",
      output: "_site",
      includes: "../_includes",
      data: "../_data",
    },
    markdownTemplateEngine: "liquid",
    htmlTemplateEngine: "liquid",
  };
}
