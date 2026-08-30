export default {
  layout: "layouts/entry.liquid",
  postType: "photo",
  tags: ["post", "photo"],
  permalink: ({ page }) => `/photos/${page.fileSlug}/`,
};
