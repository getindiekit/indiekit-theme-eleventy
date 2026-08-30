// IndieWeb post types other than article/bookmark are titleless by design
// (a note, like, reply or photo has no headline). Atom requires atom:title
// on every feed entry (@11ty/eleventy-plugin-rss reads post.data.title
// verbatim), so a missing title ships as <title></title> in feed.xml.
//
// Give every post-type page a fallback title without inventing a fake
// headline that misrepresents a note as an article: "<Post type> · <date>".
// Only applies when a page sets `postType` (content/*/​*.11tydata.js) and has
// no literal `title` of its own — articles already have one.
//
// Bookmarks get their own fallback (the bookmarked URL) instead of the
// synthetic label, matching _includes/types/bookmark.liquid's
// `{{ title | default: bookmarkOf }}`. Computing it here too — not just
// leaving it to that template-local `default` — matters because
// @11ty/eleventy-plugin-rss reads `post.data.title` directly for the Atom
// feed's <title>, bypassing bookmark.liquid's fallback entirely; without
// this, a titleless bookmark's feed entry ships as <title></title>, the
// exact bug this fallback exists to prevent.
import siteData from "./site.json" with { type: "json" };
import { resolveDate } from "../_11ty/dateResolver.js";

// Same TIME_ZONE fallback as eleventy.config.js — see that file's comment.
const TIME_ZONE = siteData.timezone || "utc";

export default {
  title(data) {
    if (data.title || !data.postType) {
      return data.title;
    }

    const label = data.postType.charAt(0).toUpperCase() + data.postType.slice(1);

    if (data.postType === "bookmark") {
      // bookmark.liquid already falls back to bookmarkOf on its own
      // (`{{ title | default: bookmarkOf }}`) — match that here too, since
      // @11ty/eleventy-plugin-rss reads data.title directly for the Atom
      // feed and bypasses the template fallback. A bookmark with neither
      // title nor bookmarkOf has nothing to fall back to — use the same
      // synthetic label every other titleless post type gets, rather than
      // shipping the empty <title></title> this fallback exists to avoid.
      if (data.bookmarkOf) {
        return data.bookmarkOf;
      }
    }

    if (!data.date) {
      return label;
    }

    // resolveDate() is the same function addDateParsing and the
    // isoInstant/humanDate filters use — a JS Date has no zone of its own,
    // so formatting data.date with the process's local TZ (the previous
    // approach here) rendered a different calendar day depending on the
    // machine that built the site, the exact defect the rest of Task 11
    // fixed for the visible dt-published text. `data.page?.inputPath` may
    // still be unset on eleventyComputed's first dependency-resolution
    // pass (before `page` itself is computed) — resolveDate() falls back to
    // its zone-less treatment in that case, and a later pass with the real
    // inputPath supplies the correct one.
    const parsed = resolveDate(data.date, data.page?.inputPath, TIME_ZONE);
    if (!parsed) {
      return label;
    }

    const formatted = parsed.setZone(TIME_ZONE).toFormat("d MMM yyyy");
    return `${label} · ${formatted}`;
  },
};
