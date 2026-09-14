#!/usr/bin/env bash
# Mutation campaign over the three contract sources. See test/MUTATION.md for the last result.
#
#   SOLC=/path/to/solc-0.8.28 WORKERS=4 bash test/mutation/run.sh <outdir> [git-rev-for-tests]
#
# gambit writes every mutant of src/UtuhRegistry.sol, src/UtuhCredit.sol and src/lib/EventScope.sol.
# Each mutant is copied over its original in a scratch copy of the repo under <outdir> and the
# whole forge suite runs against it with a fixed fuzz seed. A failing suite kills the mutant.
# Nothing is ever written to this repository's own src/ — the deployed contracts are verified
# from those exact bytes.
#
# The optional second argument takes test/ from a git revision instead of the working tree, which
# is how the "before" score was measured against the suite as it stood.
#
# Output: <outdir>/results.tsv — mutant, line, status (killed|survived|stillborn), description.
set -euo pipefail

out="${1:?usage: run.sh <outdir> [git-rev-for-tests]}"
rev="${2:-}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
workers="${WORKERS:-4}"
solc="${SOLC:-solc}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

base="$out/base"
rm -rf "$base" "$out"/w* "$out/gambit" "$out"/results*.tsv
mkdir -p "$base/lib" "$base/node_modules"
cp -r "$repo/src" "$repo/foundry.toml" "$repo/remappings.txt" "$repo/foundry.lock" "$base/"
cp -r "$repo/lib/forge-std" "$base/lib/"
cp -r "$repo/node_modules/@gluwa" "$base/node_modules/"
if [ -n "$rev" ]; then
  git -C "$repo" archive "$rev" test | tar -x -C "$base"
else
  cp -r "$repo/test" "$base/"
fi

cd "$base"
for f in src/UtuhRegistry.sol src/UtuhCredit.sol src/lib/EventScope.sol; do
  name="$(basename "$f" .sol)"
  gambit mutate --filename "$f" --solc "$solc" \
    --solc_remappings "@gluwa/usc-contracts/=node_modules/@gluwa/usc-contracts/" \
    --outdir "$out/gambit/$name" | tail -1
done

# One line per mutant: id, mutated file, original path, line, description.
node -e '
  const fs = require("fs"), path = require("path"), root = process.argv[1];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    for (const m of JSON.parse(fs.readFileSync(path.join(dir, "gambit_results.json"), "utf8"))) {
      // The hunk header names its first context line; walk to the first removed line.
      const lines = m.diff.split("\n");
      const at = lines.findIndex((l) => l.startsWith("@@"));
      let line = +(lines[at].match(/@@ -(\d+)/) || [, 0])[1];
      for (const l of lines.slice(at + 1)) {
        if (l.startsWith("-")) break;
        if (!l.startsWith("+")) line++;
      }
      console.log([name + "-" + m.id, path.join(dir, m.name), m.original, line, m.description].join("\t"));
    }
  }' "$out/gambit" > "$out/mutants.tsv"
total=$(wc -l < "$out/mutants.tsv")
echo "$total mutants, $workers workers"

forge build > /dev/null

work() {
  local k="$1" w="$out/w$1"
  cp -r "$base" "$w"
  cd "$w"
  awk -F'\t' -v k="$k" -v n="$workers" 'NR % n == k' "$out/mutants.tsv" |
    while IFS=$'\t' read -r id file orig line desc; do
      cp "$file" "$orig"
      if ! forge build > "$w/build.log" 2>&1; then
        status=stillborn
      elif timeout 900 forge test --fail-fast --fuzz-seed 0x1 > "$w/test.log" 2>&1; then
        status=survived
      else
        status=killed
      fi
      cp "$base/$orig" "$orig"
      printf '%s\t%s:%s\t%s\t%s\n' "$id" "$orig" "$line" "$status" "$desc" >> "$out/results-$k.tsv"
    done
}

for k in $(seq 0 $((workers - 1))); do work "$k" & done
wait

sort -V "$out"/results-*.tsv > "$out/results.tsv"
echo "killed    $(grep -c $'\tkilled\t' "$out/results.tsv" || true)"
echo "survived  $(grep -c $'\tsurvived\t' "$out/results.tsv" || true)"
echo "stillborn $(grep -c $'\tstillborn\t' "$out/results.tsv" || true)"
grep $'\tsurvived\t' "$out/results.tsv" || true
