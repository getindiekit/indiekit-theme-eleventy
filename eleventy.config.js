import { readFileSync } from "node:fs";
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
