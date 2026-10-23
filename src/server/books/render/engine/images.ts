// src/server/books/render/engine/images.ts
//
// Logo images, prepared once per process and asset (visual template composer
// plan, decisions 10, 12 and 15). pdf-lib decodes a PNG and compresses its
// pixels again on every `embedPng`: for a 2000 x 2000 px logo that took 0.7 to
// 1.6 s per render, far over the preview's 150 ms target, and the save gate
// renders seven probe documents. So each asset is embedded ONCE into a scratch
// PDF by pdf-lib's own embedders; the resulting image stream (and the alpha
// mask a PNG with transparency gets) are kept, already compressed, and every
// later render copies those streams into its PDF. The bytes are the same
// whether a render prepared the image or found it prepared (the streams are
// copied as they are), so caching never changes a document.
//
// The cache is keyed by SHA-256 (an asset's bytes never change under its
// hash) and bounded, least recently used out. Pure: no Node-only imports, so
// the engine can still run in a browser worker.

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
}

/** How many prepared images one process keeps (a company uses one or two logos). */
const MAX_PREPARED = 64;
const prepared = new Map<string, Promise<PreparedImage>>();

async function prepare(asset: EngineImage): Promise<PreparedImage> {
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
  return { width: embedder.width, height: embedder.height, image, mask: maskRef instanceof PDFRef ? stream(maskRef) : null };
}

function preparedImage(sha256: string, asset: EngineImage): Promise<PreparedImage> {
  let p = prepared.get(sha256);
  if (p) {
    // Most recently used last.
    prepared.delete(sha256);
    prepared.set(sha256, p);
    return p;
  }
  p = prepare(asset);
  // A file that fails to prepare is not kept: it fails again, loudly, on the next render.
  p.catch(() => prepared.delete(sha256));
  prepared.set(sha256, p);
  while (prepared.size > MAX_PREPARED) prepared.delete(prepared.keys().next().value!);
  return p;
}

/** Embed an asset into `pdf` from its prepared streams; the image to draw. */
export async function embedAsset(pdf: PDFDocument, sha256: string, asset: EngineImage): Promise<PDFImage> {
  const ready = await preparedImage(sha256, asset);
  // pdf-lib accepts only its own embedder classes: an object of that class whose embedding copies the prepared streams.
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
