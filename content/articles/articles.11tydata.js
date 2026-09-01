export default {
  // layouts/entry.liquid reads collections.post for its prev/next nav.
  eleventyImport: { collections: ["post"] },
  layout: "layouts/entry.liquid",
  postType: "article",
  tags: ["post", "article"],
  permalink: ({ page }) => `/articles/${page.fileSlug}/`,
};
