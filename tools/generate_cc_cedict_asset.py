#!/usr/bin/env python3
"""Generate the bundled Chinese-English dictionary from a pinned CC-CEDICT ZIP."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import re
import zipfile
from pathlib import Path


EXPECTED_ZIP_SHA256 = "076bfeda3b32d325b82bb056f6c628001be9bdd2e5eeb5955f479a85984f2479"
ENTRY = re.compile(r"^(\S+) (\S+) \[([^]]*)\] /(.+)/$")


def write_deterministic_gzip(path: Path, text: str) -> None:
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as archive:
        archive.write(text.encode("utf-8"))
    path.write_bytes(buffer.getvalue())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, default=Path("src/dict/zh_word.tsv.gz"))
    args = parser.parse_args()

    digest = hashlib.sha256(args.archive.read_bytes()).hexdigest()
    if digest != EXPECTED_ZIP_SHA256:
        raise SystemExit("CC-CEDICT input is not the reviewed pinned source")

    rows: dict[str, tuple[str, str]] = {}
    with zipfile.ZipFile(args.archive) as source:
        names = source.namelist()
        if names != ["cedict_ts.u8"]:
            raise SystemExit("unexpected CC-CEDICT archive layout")
        for line in source.read(names[0]).decode("utf-8").splitlines():
            if not line or line.startswith("#"):
                continue
            match = ENTRY.match(line)
            if not match:
                raise SystemExit(f"unrecognized CC-CEDICT row: {line[:120]}")
            traditional, simplified, pinyin, definitions = match.groups()
            definition = "; ".join(part.strip() for part in definitions.split("/") if part.strip())
            for word in (simplified, traditional):
                rows.setdefault(word, (pinyin, definition))

    output = "\n".join(f"{word}\t{pinyin}\t{definition}" for word, (pinyin, definition) in rows.items()) + "\n"
    write_deterministic_gzip(args.output, output)
    print(f"generated {len(rows)} CC-CEDICT lookup keys")


if __name__ == "__main__":
    main()
