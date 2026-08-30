export default {
  layout: "layouts/entry.liquid",
  postType: "bookmark",
  tags: ["post", "bookmark"],
  permalink: ({ page }) => `/bookmarks/${page.fileSlug}/`,
};
