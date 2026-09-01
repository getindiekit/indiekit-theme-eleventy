export default {
  // layouts/entry.liquid reads collections.post for its prev/next nav.
  eleventyImport: { collections: ["post"] },
  layout: "layouts/entry.liquid",
  postType: "note",
  tags: ["post", "note"],
  permalink: ({ page }) => `/notes/${page.fileSlug}/`,
};
