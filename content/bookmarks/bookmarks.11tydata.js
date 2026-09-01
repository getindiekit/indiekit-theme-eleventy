export default {
  // layouts/entry.liquid reads collections.post for its prev/next nav.
  eleventyImport: { collections: ["post"] },
  layout: "layouts/entry.liquid",
  postType: "bookmark",
  tags: ["post", "bookmark"],
  permalink: ({ page }) => `/bookmarks/${page.fileSlug}/`,
};
