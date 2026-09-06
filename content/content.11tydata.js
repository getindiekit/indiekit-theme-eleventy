// One directory data file for all of content/, replacing six per-type files
// that lived inside the post directories. Those directories now hold posts
// and nothing else, so a deployment can mount a content store over each one
// (the quickstart kit does) without hiding the theme's own data.
//
// Everything is derived from the directory a file sits in. Templates that
// live directly in content/ (index.liquid, robots.liquid, …) are untouched:
// they are not in a post directory, so every value below resolves to
// undefined for them and their own front matter stands.
//
// `layout` is computed (verified on this Eleventy, 4.0.0-alpha.10: a note
// built with only this eleventyComputed.layout set still rendered inside
// layouts/entry.liquid's `<article class="h-entry">` wrapper, and its
// permalink/prev-next nav were correct) — a PLAIN literal `layout` here was
// tried first and rejected on evidence: it is directory-wide, so it also
// reaches content/_css/**/*.scss and content/static/defer.js.liquid, which
// have no front matter of their own to opt out with, and it makes Eleventy's
// dependency graph resolve entry.liquid's own read of the post collection as
// a hard, early dependency of every post page — which then cycles with
// `tags`/`postType` themselves being computed (their value is needed to
// build that collection), and it silently built empty.
//
// The one real cost of a computed `layout`: Eleventy resolves a page's
// layout chain (Template#getData(), node_modules/@11ty/eleventy/src/
// Template.js) — and merges that layout's OWN front matter, e.g.
// entry.liquid's `tmpl: page`, default.liquid's `classes.body`/`modules` —
// by reading a plain, literal `layout` key off the page's front matter or
// directory data BEFORE eleventyComputed ever runs. A computed `layout` is
// invisible to that lookup, so entry.liquid's and default.liquid's own
// front-matter data never merges in on its own. `tmpl`, `classes` and
// `modules` below are that same data, recomputed here so it still reaches
// every post page; entry.liquid and default.liquid keep declaring it too,
// since a template not reached through this directory-wide default (a
// custom layout set in a post's own front matter, say) still needs it from
// its own layout chain.
//
// KNOWN GAP: for the same reason, this file cannot declare `eleventyImport:
// { collections: ["post"] }` either (tried, and it reproduces the identical
// empty-collection cycle above) — so a post page's dependency on the post
// collection (entry.liquid's prev/next nav) is undeclared. A full build
// always resolves it correctly (proven: see test/build.mjs's "prev/next
// navigation points at the real neighbouring posts" check and this task's
// required byte-identical diff), but Eleventy's incremental engine has no
// static signal to rebuild an existing post's prev/next links when a
// *different* file changes that collection's membership or order — verified
// with a real `--incremental=<file>` build. This is the same class of
// limitation eleventy.config.js already documents and works around for the
// sitemap ("a collection cannot see pages that themselves consume
// collections"); there is no equivalent post-render bridge available here,
// because prev/next has to be in the HTML at render time, not bolted on
// after. Accepted for this refactor — flagged, not hidden — because the
// alternative (computed tags/postType so post directories can hold only
// posts) is the entire point of this file.
//
// TYPES sits on the default export rather than a second named export: a
// directory-data module with any named export alongside `default` stopped
// feeding tags into Eleventy's tag-based collections at all (verified —
// `export const TYPES` per se, or any other unrelated named export, both
// reproduced the same empty-collection break above). Read as
// `(await import(...)).default.TYPES`.
const TYPES = {
	articles: "article",
	bookmarks: "bookmark",
	likes: "like",
	notes: "note",
	photos: "photo",
	replies: "reply",
};

const dirOf = (data) => {
	const parts = (data.page.inputPath || "").split("/");
	const i = parts.indexOf("content");
	return i >= 0 && parts.length > i + 2 ? parts[i + 1] : undefined;
};

export default {
	TYPES,
	eleventyComputed: {
		postType: (data) => data.postType || TYPES[dirOf(data)],
		layout: (data) => {
			if (data.layout === false) return false;
			if (data.layout) return data.layout;
			return TYPES[dirOf(data)] ? "layouts/entry.liquid" : undefined;
		},
		// entry.liquid's own front matter — see the comment above.
		tmpl: (data) => data.tmpl || (TYPES[dirOf(data)] ? "page" : undefined),
		// default.liquid's own front matter — see the comment above.
		classes: (data) => data.classes || (TYPES[dirOf(data)] ? { body: "body-grid" } : undefined),
		modules: (data) =>
			data.modules || (TYPES[dirOf(data)] ? ["/heading-anchors.js", "/js/time-difference.js"] : undefined),
		tags: (data) => {
			const type = TYPES[dirOf(data)];
			if (!type) return data.tags;
			return [...new Set([...(data.tags || []), "post", type])];
		},
		permalink: (data) => {
			if (data.permalink) return data.permalink;
			const dir = dirOf(data);
			return TYPES[dir] ? `/${dir}/${data.page.fileSlug}/` : undefined;
		},
	},
};
