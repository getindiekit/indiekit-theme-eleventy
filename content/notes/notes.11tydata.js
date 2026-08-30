export default {
  layout: "layouts/entry.liquid",
  postType: "note",
  tags: ["post", "note"],
  permalink: ({ page }) => `/notes/${page.fileSlug}/`,
};
