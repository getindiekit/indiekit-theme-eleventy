export default {
  layout: "layouts/entry.liquid",
  postType: "reply",
  tags: ["post", "reply"],
  permalink: ({ page }) => `/replies/${page.fileSlug}/`,
};
