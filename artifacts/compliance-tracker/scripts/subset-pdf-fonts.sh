#!/usr/bin/env bash
# Rebuilds the Noto Sans subsets embedded in HotTubTrack PDF exports.
# Needs fontTools (`pip install fonttools`). Source: the static Google Fonts
# Noto Sans TTFs from npm @expo-google-fonts/noto-sans@0.4.2 (SIL OFL 1.1).
# Keep UNICODES in step with .agents/memory/pdf-unicode-font.md.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/src/assets/fonts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$work" && npm pack --silent @expo-google-fonts/noto-sans@0.4.2 >/dev/null && tar xzf ./*.tgz)
UNICODES="U+0020-007E,U+00A0-024F,U+0250-02FF,U+0300-036F,U+0370-03FF,U+0400-052F,U+1E00-1EFF,U+1F00-1FFF,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-218F,U+2190-21FF,U+2200-22FF,U+25A0-25FF,U+2C60-2C7F,U+A720-A7FF,U+FB00-FB06"
subset() {
  pyftsubset "$work/package/$1/NotoSans_$1.ttf" \
    --unicodes="$UNICODES" --no-hinting --layout-features='' \
    --drop-tables+=GSUB,GPOS,GDEF,DSIG --notdef-outline \
    --name-IDs='*' --name-languages='*' \
    --output-file="$out/$2"
}
mkdir -p "$out"
subset 400Regular NotoSans-Regular.ttf
subset 700Bold NotoSans-Bold.ttf
cp "$work/package/LICENSE_FONT" "$out/OFL.txt"
ls -l "$out"
