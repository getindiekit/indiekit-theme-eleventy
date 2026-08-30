export default {
  layout: "layouts/entry.liquid",
  postType: "article",
  tags: ["post", "article"],
  permalink: ({ page }) => `/articles/${page.fileSlug}/`,
};
