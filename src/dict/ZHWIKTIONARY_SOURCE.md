# Chinese Wiktionary Chinese-Chinese asset

`zh_zh.tsv.gz` is generated from the pinned Kaikki machine-readable export of
the Chinese Wiktionary Chinese-language dictionary below.

- Kaikki dictionary page: https://kaikki.org/zhwiktionary/%E6%BC%A2%E8%AA%9E/index.html
- Upstream project: Chinese Wiktionary, extracted with wiktextract by Kaikki
- Kaikki extraction date: `2026-08-11`
- Wikimedia dump date: `2026-08-04`
- Source JSONL URL: `https://kaikki.org/zhwiktionary/%E6%BC%A2%E8%AA%9E/kaikki.org-dictionary-%E6%BC%A2%E8%AA%9E.jsonl`
- Source JSONL SHA-256: `fae3693964a76e0560bf1c6a269fcd66402f78056df298ae6b6233b2b620888e`
- License selected for this distribution: Creative Commons Attribution-ShareAlike 4.0 International
- License text: `LICENSES/CC-BY-SA-4.0.txt`
- Generator: `tools/generate_zhwiktionary_asset.py`

The deterministic generator retains only lookup headwords, Mandarin pinyin,
and Chinese gloss text; resolves explicit simplified/traditional redirects;
bounds the number and length of glosses; and writes a sorted gzip stream with
a fixed timestamp. The application converts returned gloss text to simplified
Chinese for its simplified-Chinese interface. These are adapted materials and
remain available under CC BY-SA 4.0; the root Kunpeng Reader license does not
replace or restrict those rights.
