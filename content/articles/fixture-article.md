---
date: 2026-08-30T10:00:00.000Z
title: Publishing to your own site first
---

The IndieWeb idea is simple enough to state in a sentence: publish on your own
site, then syndicate elsewhere. The part that takes work is everything
underneath — a permalink you control, markup other sites can read, and a way to
receive replies without handing the conversation to someone else.

## Why the markup matters

A post is only as portable as the structure around it. Microformats2 gives
readers, search tools and webmention receivers a shared vocabulary, without
asking you to adopt anyone else's platform.

![A long exposure of the coast at dusk, the horizon banded blue to gold](../_fixtures/sample.png)

Images in post bodies go through Eleventy's image transform, which generates
responsive `avif` and `jpeg` variants at several widths and emits a `<picture>`
element. Images that Indiekit's media store writes — a photo post's own
`u-photo` — keep the URL Indiekit gave them instead.
