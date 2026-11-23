---
title: How search works in Brain
tags: [brain, search]
---
# Search in Brain

Full-text search with SQLite FTS5. Words are stemmed by Snowball for Russian and English, ranking is BM25 with
weights for title, tags, path, headings and body.
