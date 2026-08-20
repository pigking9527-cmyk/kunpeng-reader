# ECDICT-derived English assets

`english.tsv.gz` and `frequent_en_10000.txt` are generated only from the
reviewed ECDICT source below. They no longer contain rankings derived from
`wordfreq`.

- Upstream: https://github.com/skywind3000/ECDICT
- Pinned commit: `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`
- Source file: `ecdict.csv`
- Source SHA-256: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`
- License: MIT; full text in `LICENSES/ECDICT-MIT.txt`
- Generator: `tools/generate_ecdict_assets.py`

The generator keeps entries with an ECDICT BNC or COCA frequency rank and an
English-to-Chinese translation, normalizes embedded newlines, and writes a
deterministic gzip dictionary. The speech-pack list contains the 10,000
lowest-ranked distinct words, ordered by the minimum available ECDICT rank.
