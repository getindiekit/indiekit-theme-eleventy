// IndieWeb post types other than article/bookmark are titleless by design
// (a note, like, reply or photo has no headline). Atom requires atom:title
// on every feed entry (@11ty/eleventy-plugin-rss reads post.data.title
// verbatim), so a missing title ships as <title></title> in feed.xml.
//
// Give every post-type page a fallback title without inventing a fake
// headline that misrepresents a note as an article: "<Post type> · <date>".
// Only applies when a page sets `postType` (content/content.11tydata.js) and has
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
import { loadSiteConfig } from "../_11ty/siteConfig.js";

const siteData = loadSiteConfig();
import { resolveDate } from "../_11ty/dateResolver.js";

// Same TIME_ZONE fallback as eleventy.config.js — see that file's comment.
const TIME_ZONE = siteData.timezone || "utc";

// "<Type> · <date>" labels are the post type capitalised, except where that
// reads wrong.
const LABELS = { rsvp: "RSVP" };

// An event's `start`/`end` are unquoted timestamps, so js-yaml hands over
// JS Dates exactly as it does for `date`; resolveDate re-reads the front-matter
// line to keep an explicit offset. Returns a zone-aware ISO string or undefined.
const eventTime = (data, key) => {
  const parsed = resolveDate(data[key], data.page?.inputPath, TIME_ZONE, key);
  return parsed ? parsed.setZone(TIME_ZONE) : undefined;
};

