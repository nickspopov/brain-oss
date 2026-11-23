# Search quality corpus

Synthetic test data for `test/search/quality.test.ts`. Every document here is invented: the notes, recipes,
runbooks, agents and projects do not describe a real installation or real people. The text is mostly Russian
(with some English) on purpose, to exercise the Russian and English Snowball stemming in full-text search:
`test/search/questions.yaml` asks questions in word forms that differ from the ones in the documents.

This file is not part of the corpus; the test skips it.
