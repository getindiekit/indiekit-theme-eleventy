export default {
  // layouts/entry.liquid reads collections.post for its prev/next nav.
  eleventyImport: { collections: ["post"] },
  layout: "layouts/entry.liquid",
  postType: "reply",
  tags: ["post", "reply"],
  permalink: ({ page }) => `/replies/${page.fileSlug}/`,
};
