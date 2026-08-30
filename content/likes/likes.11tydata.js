export default {
  layout: "layouts/entry.liquid",
  postType: "like",
  tags: ["post", "like"],
  permalink: ({ page }) => `/likes/${page.fileSlug}/`,
};
