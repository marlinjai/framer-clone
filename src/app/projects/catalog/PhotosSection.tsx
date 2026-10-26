'use client';

// src/app/projects/catalog/PhotosSection.tsx
//
// The panel's "Photos" section: drop files on it or choose them (PNG, JPEG or
// WebP up to 2 MB each, checked again by the server from the bytes), reorder
// by dragging or with the move buttons (the keyboard way), give each photo its
// alternative text, take one off. A photo is tied to a variant in the variant
// table. Each step can be undone from the panel; taking a photo off is undone
// by adding the same file again (the server still holds it, so it is the same
// stored image) and putting it back in its place.

import { ArrowLeft, ArrowRight, ImagePlus, Trash2 } from 'lucide-react';
import React, { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { catalogApi, imageUrl } from '@/lib/catalog/api';
import type { ProductDetail } from '@/lib/catalog/types';
import { cn } from '@/lib/utils';

import type { Apply } from './ProductPanel';
import { SaveField, Section, errorText } from './ui';

const ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 2 * 1024 * 1024;

/** Why a file is refused before it is sent, or null. */
export function fileProblem(file: File): string | null {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return `${file.name}: only PNG, JPEG and WebP images can be added`;
  if (file.size > MAX_BYTES) return `${file.name}: an image may have at most 2 MB`;
  return null;
}

export default function PhotosSection({ product, apply }: { product: ProductDetail; apply: Apply }) {
  const [problems, setProblems] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);
  const dragged = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const images = product.images;

  async function add(files: FileList | File[]) {
    const list = [...files];
    const refused = list.map(fileProblem).filter((p): p is string => p !== null);
    const ok = list.filter((f) => fileProblem(f) === null);
    setProblems(refused);
    for (const file of ok) {
      setUploading((n) => n + 1);
      try {
        let added: ProductDetail | null = null;
        await apply(
          'photo added',
          async () => (added = await catalogApi.addImage(product.id, file)),
          async () => {
            const link = added?.images.find((i) => !images.some((x) => x.id === i.id));
            return link ? catalogApi.removeImage(product.id, link.id) : catalogApi.product(product.id);
          },
        );
      } catch (err) {
        setProblems((p) => [...p, `${file.name}: ${errorText(err)}`]);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function reorder(ids: string[]) {
    const before = images.map((i) => i.id);
    setProblems([]);
    try {
      await apply('photo order', () => catalogApi.reorderImages(product.id, ids), () => catalogApi.reorderImages(product.id, before));
    } catch (err) {
      setProblems([errorText(err)]);
    }
  }

  function move(id: string, by: -1 | 1) {
    const ids = images.map((i) => i.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void reorder(ids);
  }

  async function remove(id: string) {
    const img = images.find((i) => i.id === id);
    if (!img) return;
    const order = images.map((i) => i.id);
    const variantIds = product.variants.filter((v) => v.imageId === id).map((v) => v.id);
    setProblems([]);
    try {
      await apply(
        'photo removed',
        () => catalogApi.removeImage(product.id, id),
        async () => {
          // Put the same file back (stored once per company, so it is the same image) where it was.
          const res = await fetch(imageUrl(img.sha256), { cache: 'force-cache' });
          if (!res.ok) throw new Error('The photo could not be read back; add the file again.');
          let d = await catalogApi.addImage(product.id, await res.blob());
          const back = d.images.find((x) => x.sha256 === img.sha256);
          if (back) {
            d = await catalogApi.reorderImages(product.id, order.map((x) => (x === id ? back.id : x)).filter((x) => d.images.some((y) => y.id === x)));
            for (const v of variantIds) d = await catalogApi.updateVariant(product.id, v, { imageId: back.id });
          }
          return d;
        },
      );
    } catch (err) {
      setProblems([errorText(err)]);
    }
  }

  return (
    <Section
      title="Photos"
      id="panel-photos"
      aside={
        <Button type="button" variant="outline" size="sm" onClick={() => picker.current?.click()}>
          <ImagePlus aria-hidden /> Add photos
        </Button>
      }
    >
      <input
        ref={picker}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose photos"
        onChange={(e) => {
          if (e.target.files) void add(e.target.files);
          e.target.value = '';
        }}
      />
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault();
            void add(e.dataTransfer.files);
          }
        }}
        className={cn(
          'rounded-xl border border-dashed border-foreground/15 p-3 transition-colors duration-150',
          over && 'border-brand bg-brand/[0.05]',
        )}
      >
        {images.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Drop photos here, or use Add photos. PNG, JPEG or WebP, up to 2 MB each.
          </p>
        ) : (
          <ol className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3" aria-label="Photos in order">
            {images.map((img, i) => (
              <li
                key={img.id}
                draggable
                onDragStart={(e) => {
                  dragged.current = img.id;
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (dragged.current) e.preventDefault();
                }}
                onDrop={(e) => {
                  const from = dragged.current;
                  dragged.current = null;
                  if (!from || from === img.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const ids = images.map((x) => x.id).filter((x) => x !== from);
                  ids.splice(ids.indexOf(img.id), 0, from);
                  void reorder(ids);
                }}
                className="glass-inset flex flex-col gap-2 rounded-xl p-2"
              >
                <span className="relative block aspect-square overflow-hidden rounded-lg bg-background/60">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a private, session-guarded image route */}
                  <img src={imageUrl(img.sha256)} alt={img.alt ?? ''} className="size-full object-cover" loading="lazy" />
                  {i === 0 ? (
                    <span className="absolute top-1.5 left-1.5 rounded-md bg-foreground/80 px-1.5 py-0.5 text-[11px] font-medium text-background">
                      Main photo
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center justify-between gap-1">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {img.width} x {img.height}
                  </span>
                  <span className="flex">
                    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Move photo ${i + 1} earlier`} disabled={i === 0} onClick={() => move(img.id, -1)}>
                      <ArrowLeft aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Move photo ${i + 1} later`}
                      disabled={i === images.length - 1}
                      onClick={() => move(img.id, 1)}
                    >
                      <ArrowRight aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Remove photo ${i + 1}`} onClick={() => void remove(img.id)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                </span>
                <SaveField
                  label="Alternative text"
                  value={img.alt}
                  format={(x) => x ?? ''}
                  parse={(t) => (t.length > 300 ? { ok: false, message: 'At most 300 characters' } : { ok: true, value: t.trim() === '' ? null : t.trim() })}
                  placeholder="What the photo shows"
                  maxLength={300}
                  onSave={(alt) => apply('alternative text', () => catalogApi.setImageAlt(product.id, img.id, alt), () => catalogApi.setImageAlt(product.id, img.id, img.alt))}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
      {uploading > 0 ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Uploading {uploading} {uploading === 1 ? 'photo' : 'photos'}…
        </p>
      ) : null}
      {problems.length > 0 ? (
        <ul role="alert" className="mt-2 flex flex-col gap-1 text-xs text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
