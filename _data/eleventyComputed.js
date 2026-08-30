// IndieWeb post types other than article/bookmark are titleless by design
// (a note, like, reply or photo has no headline). Atom requires atom:title
// on every feed entry (@11ty/eleventy-plugin-rss reads post.data.title
// verbatim), so a missing title ships as <title></title> in feed.xml.
//
// Give every post-type page a fallback title without inventing a fake
// headline that misrepresents a note as an article: "<Post type> · <date>".
// Only applies when a page sets `postType` (content/*/​*.11tydata.js) and has
// no literal `title` of its own — articles and bookmarks already have one.
export default {
  title(data) {
    if (data.title || !data.postType) {
      return data.title;
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
