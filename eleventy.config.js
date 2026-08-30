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
  const TIME_ZONE = siteData.timezone;
  eleventyConfig.addDateParsing(function (dateValue) {
    let localDate;
    if (dateValue instanceof Date) {
      // override YAML dates (js-yaml auto-parses unquoted timestamps)
      localDate = DateTime.fromJSDate(dateValue, { zone: "utc" }).setZone(TIME_ZONE, {
        keepLocalTime: true,
      });
    } else if (typeof dateValue === "string") {
      // override String dates
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
