import { readFileSync } from "node:fs";
import { resolveDate } from "./_11ty/dateResolver.js";
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

// Source (zachleat.com, eleventy.config.js:28,71) registers this as global
// data rather than a plain boolean so templates can read it through the data
// cascade like any other value. Our layouts (base.liquid, default.liquid)
// already carry the three `{% if JS_ENABLED %}` guards ported from the
// source — this was the missing half: the guards existed with nothing ever
// defining the name, so every guarded block was permanently suppressed.
const JS_ENABLED = true;

export default function (eleventyConfig) {
  eleventyConfig.addGlobalData("JS_ENABLED", () => JS_ENABLED);

  // content/static/defer.js.liquid `{% include %}`s a dependency out of
  // node_modules (see that file's own comment for why it lives under
  // content/static/ rather than the source's project-root static/). Confirmed
  // empirically (not assumed): LiquidJS's Loader rejects a resolved include
  // path unless it is a descendant of one of the configured `root` entries
  // (liquidjs's fs.containsSync, via realpathSync) — this check runs
  // regardless of how many "../" segments are used or which subdirectory the
  // including template lives in. Eleventy's Liquid engine defaults `root` to
  // [dir.includes, dir.input] (Engines/Liquid.js) — neither contains
  // node_modules, because dir.input here is "content", not the project root.
  // The source's dir.input IS the project root, so node_modules is already a
  // descendant of one of its two default roots and no override was needed
  // there. Adding "." (the project root, which does contain node_modules) as
  // a third entry restores that same reachability for this one legitimate,
  // documented use — nothing else in this theme relies on relative Liquid
  // includes reaching outside _includes/content.
  eleventyConfig.setLiquidOptions({
    root: ["_includes", "content", "."],
  });

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

  // addDateParsing, and the isoInstant/humanDate filters below, all resolve
  // a page's `date` the same way — through the shared resolveDate() in
  // _11ty/dateResolver.js. They used to each hand-roll their own Date/string
  // branches; the filters' copy never grew the explicit-offset detection
  // addDateParsing did (see the task-11 coverage-gap report), so a zone-less
  // date rendered one instant on the page and a different one in the feed.
  // One function, one set of rules, called from every site this data flows
  // through.
  eleventyConfig.addDateParsing(function (dateValue) {
    return resolveDate(dateValue, this.page.inputPath, TIME_ZONE);
  });

  // _includes/types/*.liquid's `dt-published` datetime attribute used to be
  // `{{ date | date: '%Y-%m-%dT%H:%M:%SZ' }}` — that `Z` is a literal
  // strftime character, not a conversion: LiquidJS's `date` filter reads
  // hours/minutes/seconds off the JS Date in the *process's local*
  // timezone, so the attribute stamped local wall-clock time and then
  // asserted it was UTC. Emits true UTC instead, via Luxon rather than the
  // process's ambient timezone — correct regardless of what machine the
  // build runs on. Templates read the data cascade's raw `date` value
  // (addDateParsing's resolved value is never copied back onto it, only
  // onto `page.date` — see the addDateParsing comment above), which is a JS
  // Date for the common unquoted-front-matter case and a string otherwise;
  // resolveDate() handles both, and — via `this.page.inputPath`, which
  // LiquidJS filters get the same way addDateParsing's callback does — reads
  // the same front matter addDateParsing reads, so a zone-less date resolves
  // to the identical instant in both places.
  eleventyConfig.addLiquidFilter("isoInstant", function (dateValue) {
    const parsed = resolveDate(dateValue, this.page?.inputPath, TIME_ZONE);
    return parsed ? parsed.toUTC().toISO({ suppressMilliseconds: true }) : "";
  });

  // The human-readable date text next to `isoInstant`'s machine-readable
  // one (`{{ date | date: "%-d %B %Y" }}` in every _includes/types/*.liquid
  // partial) has the identical defect isoInstant was written to fix: LiquidJS's
  // `date` filter reads the JS Date's fields in the *build process's local*
  // timezone, so the same content renders a different calendar day depending
  // on where it's built. Same resolveDate() call as isoInstant above — only
  // the output format and target zone (TIME_ZONE for display, not UTC)
  // differ. Luxon's "d MMMM yyyy" is the token-for-token equivalent of
  // strftime's "%-d %B %Y" (unpadded day, full month name, 4-digit year).
  eleventyConfig.addLiquidFilter("humanDate", function (dateValue) {
    const parsed = resolveDate(dateValue, this.page?.inputPath, TIME_ZONE);
    return parsed ? parsed.setZone(TIME_ZONE).toFormat("d MMMM yyyy") : "";
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
