import argparse
import gzip
import pickletools
import re
import zipfile


MARK = object()


def safe_pickle_load(file_obj):
    """Parse the OpenHowNet pickle subset without executing pickle globals."""
    stack = []
    memo = {}
    for op, arg, _pos in pickletools.genops(file_obj):
        name = op.name
        if name in ("PROTO", "FRAME"):
            continue
        if name == "EMPTY_DICT":
            stack.append({})
        elif name == "MARK":
            stack.append(MARK)
        elif name in ("SHORT_BINUNICODE", "BINUNICODE"):
            stack.append(arg)
        elif name == "BINFLOAT":
            stack.append(arg)
        elif name == "MEMOIZE":
            memo[len(memo)] = stack[-1]
        elif name in ("BINGET", "LONG_BINGET"):
            stack.append(memo[arg])
        elif name == "SETITEMS":
            mark = len(stack) - 1
            while mark >= 0 and stack[mark] is not MARK:
                mark -= 1
            if mark <= 0 or not isinstance(stack[mark - 1], dict):
                raise ValueError("invalid SETITEMS layout")
            target = stack[mark - 1]
            items = stack[mark + 1 :]
            if len(items) % 2:
                raise ValueError("odd SETITEMS payload")
            for i in range(0, len(items), 2):
                target[items[i]] = items[i + 1]
            del stack[mark:]
        elif name == "STOP":
            if len(stack) != 1:
                raise ValueError(f"unexpected stack size at STOP: {len(stack)}")
            return stack[0]
        else:
            raise ValueError(f"unsupported pickle opcode: {name}")
    raise ValueError("pickle stream ended without STOP")


SEMEME_RE = re.compile(r"([A-Za-z][A-Za-z0-9_ -]*\|[\u4e00-\u9fffA-Za-z0-9_ -]+)")


def clean(value):
    return str(value or "").replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()


def sememes_from_def(def_text):
    out = []
    for item in SEMEME_RE.findall(def_text or ""):
        item = clean(item.replace(" ", "_"))
        if item and item not in out:
            out.append(item)
    return out


def sense_field(item, *names):
    for name in names:
        if isinstance(item, dict) and name in item:
            return item.get(name)
    return ""


def export(zip_path, out_path):
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open("HowNet_dict_complete") as f:
            senses = safe_pickle_load(f)
        relations = zf.read("sememe_triples_taxonomy.txt").decode("utf-8", "ignore")

    with gzip.open(out_path, "wt", encoding="utf-8", newline="\n") as out:
        out.write("# kind\tword\tpos\tdef\texamples\tsememes\n")
        for item in senses.values():
            zh = clean(sense_field(item, "ch_word", "zh_word", "W_C"))
            if not zh:
                continue
            pos = clean(sense_field(item, "ch_grammar", "zh_grammar", "G_C"))
            definition = clean(sense_field(item, "Def", "DEF"))
            examples = clean(sense_field(item, "ch_example", "zh_example", "E_C"))
            sememes = ",".join(sememes_from_def(definition))
            out.write(f"S\t{zh}\t{pos}\t{definition}\t{examples}\t{sememes}\n")

        out.write("# kind\thead\trelation\ttail\n")
        for line in relations.splitlines():
            parts = [clean(p) for p in line.split()]
            if len(parts) >= 3 and parts[0] and parts[1] and parts[2]:
                out.write(f"R\t{parts[0]}\t{parts[1]}\t{parts[2]}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zip_path")
    ap.add_argument("out_path")
    args = ap.parse_args()
    export(args.zip_path, args.out_path)


if __name__ == "__main__":
    main()
