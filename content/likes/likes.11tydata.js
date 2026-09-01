export default {
  // layouts/entry.liquid reads collections.post for its prev/next nav.
  eleventyImport: { collections: ["post"] },
  layout: "layouts/entry.liquid",
  postType: "like",
  tags: ["post", "like"],
  permalink: ({ page }) => `/likes/${page.fileSlug}/`,
};
