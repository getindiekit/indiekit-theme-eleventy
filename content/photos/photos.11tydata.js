export default {
  // layouts/entry.liquid reads collections.post for its prev/next nav.
  eleventyImport: { collections: ["post"] },
  layout: "layouts/entry.liquid",
  postType: "photo",
  tags: ["post", "photo"],
  permalink: ({ page }) => `/photos/${page.fileSlug}/`,
};
