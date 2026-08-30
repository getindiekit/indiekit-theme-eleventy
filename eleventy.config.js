import pluginSass from "./_11ty/sassPlugin.js";
import pluginSyntaxHighlight from "./_11ty/syntaxHighlightPlugin.js";
import pluginImage from "./_11ty/imagePlugin.js";
import pluginImageAvatar from "./_11ty/imageAvatarPlugin.js";
import pluginWebmentions from "./_11ty/webmentionsPlugin.js";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(pluginSass);
  eleventyConfig.addPlugin(pluginSyntaxHighlight);
  eleventyConfig.addPlugin(pluginImage);
  eleventyConfig.addPlugin(pluginImageAvatar);
  eleventyConfig.addPlugin(pluginWebmentions);

  return {
    dir: {
      input: "content",
      output: "_site",
      includes: "../_includes",
      data: "../_data",
    },
    markdownTemplateEngine: "liquid",
    htmlTemplateEngine: "liquid",
  };
}
