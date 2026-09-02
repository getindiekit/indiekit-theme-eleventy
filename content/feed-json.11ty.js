// JSON Feed 1.1 — https://www.jsonfeed.org/version/1.1/
//
// Written as a JS template rather than through @11ty/eleventy-plugin-rss's
// built-in `type: "json"` for one reason: that template always emits
// `"title": "{{ post.data.title }}"`, and four of Indiekit's six post types
// have no title. They would carry eleventyComputed.js's synthetic
// "<Type> · <date>" label — the same fabrication removed from p-name.
//
// The spec is explicit that this is unnecessary: `title` is OPTIONAL on an
// item, and "Microblog items in particular may omit titles". So a titleless
// post here simply has no title, and a reader renders it as the note it is.
// Atom is the opposite case (atom:title is required and must be non-empty),
// which is why the synthetic label still exists for feed.xml.
//
// A JS template also means JSON.stringify does the escaping. Hand-templating
// JSON in Liquid means hand-escaping quotes, backslashes and newlines inside
// post content, and getting that subtly wrong produces a feed that parses
// until someone writes a quotation mark.
export default class {
  data() {
    return {
      permalink: "/feed.json",
      eleventyExcludeFromCollections: true,
      eleventyImport: { collections: ["post"] },
    };
  }

  async render({ site, collections }) {
    const base = String(site.url || "").replace(/\/+$/, "");

    // `renderTransforms` is an Eleventy core filter (defaultConfig.js), and the
    // same one @11ty/eleventy-plugin-rss uses for the Atom feed. It matters:
    // post.templateContent is the PRE-transform render, so a post's image is
    // still the author's relative markdown path ("../_fixtures/sample.png") —
    // a URL that resolves nowhere in a feed reader. Running the transforms
    // yields the real <picture> output and absolutises every URL against the
    // base, exactly as feed.xml does. Hand-rolling that with a regex covered
    // src and href and would have silently missed srcset.
    const items = await Promise.all(
      [...(collections.post || [])]
        .reverse()
        .slice(0, 20)
        .map(async (post) => {
        const url = `${base}${post.url}`;
        const item = {
          id: url, // the only required item field
          url,
          content_html: await this.renderTransforms(post.content, post.data.page, `${base}/`),
        };
        // Only a real title. title_isReal is stamped from RAW front matter by
        // the "real-title" preprocessor, before the synthetic label exists.
        if (post.data.title_isReal && post.data.title) {
          item.title = post.data.title;
        }
        if (post.date) {
          item.date_published = post.date.toISOString();
        }
        if (post.data.updated) {
          const updated = new Date(post.data.updated);
          if (!Number.isNaN(updated.valueOf())) {
            item.date_modified = updated.toISOString();
          }
        }
        if (post.data.summary) {
          item.summary = post.data.summary;
        }
        if (Array.isArray(post.data.category) && post.data.category.length > 0) {
          item.tags = post.data.category;
        }
        return item;
      }),
    );

    const feed = {
      version: "https://jsonfeed.org/version/1.1",
      title: site.name,
      home_page_url: `${base}/`,
      feed_url: `${base}/feed.json`,
      description: site.description,
      language: "en",
      items,
    };

    // `authors` (array) since 1.1; the singular `author` is deprecated. Omitted
    // entirely rather than emitted empty when the theme is unconfigured.
    if (site.author && site.author.name) {
      const author = { name: site.author.name };
      if (site.author.url) author.url = site.author.url;
      if (site.author.photo) author.avatar = `${base}${site.author.photo}`;
      feed.authors = [author];
    }

    return `${JSON.stringify(feed, null, 2)}\n`;
  }
}
