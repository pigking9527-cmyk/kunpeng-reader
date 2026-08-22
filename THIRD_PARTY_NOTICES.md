# Third-Party Notices

This file lists third-party material distributed in, or used to produce, Kunpeng Reader. First-party code remains governed by the root `LICENSE`.

## PDF.js

- Component: Mozilla PDF.js 4.7.76 (`ui/pdfjs/`)
- License: Apache License 2.0
- Copyright and license notices remain in the distributed JavaScript files.
- Full license: `LICENSES/Apache-2.0.txt`
- Source: https://github.com/mozilla/pdf.js

## rbook

- Component: rbook 0.7.10, used for EPUB 2/3 parsing
- License: Apache License 2.0
- Full license: `LICENSES/Apache-2.0.txt`
- Source: https://github.com/DevinSterling/rbook

## ECDICT data

- Distributed artifacts: `src/dict/english.tsv.gz`, `src/dict/frequent_en_10000.txt`
- Project: ECDICT, pinned to the reviewed source commit and source hash
- License: MIT
- Full license: `LICENSES/ECDICT-MIT.txt`
- Source and deterministic regeneration details: `src/dict/ECDICT_SOURCE.md`

## CC-CEDICT data

- Distributed artifact: `src/dict/zh_word.tsv.gz`
- Publisher: MDBG; source archive is pinned by publication timestamp and SHA-256
- License: Creative Commons Attribution-ShareAlike 4.0 International
- Full license: `LICENSES/CC-BY-SA-4.0.txt`
- Source, attribution, modification notice and deterministic regeneration details: `src/dict/CC_CEDICT_SOURCE.md`

The former converted MOE/Moedict Chinese-Chinese dictionary and OpenHowNet
core-data export are not distributed in the remediated release candidate.

## Chinese Wiktionary data

- Distributed artifact: `src/dict/zh_zh.tsv.gz`
- Project: Chinese Wiktionary, extracted by Kaikki/wiktextract from a pinned Wikimedia dump
- License selected for distribution: Creative Commons Attribution-ShareAlike 4.0 International
- Full license: `LICENSES/CC-BY-SA-4.0.txt`
- Source snapshot, attribution, transformation notice and deterministic regeneration details: `src/dict/ZHWIKTIONARY_SOURCE.md`

The generated Chinese-Chinese lookup asset and its extraction changes remain
available under CC BY-SA 4.0. The former converted MOE/Moedict dictionary and
OpenHowNet core-data export remain excluded.

## Rust and npm dependencies

The application is built from the exact dependencies in `Cargo.lock` and `package-lock.json`. CI verifies every declared license against `scripts/license-policy.json`, rejects GPL-family runtime dependencies and unknown license metadata, and generates `target/license-audit/DEPENDENCY_LICENSES.md` for each release build.

## Platform runtime libraries

ONNX Runtime is used by the semantic-search implementation under its MIT
license. Automatic packaging or download of NVIDIA CUDA/cuDNN runtime files is
disabled in the remediated release candidate pending a separate redistribution
review.
