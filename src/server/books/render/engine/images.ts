// src/server/books/render/engine/images.ts
//
// Logo images, prepared once per process and asset (visual template composer
// plan, decisions 10, 12 and 15). pdf-lib decodes a PNG and compresses its
// pixels again on every `embedPng`: for a 2000 x 2000 px logo that took 0.7 to
// 1.6 s per render, far over the preview's 150 ms target, and the save gate
// renders seven probe documents. So each asset is embedded ONCE into a scratch
// PDF by pdf-lib's own embedders; the resulting image stream (and the soft mask,
// SMask, the alpha channel a PNG with transparency gets) are kept, already
// compressed, and every later render copies those streams into its PDF. The
// bytes are the same whether a render prepared the image or found it prepared
// (the streams are copied as they are), so caching never changes a document.
//
// The cache is keyed by SHA-256, and the key is checked against the bytes when
// an image is prepared (the cache serves every company of the process, so a
// key must mean exactly these bytes). It is bounded by count and by the bytes
// it holds, least recently used out. Pure: no Node-only imports (Web Crypto
// for the digest), so the engine can still run in a browser worker.
//
// This leans on pdf-lib internals, pinned exactly at 1.17.1: `PDFImage` accepts
// only an instance of its embedder classes, and `PDFDict.clone` is shallow, so
// the dictionary values of a prepared stream are shared between documents and
// must never be mutated. A pdf-lib upgrade re-runs the fresh-process
// determinism tests (engine.test.ts, engineLogo.test.ts) before it lands.

import {
  JpegEmbedder,
  PDFContext,
  PDFDocument,
  PDFImage,
  PDFName,
  PDFRawStream,
  PDFRef,
  PngEmbedder,
} from 'pdf-lib';

/** An image checked at upload (render/logoImage.ts): PNG or JPEG bytes. */
export interface EngineImage {
  contentType: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
}

interface PreparedImage {
  width: number;
  height: number;
  image: PDFRawStream;
  mask: PDFRawStream | null;
  /** The compressed bytes held (the cache's budget counts these). */
  size: number;
}

/** How many prepared images one process keeps (a company uses one or two logos). */
const MAX_PREPARED = 64;
/** How many bytes of prepared streams one process keeps. */
const MAX_PREPARED_BYTES = 64 * 1024 * 1024;
const prepared = new Map<string, Promise<PreparedImage>>();
const sizes = new Map<string, number>();
let held = 0;

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function prepare(sha256: string, asset: EngineImage): Promise<PreparedImage> {
  const digest = hex(await crypto.subtle.digest('SHA-256', new Uint8Array(asset.bytes)));
  if (digest !== sha256) throw new Error(`images: the asset named ${sha256} has other bytes (sha256 ${digest})`);
  const context = PDFContext.create();
  const embedder = asset.contentType === 'image/png' ? await PngEmbedder.for(asset.bytes) : await JpegEmbedder.for(asset.bytes);
  const ref = await embedder.embedIntoContext(context);
  const stream = (r: PDFRef): PDFRawStream => {
    const obj = context.lookup(r);
    if (!(obj instanceof PDFRawStream)) throw new Error('images: pdf-lib did not write an image stream');
    return obj;
  };
  const image = stream(ref);
  const maskRef = image.dict.get(PDFName.of('SMask'));
  const mask = maskRef instanceof PDFRef ? stream(maskRef) : null;
  const size = image.contents.byteLength + (mask?.contents.byteLength ?? 0);
  return { width: embedder.width, height: embedder.height, image, mask, size };
}

function forget(sha256: string): void {
  prepared.delete(sha256);
  held -= sizes.get(sha256) ?? 0;
  sizes.delete(sha256);
}

/** Drop every prepared image (a test seam: the next render prepares again, cold). */
export function clearPreparedImages(): void {
  for (const sha of [...prepared.keys()]) forget(sha);
}

function preparedImage(sha256: string, asset: EngineImage): Promise<PreparedImage> {
  const known = prepared.get(sha256);
  if (known) {
    // Most recently used last.
    prepared.delete(sha256);
    prepared.set(sha256, known);
    return known;
  }
  const mine = prepare(sha256, asset);
  prepared.set(sha256, mine);
  mine.then(
    (ready) => {
      if (prepared.get(sha256) !== mine) return;
      sizes.set(sha256, ready.size);
      held += ready.size;
      // Least recently used out, by count and by bytes (never the one just prepared).
      for (const old of [...prepared.keys()]) {
        if (prepared.size <= MAX_PREPARED && held <= MAX_PREPARED_BYTES) break;
        if (old !== sha256) forget(old);
      }
    },
    // A file that fails to prepare is not kept: it fails again, loudly, on the next render.
    () => {
      if (prepared.get(sha256) === mine) forget(sha256);
    },
  );
  return mine;
}

/** Embed an asset into `pdf` from its prepared streams; the image to draw. */
export async function embedAsset(pdf: PDFDocument, sha256: string, asset: EngineImage): Promise<PDFImage> {
  const ready = await preparedImage(sha256, asset);
  // pdf-lib accepts only its own embedder classes: an object of that class
  // whose embedding copies the prepared streams.
  const embedder: PngEmbedder = Object.assign(Object.create(PngEmbedder.prototype) as PngEmbedder, {
    width: ready.width,
    height: ready.height,
    async embedIntoContext(context: PDFContext, ref?: PDFRef): Promise<PDFRef> {
      const dict = ready.image.dict.clone(context);
      if (ready.mask) {
        dict.set(PDFName.of('SMask'), context.register(PDFRawStream.of(ready.mask.dict.clone(context), ready.mask.contents)));
      }
      const stream = PDFRawStream.of(dict, ready.image.contents);
      if (ref) {
        context.assign(ref, stream);
        return ref;
      }
      return context.register(stream);
    },
  });
  const image = PDFImage.of(pdf.context.nextRef(), pdf, embedder);
  await image.embed();
  return image;
}
