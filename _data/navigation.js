// The rail menu's page entries: site.json's `navigation`, resolved against
// the pages Indiekit has written to content/pages/. Global data rather than a
// collection on purpose: every page reads the menu through its layout, and a
// template that consumes a collection cannot be a member of it, so a
// collection-based menu could never contain the pages it lists.
//
// Nothing is listed unless the operator lists it. A page that exists and is
// not listed is named once per build so the choice is visible either way.
import { globSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadSiteConfig } from "../_11ty/siteConfig.js";

// Indiekit writes front matter through a YAML serialiser, which quotes a title
// only when it has to; the one key read here is `title`, so a line match with
// the optional quotes stripped covers what it writes.
const titleOf = (markdown) => {
	const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
	const raw = /^title:[ \t]*(.+?)[ \t]*$/m.exec(head)?.[1];
	return raw?.replace(/^(['"])(.*)\1$/, "$2");
};
const isDraft = (markdown) => /^draft:[ \t]*(?!false\b)\S/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "");

export default function navigation() {
	const site = loadSiteConfig();
	const pages = new Map();
	for (const file of globSync("content/pages/*.md").sort()) {
		const slug = basename(file, ".md");
		// Same rule as eleventy.config.js: sample pages are not built on a live site.
		if (process.env.THEME_SAMPLE_POSTS === "0" && slug.startsWith("fixture-")) continue;
		const markdown = readFileSync(file, "utf8");
		pages.set(`/${slug}/`, { url: `/${slug}/`, title: titleOf(markdown) || slug, draft: isDraft(markdown), file });
	}

	const items = site.navigation.map((path) => {
		const page = pages.get(path);
		if (!page) {
			throw new Error(`site.json navigation: ${path} is not a page (no content/pages/${path.replaceAll("/", "")}.md); create the page first, or remove it from the list`);
		}
		if (page.draft && process.env.ELEVENTY_RUN_MODE === "build") {
			throw new Error(`site.json navigation: ${path} is a draft (${page.file}) and will not be built; publish it or remove it from the list`);
		}
		return page;
	});

	const unlisted = [...pages.values()].filter((p) => !site.navigation.includes(p.url) && !p.draft);
	if (unlisted.length > 0) {
		console.log(`[navigation] built but not in the menu: ${unlisted.map((p) => p.url).join(", ")} (list a page under "navigation" in site.json to add it)`);
	}
	return items;
}
