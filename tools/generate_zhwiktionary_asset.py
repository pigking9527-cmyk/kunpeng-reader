#!/usr/bin/env python3
"""Generate the bundled Chinese-Chinese dictionary from a pinned Kaikki JSONL export."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
from pathlib import Path


EXPECTED_JSONL_SHA256 = "fae3693964a76e0560bf1c6a269fcd66402f78056df298ae6b6233b2b620888e"
MAX_GLOSSES_PER_WORD = 12
MAX_DEFINITION_CHARS = 1800
REDIRECT_MARKERS = ("請見「", "请见“", "請見“", "请见「")
REDIRECT_TARGET = re.compile(r"[請请]見[「“]([^」”]+)[」”]")


def write_deterministic_gzip(path: Path, text: str) -> None:
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as archive:
        archive.write(text.encode("utf-8"))
    path.write_bytes(buffer.getvalue())


def clean_text(value: object) -> str:
    return " ".join(str(value or "").replace("\t", " ").replace("\n", " ").split())


def mandarin_pinyin(entry: dict[str, object]) -> str:
    for sound in entry.get("sounds", []):
        if not isinstance(sound, dict):
            continue
        tags = set(sound.get("tags", []))
        pronunciation = clean_text(sound.get("zh_pron"))
        if pronunciation and "Mandarin" in tags and "Pinyin" in tags:
            return pronunciation
    return ""


def chinese_forms(entry: dict[str, object]) -> list[str]:
    forms = [clean_text(entry.get("word"))]
    for form in entry.get("forms", []):
        if not isinstance(form, dict):
            continue
        tags = set(form.get("tags", []))
        value = clean_text(form.get("form"))
        if value and ({"Simplified-Chinese", "Traditional-Chinese"} & tags):
            forms.append(value)
    return list(dict.fromkeys(form for form in forms if form and not any(c.isspace() for c in form)))


def chinese_glosses(entry: dict[str, object]) -> list[str]:
    glosses: list[str] = []
    for sense in entry.get("senses", []):
        if not isinstance(sense, dict):
            continue
        for gloss in sense.get("glosses", []):
            value = clean_text(gloss)
            if value and not any(marker in value for marker in REDIRECT_MARKERS) and value not in glosses:
                glosses.append(value)
                if len(glosses) >= MAX_GLOSSES_PER_WORD:
                    return glosses
    return glosses


def redirect_target(entry: dict[str, object]) -> str:
    for sense in entry.get("senses", []):
        if not isinstance(sense, dict):
            continue
        for gloss in sense.get("glosses", []):
            match = REDIRECT_TARGET.search(clean_text(gloss))
            if match:
                return clean_text(match.group(1))
    return ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("jsonl", type=Path)
    parser.add_argument("--output", type=Path, default=Path("src/dict/zh_zh.tsv.gz"))
    args = parser.parse_args()

    digest = hashlib.sha256(args.jsonl.read_bytes()).hexdigest()
    if digest != EXPECTED_JSONL_SHA256:
        raise SystemExit("Chinese Wiktionary input is not the reviewed pinned source")

    rows: dict[str, tuple[str, list[str]]] = {}
    redirects: dict[str, str] = {}
    with args.jsonl.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"invalid JSONL row {line_number}: {error}") from error
            glosses = chinese_glosses(entry)
            target = redirect_target(entry)
            forms = chinese_forms(entry)
            if not glosses and target:
                for word in forms:
                    redirects.setdefault(word, target)
                continue
            if not glosses:
                continue
            pinyin = mandarin_pinyin(entry)
            for word in forms:
                known_pinyin, known_glosses = rows.setdefault(word, (pinyin, []))
                if not known_pinyin and pinyin:
                    known_pinyin = pinyin
                for gloss in glosses:
                    if gloss not in known_glosses:
                        known_glosses.append(gloss)
                rows[word] = (known_pinyin, known_glosses)

    for word, target in redirects.items():
        if word in rows or target not in rows:
            continue
        pinyin, glosses = rows[target]
        rows[word] = (pinyin, list(glosses))

    output_rows = []
    for word in sorted(rows):
        pinyin, glosses = rows[word]
        definition = "; ".join(glosses)[:MAX_DEFINITION_CHARS].rstrip()
        if definition:
            output_rows.append(f"{word}\t{pinyin}\t{definition}")
    write_deterministic_gzip(args.output, "\n".join(output_rows) + "\n")
    print(f"generated {len(output_rows)} Chinese Wiktionary lookup keys")


if __name__ == "__main__":
    main()