export default {
  // An event's start and end as zone-aware ISO strings (templates feed them
  // to isoInstant) and as display text with the time of day.
  eventStart: (data) => eventTime(data, "start")?.toISO(),
  eventEnd: (data) => eventTime(data, "end")?.toISO(),
  eventStartText: (data) => eventTime(data, "start")?.toFormat("d MMMM yyyy, HH:mm"),
  eventEndText: (data) => eventTime(data, "end")?.toFormat("d MMMM yyyy, HH:mm"),

  // Computed data is the only tier that outranks a `_data/*` global, so this
  // is what makes SITE_FIXTURE visible to templates at all. With no fixture
  // set, loadSiteConfig() returns _data/site.json verbatim and this is a
  // no-op. See _11ty/siteConfig.js.
  site() {
    return siteData;
  },

  // schema.org JSON-LD, per post type.
  //
  // Built here rather than in a template because eleventyComputed has the whole
  // data cascade and, crucially, because the value is serialised with
  // JSON.stringify by the `jsonLdScript` filter — hand-templating JSON in Liquid
  // means hand-escaping quotes, backslashes and newlines inside post content,
  // which produces a document that parses until someone writes a quotation mark.
  //
  // ONE TYPE PER POST TYPE, and no invented headlines. schema.org does not
  // require `headline` (verified against schema.org/SocialMediaPosting), so the
  // four titleless Indiekit types simply have none — reusing the synthetic
  // "<Type> · <date>" label here would reintroduce, in a third representation,
  // exactly the fabrication removed from p-name and from the JSON Feed.
  //
  //   article               -> Article            (real headline)
  //   note                  -> SocialMediaPosting
  //   reply/like/bookmark   -> SocialMediaPosting + sharedContent (the target)
  //   photo                 -> ImageObject        (caption + contentUrl)
  //
  // SocialMediaPosting is Thing > CreativeWork > Article > SocialMediaPosting,
  // so it inherits articleBody, datePublished, dateModified, author and
  // keywords. sharedContent expects a CreativeWork, which is what a reply,
  // like or bookmark target is.
  jsonLdData(data) {
    // Eleventy's automatic dependency detection for computed data (a trial
    // run with placeholder values — @11ty/eleventy/src/Data/
    // ComputedDataProxy.js) walks this function once to see which keys it
    // reads, so it can order `title` (also computed, below) before this one.
    // With `postType` now itself computed (content/content.11tydata.js),
    // that trial run's placeholder makes `!data.postType` true, and the
    // function returns before ever reaching `data.title` — hiding the
    // dependency, so `title` could run after this and headline would use
    // its raw (often absent) value instead of the resolved one. Touching it
    // unconditionally, before the guard, keeps it visible regardless.
    void data.title;
    if (!data.postType) {
      return null;
    }

    const base = String(siteData.url || "").replace(/\/+$/, "");
    const url = `${base}${data.page.url}`;
    const published = resolveDate(data.date, data.page.inputPath, TIME_ZONE);

    const TYPES = {
      article: "Article",
      note: "SocialMediaPosting",
      reply: "SocialMediaPosting",
      like: "SocialMediaPosting",
      bookmark: "SocialMediaPosting",
      photo: "ImageObject",
      audio: "SocialMediaPosting",
      video: "SocialMediaPosting",
      jam: "SocialMediaPosting",
      repost: "SocialMediaPosting",
      rsvp: "SocialMediaPosting",
      event: "Event",
    };

    const ld = {
      "@context": "https://schema.org",
      "@type": TYPES[data.postType] || "SocialMediaPosting",
      "@id": url,
      url,
    };

    if (published) {
      ld.datePublished = published.setZone(TIME_ZONE).toISO();
    }
    if (data.updated) {
      const updated = resolveDate(data.updated, data.page.inputPath, TIME_ZONE);
      if (updated) ld.dateModified = updated.setZone(TIME_ZONE).toISO();
    }
    // Only a real one. title_isReal is stamped from RAW front matter before the
    // synthetic label exists.
    if (data.title_isReal && data.title) {
      ld.headline = data.title;
    }
    if (data.summary) {
      ld.description = data.summary;
    }
    if (Array.isArray(data.category) && data.category.length > 0) {
      ld.keywords = data.category;
    }
    if (siteData.author && siteData.author.name) {
      ld.author = { "@type": "Person", name: siteData.author.name };
      if (siteData.author.url) ld.author.url = siteData.author.url;
    }

    // What this post is a response to.
    const target = data.inReplyTo || data.likeOf || data.bookmarkOf || data.repostOf || data.jamOf;
    if (target) {
      const targetUrl = typeof target === "string" ? target : target.url;
      if (targetUrl) {
        ld.sharedContent = { "@type": "CreativeWork", url: targetUrl };
      }
    }

    if (data.postType === "event") {
      const start = eventTime(data, "start");
      const end = eventTime(data, "end");
      if (start) ld.startDate = start.toISO();
      if (end) ld.endDate = end.toISO();
      if (data.location) ld.location = { "@type": "Place", name: String(data.location) };
    }

    if (data.postType === "photo" && Array.isArray(data.photo) && data.photo[0]) {
      const first = data.photo[0];
      if (first.url) ld.contentUrl = first.url.startsWith("http") ? first.url : `${base}${first.url}`;
      if (first.alt) ld.caption = first.alt;
    }

    return ld;
  },

  title(data) {
    if (data.title || !data.postType) {
      return data.title;
    }

    const label = LABELS[data.postType] || data.postType.charAt(0).toUpperCase() + data.postType.slice(1);

    // A draft only renders under --serve (eleventy.config.js drops drafts on
    // build). There the source marks it by appending " (Draft)" to data.title —
    // but four of the six Indiekit post types are titleless by design, so that
    // guard skips them and a titleless draft would render with no indication it
    // is one. Fold the marker into the synthetic title instead, so every draft
    // is visibly a draft in the one mode that shows them.
    const draftSuffix = data.draft ? " (Draft)" : "";

    if (data.postType === "bookmark") {
      // bookmark.liquid already falls back to bookmarkOf on its own
      // (`{{ title | default: bookmarkOf }}`) — match that here too, since
      // @11ty/eleventy-plugin-rss reads data.title directly for the Atom
      // feed and bypasses the template fallback. A bookmark with neither
      // title nor bookmarkOf has nothing to fall back to — use the same
      // synthetic label every other titleless post type gets, rather than
      // shipping the empty <title></title> this fallback exists to avoid.
      if (data.bookmarkOf) {
        return data.bookmarkOf + draftSuffix;
      }
    }

    if (!data.date) {
      return label + draftSuffix;
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
      return label + draftSuffix;
    }

    const formatted = parsed.setZone(TIME_ZONE).toFormat("d MMM yyyy");
    return `${label} · ${formatted}${draftSuffix}`;
  },
};
