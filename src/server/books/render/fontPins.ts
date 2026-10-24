// src/server/books/render/fontPins.ts
//
// The pin table of the Books fonts (visual template composer plan, decision
// 6): each family's two files and their SHA-256. Kept apart from fonts.ts (the
// server's loader, which reads the files from disk with Node) so that the
// browser imports the same pins without importing Node (WYSIWYG invoice editor
// plan, phase 1): the browser fetches the files by their digest
// (GET /api/books/fonts/<sha256>) and refuses any whose bytes differ, exactly
// as the server refuses a file on disk that differs. A family id never changes
// its files; a newer font is a new family id. The italic faces were added to
// the existing ids on 2026-10-24 (formatted intro and closing texts) before any
// document used italic: they change no stored render, because a document
// embeds them only when a run of it is italic.

import type { FontFamily } from '../template/schema';

export interface PinnedFile {
  file: string;
  sha256: string;
}

export type FontFace = 'regular' | 'bold' | 'italic' | 'boldItalic';

/** The faces every document embeds; the italic ones only when a formatted text uses italic. */
export const UPRIGHT_FACES = ['regular', 'bold'] as const;
export const ITALIC_FACES = ['italic', 'boldItalic'] as const;

/** Each family's files and their pinned digests (decision 6: a family id never changes its files). */
export const FONT_FILES: Record<FontFamily, Record<FontFace, PinnedFile>> = {
  'dejavu-sans': {
    regular: { file: 'DejaVuSans.ttf', sha256: '7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954' },
    bold: { file: 'DejaVuSans-Bold.ttf', sha256: 'e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724' },
    italic: { file: 'DejaVuSans-Oblique.ttf', sha256: '4af75fa16ee6d3ad43e1ecec41862c24954af26a55c6bb1ebb27bd486a50f5f4' },
    boldItalic: { file: 'DejaVuSans-BoldOblique.ttf', sha256: 'eb436dca0c2594b73d8b603b892e374fdfd8d885d25ffb4f18df4c4c0b49e50f' },
  },
  'noto-sans': {
    regular: { file: 'NotoSans-Regular.ttf', sha256: 'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8' },
    bold: { file: 'NotoSans-Bold.ttf', sha256: '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9' },
    italic: { file: 'NotoSans-Italic.ttf', sha256: '678288f868807d4d64a6f3b51466871d117d915780381ce9d0ed4b3bcbd06d37' },
    boldItalic: { file: 'NotoSans-BoldItalic.ttf', sha256: '3d367743f371f28671d2764e911a53d7c20ec9b6aa8791d059e7090389fc52a5' },
  },
  'noto-serif': {
    regular: { file: 'NotoSerif-Regular.ttf', sha256: 'a15cfbbc1539d707115111d672d590a3d70d4f74b4c0a315956da20ae19a14e1' },
    bold: { file: 'NotoSerif-Bold.ttf', sha256: '24ad531e6b05ddad8c3d89572d2c93eb86a6b74e652ce7ee3c3e171de68e84c3' },
    italic: { file: 'NotoSerif-Italic.ttf', sha256: 'c4b3c971741ecdb40f5a443bce754e8fe91efe761b6ea10c92be7c3597cdadc4' },
    boldItalic: { file: 'NotoSerif-BoldItalic.ttf', sha256: '1bc4f86502eaa368718f6192bee022ea9a703d5af1c18b7d291212657b63074a' },
  },
};
