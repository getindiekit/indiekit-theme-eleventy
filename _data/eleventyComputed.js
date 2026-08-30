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
export default {
  title(data) {
    if (data.title || !data.postType) {
      return data.title;
    }

    if (data.postType === "bookmark") {
      return data.bookmarkOf;
    }

    const label = data.postType.charAt(0).toUpperCase() + data.postType.slice(1);
    if (!data.date) {
      return label;
    }

    const formatted = new Date(data.date).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    return `${label} · ${formatted}`;
  },
};
