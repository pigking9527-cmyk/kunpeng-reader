#!/usr/bin/env python3
"""Generate deterministic Kunpeng Reader assets from a pinned ECDICT CSV."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import re
from pathlib import Path


EXPECTED_COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
EXPECTED_CSV_SHA256 = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
ASCII_WORD = re.compile(r"^[A-Za-z']+$")


def clean(value: str) -> str:
    return "；".join(part.strip() for part in value.replace("\r", "\n").split("\n") if part.strip()).replace("\t", " ")


def rank(row: dict[str, str]) -> int | None:
    values: list[int] = []
    for key in ("bnc", "frq"):
        try:
            value = int(row.get(key, ""))
        except ValueError:
            continue
        if value > 0:
            values.append(value)
    return min(values) if values else None


def write_deterministic_gzip(path: Path, text: str) -> None:
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as archive:
        archive.write(text.encode("utf-8"))
    path.write_bytes(buffer.getvalue())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("src/dict"))
    args = parser.parse_args()

    digest = hashlib.sha256(args.csv.read_bytes()).hexdigest()
    if args.commit != EXPECTED_COMMIT or digest != EXPECTED_CSV_SHA256:
        raise SystemExit("ECDICT input is not the reviewed pinned source")

    dictionary: list[str] = []
    ranked: list[tuple[int, str]] = []
    seen_words: set[str] = set()
    with args.csv.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            word = row["word"].strip().lower()
            frequency = rank(row)
            if frequency is None or not ASCII_WORD.fullmatch(word) or word in seen_words:
                continue
            translation = clean(row.get("translation", ""))
            if not translation:
                continue
            seen_words.add(word)
            dictionary.append(
                "\t".join(
                    (
                        word,
                        clean(row.get("phonetic", "")),
                        translation,
                        clean(row.get("definition", "")),
                    )
                )
            )
            ranked.append((frequency, word))

    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_deterministic_gzip(args.output_dir / "english.tsv.gz", "\n".join(dictionary) + "\n")
    top_words = [word for _, word in sorted(ranked, key=lambda item: (item[0], item[1]))[:10_000]]
    (args.output_dir / "frequent_en_10000.txt").write_text("\n".join(top_words) + "\n", encoding="utf-8")
    print(f"generated {len(dictionary)} dictionary rows and {len(top_words)} ranked words")


if __name__ == "__main__":
    main()
