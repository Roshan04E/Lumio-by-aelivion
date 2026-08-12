#!/usr/bin/env bash
# LONG-source corpus for DEBT-019: the SAME corpus as pull-media-gen.sh with ONE axis changed,
# duration 3s -> 120s. The whole DEBT-019 claim is that resident bytes scale with clip DURATION,
# so a ladder that holds duration fixed measures everything except the property under test.
#
# Built by CONCATENATING each existing distinct 3s clip 40x with `-c copy` (no re-encode), not by
# re-synthesizing 200 minutes of testsrc2 (~2.5h of ffmpeg). Stream copy is the right tool here and
# is not a shortcut that weakens the result:
#   - codec, profile, resolution, GOP-12 cadence and bitrate are bit-identical to the 3s corpus,
#     because they are literally the same encoded samples;
#   - file i keeps 3s-corpus file i's distinct hue+noise, so the 100 files stay mutually distinct
#     and nothing dedups in the OS page cache;
#   - sample count and file size scale exactly 40x, which is the axis being varied.
# Residency does not depend on whether the picture repeats within a file, only on bytes and on the
# size of the sample table -- both of which scale honestly here.
set -euo pipefail

SRC="${1:?usage: pull-media-gen-long.sh <3s-corpus-dir> <outdir> [n] [reps]}"
OUT="${2:?usage: pull-media-gen-long.sh <3s-corpus-dir> <outdir> [n] [reps]}"
N="${3:-100}"
REPS="${4:-40}"   # 40 x 3s = 120s
mkdir -p "$OUT"

echo "== long corpus: $N clips, ${REPS}x concat of the 3s corpus (stream copy) =="
for i in $(seq 0 $(( N - 1 ))); do
  name="src$(printf '%03d' "$i").mp4"
  in="$SRC/$name"
  out="$OUT/$name"
  [ -f "$out" ] && continue
  [ -f "$in" ] || { echo "missing source $in" >&2; exit 1; }
  list="$OUT/.concat-$i.txt"
  : > "$list"
  for _ in $(seq 1 "$REPS"); do printf "file '%s'\n" "$(cygpath -m "$in" 2>/dev/null || echo "$in")" >> "$list"; done
  ffmpeg -v error -y -f concat -safe 0 -i "$list" -c copy -movflags +faststart "$out"
  rm -f "$list"
  [ $(( i % 20 )) -eq 0 ] && echo "  ...$i"
done
echo "  corpus done: $(ls "$OUT"/src*.mp4 | wc -l) files, $(du -sh "$OUT" | cut -f1)"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/src000.mp4" | awk '{printf "  duration check: %.1fs\n", $1}'
