# Fonts of the Books PDFs

The font files every Books document is set in (`src/server/books/render/fonts.ts`,
visual template composer plan decision 6). Each family id names exactly these files;
`fonts.ts` pins every file by its SHA-256 and refuses to load one that differs. A newer
version of a font is added under a NEW family id, never over these files, so an issued
document always re-renders with the bytes it was issued with.

| Family id | File | SHA-256 | Source | Licence |
|---|---|---|---|---|
| `dejavu-sans` | `DejaVuSans.ttf` | `7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954` | DejaVu Sans 2.37 | `DejaVu-LICENSE.txt` |
| `dejavu-sans` | `DejaVuSans-Bold.ttf` | `e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724` | DejaVu Sans 2.37 | `DejaVu-LICENSE.txt` |
| `noto-sans` | `NotoSans-Regular.ttf` | `f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8` | [NotoSans-v2.015.zip](https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSans-v2.015/NotoSans-v2.015.zip), `NotoSans/unhinted/ttf/NotoSans-Regular.ttf` | `Noto-OFL.txt` |
| `noto-sans` | `NotoSans-Bold.ttf` | `87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9` | the same archive, `NotoSans/unhinted/ttf/NotoSans-Bold.ttf` | `Noto-OFL.txt` |
| `noto-serif` | `NotoSerif-Regular.ttf` | `a15cfbbc1539d707115111d672d590a3d70d4f74b4c0a315956da20ae19a14e1` | [NotoSerif-v2.015.zip](https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSerif-v2.015/NotoSerif-v2.015.zip), `NotoSerif/unhinted/ttf/NotoSerif-Regular.ttf` | `Noto-OFL.txt` |
| `noto-serif` | `NotoSerif-Bold.ttf` | `24ad531e6b05ddad8c3d89572d2c93eb86a6b74e652ce7ee3c3e171de68e84c3` | the same archive, `NotoSerif/unhinted/ttf/NotoSerif-Bold.ttf` | `Noto-OFL.txt` |
| `dejavu-sans` | `DejaVuSans-Oblique.ttf` | `4af75fa16ee6d3ad43e1ecec41862c24954af26a55c6bb1ebb27bd486a50f5f4` | [dejavu-fonts-ttf-2.37.zip](https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip), `dejavu-fonts-ttf-2.37/ttf/DejaVuSans-Oblique.ttf` | `DejaVu-LICENSE.txt` |
| `dejavu-sans` | `DejaVuSans-BoldOblique.ttf` | `eb436dca0c2594b73d8b603b892e374fdfd8d885d25ffb4f18df4c4c0b49e50f` | the same archive, `dejavu-fonts-ttf-2.37/ttf/DejaVuSans-BoldOblique.ttf` | `DejaVu-LICENSE.txt` |
| `noto-sans` | `NotoSans-Italic.ttf` | `678288f868807d4d64a6f3b51466871d117d915780381ce9d0ed4b3bcbd06d37` | NotoSans-v2.015.zip (above), `NotoSans/unhinted/ttf/NotoSans-Italic.ttf` | `Noto-OFL.txt` |
| `noto-sans` | `NotoSans-BoldItalic.ttf` | `3d367743f371f28671d2764e911a53d7c20ec9b6aa8791d059e7090389fc52a5` | the same archive, `NotoSans/unhinted/ttf/NotoSans-BoldItalic.ttf` | `Noto-OFL.txt` |
| `noto-serif` | `NotoSerif-Italic.ttf` | `c4b3c971741ecdb40f5a443bce754e8fe91efe761b6ea10c92be7c3597cdadc4` | NotoSerif-v2.015.zip (above), `NotoSerif/unhinted/ttf/NotoSerif-Italic.ttf` | `Noto-OFL.txt` |
| `noto-serif` | `NotoSerif-BoldItalic.ttf` | `1bc4f86502eaa368718f6192bee022ea9a703d5af1c18b7d291212657b63074a` | the same archive, `NotoSerif/unhinted/ttf/NotoSerif-BoldItalic.ttf` | `Noto-OFL.txt` |

The Noto files come from the official releases of the Noto project
(`notofonts/latin-greek-cyrillic` on GitHub, version 2.015, released 2024-11-20).
`Noto-OFL.txt` is the SIL Open Font License 1.1 shipped in both archives (identical,
SHA-256 `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a`).

Why these files (2026-10-23):

- **Static, not variable**: each is one fixed instance (Regular or Bold, no `fvar`
  table). A variable font would draw its default instance and could change shape with
  an update of the file.
- **Unhinted**: TrueType hinting only steers rasterisation on screens at small sizes;
  PDF readers scale outlines themselves. The unhinted builds are about half the size of
  the hinted ones, with the same glyph outlines.
- **The release's standard character set** (2965 characters: Latin with every European
  diacritic, Greek, Cyrillic). The larger `full` build of Noto Sans exists only for the
  sans family; using the standard set for both keeps the two Noto families' coverage
  the same.

Each file was downloaded into an empty directory, opened with fontkit (family name,
subfamily Regular or Bold, version 2.015, no `fvar`) and only then copied here.

**The italic faces (added 2026-10-24, formatted intro and closing texts).** They came from
the same three archives as the upright files: each archive's regular file was checked
first against its pin above (identical), so the italic files are of the same release.
fontkit read each one as its family with the subfamily Oblique, Bold Oblique, Italic or
Bold Italic, version 2.37 or 2.015, no `fvar`. They were added to the existing family ids
instead of new ones, which the rule above would otherwise ask for: no document had ever
used italic, and a document embeds the italic faces only when one of its runs is italic,
so no stored render can change. The DejaVu oblique faces have fewer glyphs than the
upright ones (5355 against 6253), so italic text is checked for characters it cannot
print against the italic faces themselves.

The production image gets these files through `outputFileTracingIncludes` in
`next.config.ts` (`./assets/fonts/**/*` for every Books route); the standalone output
copies only traced files, so a file outside that glob would make a document in its
family fail in production.
