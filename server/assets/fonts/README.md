# Card fonts

Inter 4.1 (SIL OFL 1.1 — LICENSE.txt beside this file), subset for the
social-card renderer (server/utils/ogCard.ts). These are SERVER assets: satori
reads them to lay glyphs out as paths, and nothing here is ever served to a
browser — the site's own type stays the system stack.

Inter is the closest freely-licensable stand-in for that stack (a lambda has no
system fonts); InterDisplay is its optical size for the two display-size runs
(the list's name, the big figure).

Subset to Latin + Latin-1 + Latin Extended-A + general punctuation + U+2212 +
U+20AC — the exact ranges shared/ogCard.ts's DRAWABLE strips titles to, so a
kept character always has a glyph. Regenerate (fontTools) with:

```
python3 -m fontTools.subset Inter-Regular.ttf --output-file=inter-regular.ttf \
  --unicodes="0020-007E,00A0-00FF,0100-017F,2000-206F,2212,20AC" \
  --layout-features=kern --no-hinting
```

(same flags for inter-semibold / interdisplay-regular / interdisplay-bold, from
the matching faces of the Inter release zip)
