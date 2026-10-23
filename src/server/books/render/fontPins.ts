// src/server/books/render/fontPins.ts
//
// The pin table of the Books fonts (visual template composer plan, decision
// 6): each family's two files and their SHA-256. Kept apart from fonts.ts (the
// server's loader, which reads the files from disk with Node) so that the
// browser imports the same pins without importing Node (WYSIWYG invoice editor
// plan, phase 1): the browser fetches the files by their digest
// (GET /api/books/fonts/<sha256>) and refuses any whose bytes differ, exactly
// as the server refuses a file on disk that differs. A family id never changes
// its files; a newer font is a new family id.

import type { FontFamily } from '../template/schema';

export interface PinnedFile {
  file: string;
  sha256: string;
}

export type FontFace = 'regular' | 'bold';

/** Each family's files and their pinned digests (decision 6: a family id never changes its files). */
export const FONT_FILES: Record<FontFamily, Record<FontFace, PinnedFile>> = {
  'dejavu-sans': {
    regular: { file: 'DejaVuSans.ttf', sha256: '7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954' },
    bold: { file: 'DejaVuSans-Bold.ttf', sha256: 'e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724' },
  },
  'noto-sans': {
    regular: { file: 'NotoSans-Regular.ttf', sha256: 'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8' },
    bold: { file: 'NotoSans-Bold.ttf', sha256: '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9' },
  },
  'noto-serif': {
    regular: { file: 'NotoSerif-Regular.ttf', sha256: 'a15cfbbc1539d707115111d672d590a3d70d4f74b4c0a315956da20ae19a14e1' },
    bold: { file: 'NotoSerif-Bold.ttf', sha256: '24ad531e6b05ddad8c3d89572d2c93eb86a6b74e652ce7ee3c3e171de68e84c3' },
  },
};
