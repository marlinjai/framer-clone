// @vitest-environment node
// The real validator and safe re-encoder (3D plan S2 steps 2, 5, 6) run offline in a worker with a time
// and memory cap: well-formed models, malformed ones, decompression bombs, a re-encoded result checked
// against the same limits, and the worker caps themselves. Models are built in memory here: nothing
// is downloaded and nothing leaves the machine.

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { checkGlb } from '@/lib/scene/glb';
import { MemoryBlobStore, MemorySiteModels } from '../../memory';
import { DECODED_LIMITS, acceptModelUpload, decodedProblem } from '../../uploadModel';
import { ModelRefusalError } from '../../ports';
import { khronosValidator, safeReencoder } from '../adapters';
import { declaredDecodedBytes } from '../engine.mjs';
import { runInWorker } from '../run';

/* eslint-disable @typescript-eslint/no-explicit-any -- the test edits a model's JSON loosely on purpose */
const SLOW = 90_000;
const io = new NodeIO().registerExtensions([EXTTextureWebP, EXTMeshoptCompression]);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A one-triangle model, optionally with a base colour texture (a solid PNG of the given size). */
async function model(texture?: { width: number; height: number }): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const indices = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
  if (texture) {
    prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer));
    // A gradient, not a flat colour: the optimiser (rightly) replaces a solid texture with a plain colour factor.
    const raw = Buffer.alloc(texture.width * texture.height * 3);
    for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) { const i = (y * texture.width + x) * 3; raw[i] = x % 256; raw[i + 1] = y % 256; raw[i + 2] = (x + y) % 256; }
    const png = await sharp(raw, { raw: { width: texture.width, height: texture.height, channels: 3 } }).png().toBuffer();
    const tex = doc.createTexture('t').setImage(new Uint8Array(png)).setMimeType('image/png');
    prim.setMaterial(doc.createMaterial('m').setBaseColorTexture(tex));
  }
  const mesh = doc.createMesh().addPrimitive(prim);
  const node = doc.createNode().setMesh(mesh);
  doc.createScene().addChild(node);
  return io.writeBinary(doc);
}

/** Rewrite a GLB's JSON chunk, keeping the binary chunk. */
function rewriteJson(glb: Uint8Array, change: (json: Record<string, any>) => void): Uint8Array {
  const v = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jl = v.getUint32(12, true);
  const json = JSON.parse(dec.decode(glb.subarray(20, 20 + jl)));
  change(json);
  const text = enc.encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const rest = glb.subarray(20 + jl);
  const out = new Uint8Array(20 + padded.length + rest.length);
  const o = new DataView(out.buffer);
  o.setUint32(0, 0x46546c67, true); o.setUint32(4, 2, true); o.setUint32(8, out.length, true);
  o.setUint32(12, padded.length, true); o.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20); out.set(rest, 20 + padded.length);
  return out;
}

const refusal = async (p: Promise<unknown>): Promise<ModelRefusalError> => {
  try { await p; } catch (e) { if (e instanceof ModelRefusalError) return e; throw e; }
  throw new Error('expected a refusal');
};

describe('the Khronos validator, in a worker', () => {
  it('accepts a well-formed model', async () => {
    expect(await khronosValidator().validate(await model())).toEqual({ ok: true });
  }, SLOW);

  it('refuses malformed files with the validator\'s message, never throwing', async () => {
    const good = await model();
    for (const bad of [good.slice(0, 40), enc.encode('not a model'), new Uint8Array(0), rewriteJson(good, (j) => { j.accessors[0].count = 99; })]) {
      const r = await khronosValidator().validate(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  }, SLOW);

  it('never fetches an external resource, even one a file names', async () => {
    const r = await khronosValidator().validate(rewriteJson(await model(), (j) => { j.buffers[0].uri = 'https://evil.example/x.bin'; }));
    expect(r.ok).toBe(false);
  }, SLOW);
});

describe('the safe re-encoder: a well-formed model', () => {
  it('re-encodes, and the output passes the structure guard, the validator and every decoded cap', async () => {
    const out = await safeReencoder().reencode(await model());
    expect(out.input).toMatchObject({ triangles: 1, materials: 0, nodes: 1, clips: 0 });
    expect(out.output.triangles).toBe(1);
    expect(decodedProblem(out.input)).toBeNull();
    expect(decodedProblem(out.output)).toBeNull();
    const guard = checkGlb(out.bytes);
    expect(guard.ok).toBe(true);
    expect(await khronosValidator().validate(out.bytes)).toEqual({ ok: true });
    if (guard.ok) expect(guard.summary.extensionsUsed).toEqual(expect.arrayContaining(['EXT_meshopt_compression']));
  }, SLOW);

  it('resizes an oversized texture to at most 2048 pixels and writes it as WebP', async () => {
    const out = await safeReencoder().reencode(await model({ width: 3000, height: 3000 }));
    expect(out.input.maxTextureSide).toBe(3000);
    expect(out.output.maxTextureSide).toBeLessThanOrEqual(DECODED_LIMITS.outputTextureSide);
    const { json } = await io.binaryToJSON(out.bytes);
    expect(json.images?.length).toBe(1);
    expect(json.extensionsUsed).toContain('EXT_texture_webp');
    expect(checkGlb(out.bytes).ok).toBe(true);
  }, SLOW);
});

describe('the safe re-encoder: refusals and decompression bombs', () => {
  it('refuses a file it cannot read', async () => {
    const e = await refusal(safeReencoder().reencode(enc.encode('definitely not a GLB')));
    expect(e.status).toBe(422);
  }, SLOW);

  it('refuses a truncated GLB without hanging or crashing', async () => {
    const good = await model();
    await refusal(safeReencoder().reencode(good.slice(0, good.length - 10)));
  }, SLOW);

  it('refuses a model that declares a huge accessor before allocating anything', async () => {
    const bomb = rewriteJson(await model(), (j) => { j.accessors[0].count = 2_000_000_000; });
    const started = Date.now();
    const e = await refusal(safeReencoder().reencode(bomb));
    expect(e.code).toBe('model-too-complex');
    expect(e.message).toMatch(/decoded bytes/);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, SLOW);

  it('refuses accessors that add up past the decoded cap, one at a time well under it', () => {
    const per = Math.floor(DECODED_LIMITS.decodedBytes / 4 / 3 / 4) + 1;
    const accessors = Array.from({ length: 5 }, () => ({ componentType: 5126, type: 'VEC3', count: per }));
    expect(() => declaredDecodedBytes({ accessors }, DECODED_LIMITS)).toThrow(/the model declares/);
  });

  it('refuses a meshopt buffer view that declares an enormous decoded size', async () => {
    const bomb = rewriteJson(await model(), (j) => {
      j.extensionsUsed = ['EXT_meshopt_compression'];
      j.bufferViews.push({ buffer: 0, byteLength: 8, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 8, count: 1_000_000_000, byteStride: 12, mode: 'ATTRIBUTES' } } });
    });
    const e = await refusal(safeReencoder().reencode(bomb));
    expect(e.code).toBe('model-too-complex');
  }, SLOW);

  it('refuses malformed accessor descriptions instead of trusting them', () => {
    for (const bad of [{ componentType: 1, type: 'VEC3', count: 1 }, { componentType: 5126, type: 'NOPE', count: 1 }, { componentType: 5126, type: 'VEC3', count: -1 }, { componentType: 5126, type: 'VEC3', count: 1.5 }, { componentType: 5126, type: 'VEC3', count: 2 ** 60 }]) {
      expect(() => declaredDecodedBytes({ accessors: [bad] }, DECODED_LIMITS)).toThrow();
    }
  });

  it('refuses Draco, which cannot be measured here, with a clear message', async () => {
    const draco = rewriteJson(await model(), (j) => { j.extensionsUsed = ['KHR_draco_mesh_compression']; });
    const e = await refusal(safeReencoder().reencode(draco));
    expect(e.message).toMatch(/Draco/);
  }, SLOW);

  it('refuses a texture over 4096 pixels on a side', async () => {
    const e = await refusal(safeReencoder().reencode(await model({ width: 4200, height: 16 })));
    expect(e.code).toBe('model-too-complex');
    expect(e.message).toMatch(/4096|too large/);
  }, SLOW);

  it('refuses an image bomb: a tiny PNG whose header claims 60000 by 60000 pixels, without decoding it', async () => {
    const png = Buffer.from(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer());
    // IHDR is bytes 16..24 (width, height); its CRC covers type + data and must be rewritten.
    png.writeUInt32BE(60000, 16); png.writeUInt32BE(60000, 20);
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    let crc = 0xffffffff;
    for (let i = 12; i < 29; i++) crc = table[(crc ^ png[i]) & 0xff] ^ (crc >>> 8);
    png.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    const doc = await io.readBinary(await model({ width: 8, height: 8 }));
    doc.getRoot().listTextures()[0].setImage(new Uint8Array(png));
    const started = Date.now();
    const e = await refusal(safeReencoder().reencode(await io.writeBinary(doc)));
    // The header is read, never decoded: it is refused as oversized, or as unreadable if the decoder rejects the forged header first.
    expect(['model-too-complex', 'invalid-model']).toContain(e.code);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, SLOW);

  it('refuses textures that add up past the total pixel budget', async () => {
    const doc = await io.readBinary(await model({ width: 4000, height: 4000 }));
    const root = doc.getRoot();
    const png = root.listTextures()[0].getImage()!;
    for (let i = 0; i < 3; i++) doc.createMaterial(`m${i}`).setBaseColorTexture(doc.createTexture(`t${i}`).setImage(png).setMimeType('image/png'));
    const e = await refusal(safeReencoder().reencode(await io.writeBinary(doc)));
    expect(e.message).toMatch(/add up|pixels/);
  }, SLOW);
});

describe('the worker caps', () => {
  const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

  it('stops a worker that never answers at the time cap', async () => {
    const started = Date.now();
    const e = await refusal(runInWorker('validate', new Uint8Array(1), {}, { script: fixture('spin.mjs'), timeoutMs: 800 }));
    expect(e.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  }, SLOW);

  it('stops a worker that passes its memory cap', async () => {
    const e = await refusal(runInWorker('validate', new Uint8Array(1), {}, { script: fixture('hog.mjs'), heapMb: 64, timeoutMs: 30_000 }));
    expect(e.code).toBe('out-of-memory');
  }, SLOW);

  it('treats a worker that exits without answering as a failure, not a pass', async () => {
    await expect(runInWorker('validate', new Uint8Array(1), {}, { script: fixture('silent.mjs') })).rejects.toThrow(/without an answer/);
  }, SLOW);

  it('treats a validator that timed out as a refusal, never an approval', async () => {
    const v = khronosValidator({ script: fixture('spin.mjs'), timeoutMs: 500 });
    // Thrown, never returned as ok: the upload answers it as a refusal (413 timeout), see below.
    await expect(v.validate(new Uint8Array(1))).rejects.toMatchObject({ code: 'timeout', status: 413 });
  }, SLOW);

  it('keeps the caller\'s bytes: the worker gets a copy', async () => {
    const bytes = await model();
    const before = bytes.byteLength;
    await khronosValidator().validate(bytes);
    expect(bytes.byteLength).toBe(before);
  }, SLOW);
});

describe('review findings', () => {
  const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

  it('does not take a truncated validator report for a pass: warnings that fill the limit cannot hide a later error', async () => {
    const hidden = rewriteJson(await model(), (j) => {
      j.materials = Array.from({ length: 1100 }, () => ({ unknownThing: 1 }));
      j.nodes.push({ mesh: 99 });
    });
    const r = await khronosValidator().validate(hidden);
    expect(r.ok).toBe(false);
  }, SLOW);

  it('counts a mesh once for every node that places it (instancing cannot hide triangles)', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const n = 1000;
    const pos = new Float32Array(n * 9).map((_, i) => (i * 0.37) % 5);
    const position = doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer);
    const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', position));
    const scene = doc.createScene();
    for (let i = 0; i < 600; i++) scene.addChild(doc.createNode(`n${i}`).setMesh(mesh));
    const out = await safeReencoder().reencode(await io.writeBinary(doc));
    expect(out.input.triangles).toBe(600_000);
    expect(decodedProblem(out.input)).toMatch(/triangles/);
  }, SLOW);

  it('refuses counts and depth from the JSON before decoding: nodes, images, a deep chain', async () => {
    const e1 = await refusal(safeReencoder().reencode(rewriteJson(await model(), (j) => { j.nodes = Array.from({ length: 1001 }, () => ({})); })));
    expect(e1.message).toMatch(/1001 nodes/);
    const e2 = await refusal(safeReencoder().reencode(rewriteJson(await model(), (j) => { j.images = Array.from({ length: 17 }, () => ({ bufferView: 0 })); })));
    expect(e2.message).toMatch(/17 images/);
    const e3 = await refusal(safeReencoder().reencode(rewriteJson(await model(), (j) => { j.nodes = Array.from({ length: 40 }, (_, i) => (i < 39 ? { children: [i + 1] } : {})); })));
    expect(e3.message).toMatch(/deeper than 32/);
    const started = Date.now();
    await refusal(safeReencoder().reencode(rewriteJson(await model(), (j) => { j.nodes = Array.from({ length: 150_000 }, (_, i) => ({ children: [i + 1] })); })));
    expect(Date.now() - started).toBeLessThan(20_000);
  }, SLOW);

  it('accepts only single png, jpeg or webp images: an SVG named as a PNG is refused', async () => {
    const doc = await io.readBinary(await model({ width: 8, height: 8 }));
    doc.getRoot().listTextures()[0].setImage(enc.encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>')).setMimeType('image/png');
    const e = await refusal(safeReencoder().reencode(await io.writeBinary(doc)));
    expect(e.message).toMatch(/only single png, jpeg or webp/);
    expect(e.status).toBe(422);
  }, SLOW);

  it('queues workers: no more than two run at once', async () => {
    const started = Date.now();
    await Promise.all([0, 1, 2].map(() => refusal(runInWorker('validate', new Uint8Array(1), {}, { script: fixture('spin.mjs'), timeoutMs: 500 }))));
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  }, SLOW);

  it('answers a validator that timed out as 413 timeout, not as an invalid file, and stores nothing', async () => {
    const d = { blobs: new MemoryBlobStore(), models: new MemorySiteModels(), validator: khronosValidator({ script: fixture('spin.mjs'), timeoutMs: 400 }), reencoder: safeReencoder() };
    expect(await acceptModelUpload(await model(), 's', 'u', d)).toMatchObject({ ok: false, status: 413, code: 'timeout' });
    expect(d.blobs.files.size).toBe(0);
  }, SLOW);

  it('words a server-side refusal as ours to retry, not as the file\'s fault', async () => {
    const d = { blobs: new MemoryBlobStore(), models: new MemorySiteModels(), validator: { validate: async () => ({ ok: true as const }) }, reencoder: { reencode: async () => { throw new ModelRefusalError('reencode-failed', 'the optimised model could not be read back', 500); } } };
    const r = await acceptModelUpload(await model(), 's', 'u', d);
    expect(r).toMatchObject({ ok: false, status: 500 });
    if (!r.ok) expect(r.message).toMatch(/Try again/);
  }, SLOW);
});

describe('second review findings', () => {
  /** A .gltf text file: the same model with its buffer embedded as a data address. */
  async function gltfText(): Promise<Uint8Array> {
    const doc = await io.readBinary(await model());
    const jsonDoc = await io.writeJSON(doc);
    const uri = jsonDoc.json.buffers![0].uri!;
    const bytes = jsonDoc.resources[uri];
    jsonDoc.json.buffers![0].uri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
    return enc.encode(JSON.stringify(jsonDoc.json));
  }

  it('re-encodes a .gltf with an embedded buffer end to end, to a GLB that passes the guard and the validator', async () => {
    const text = await gltfText();
    expect(checkGlb(text).ok).toBe(true);
    expect(await khronosValidator().validate(text)).toEqual({ ok: true });
    const out = await safeReencoder().reencode(text);
    expect(out.input.triangles).toBe(1);
    expect(checkGlb(out.bytes).ok).toBe(true);
    expect((checkGlb(out.bytes) as { summary: { container: string } }).summary.container).toBe('glb');
    expect(await khronosValidator().validate(out.bytes)).toEqual({ ok: true });
  }, SLOW);

  it('does not refuse a valid but noisy export for having many infos', async () => {
    const noisy = rewriteJson(await model(), (j) => { for (let i = 0; i < 1500; i++) j.nodes.push({}); });
    expect(await khronosValidator().validate(noisy)).toEqual({ ok: true });
  }, SLOW);

  it('counts points and lines too, so a point cloud cannot hide', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(300_000 * 3).map((_, i) => i % 7)).setBuffer(buffer);
    const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setMode(0).setAttribute('POSITION', position));
    const scene = doc.createScene();
    for (let i = 0; i < 3; i++) scene.addChild(doc.createNode().setMesh(mesh));
    const out = await safeReencoder().reencode(await io.writeBinary(doc));
    expect(out.input.triangles).toBe(900_000);
    expect(decodedProblem(out.input)).toMatch(/triangles/);
  }, SLOW);

  it('answers a corrupt image as unreadable (422), not as too large', async () => {
    const doc = await io.readBinary(await model({ width: 8, height: 8 }));
    doc.getRoot().listTextures()[0].setImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])).setMimeType('image/png');
    const e = await refusal(safeReencoder().reencode(await io.writeBinary(doc)));
    expect(e).toMatchObject({ status: 422, code: 'invalid-model' });
  }, SLOW);

  it('says busy (503) instead of queueing without end', async () => {
    const spin = new URL('./fixtures/spin.mjs', import.meta.url);
    const calls = Array.from({ length: 2 + 16 + 3 }, () => runInWorker('validate', new Uint8Array(1), {}, { script: spin, timeoutMs: 300 }).then(() => 'ok', (e: ModelRefusalError) => e.code));
    const codes = await Promise.all(calls);
    expect(codes.filter((c) => c === 'busy').length).toBe(3);
  }, SLOW);
});

describe('the whole upload with the real pipeline (offline, in-memory storage)', () => {
  const deps = () => ({ blobs: new MemoryBlobStore(), models: new MemorySiteModels(), validator: khronosValidator(), reencoder: safeReencoder() });

  it('stores a re-encoded model that passes the validator and the guard', async () => {
    const d = deps();
    const r = await acceptModelUpload(await model({ width: 3000, height: 3000 }), 'site-1', 'u', d);
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    const served = await d.blobs.get(`served/${r.model.sha256}`);
    expect(served).not.toBeNull();
    expect(checkGlb(served!).ok).toBe(true);
    expect(await khronosValidator().validate(served!)).toEqual({ ok: true });
    expect(r.model.bytes).toBe(served!.byteLength);
  }, SLOW);

  it('refuses a bomb and stores nothing', async () => {
    const d = deps();
    const r = await acceptModelUpload(rewriteJson(await model(), (j) => { j.accessors[0].count = 2_000_000_000; }), 'site-1', 'u', d);
    // The Khronos validator already refuses a count the buffer cannot hold (422); a bomb it would pass is refused
    // by the re-encoder's pre-decode caps (413, tested above). Either way nothing is stored.
    expect(r.ok).toBe(false);
    if (!r.ok) expect([413, 422]).toContain(r.status);
    expect(d.blobs.files.size).toBe(0);
  }, SLOW);

  it('answers a model the validator rejects with 422 and stores nothing', async () => {
    const d = deps();
    const r = await acceptModelUpload(rewriteJson(await model(), (j) => { j.accessors[0].count = 99; }), 'site-1', 'u', d);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(d.blobs.files.size).toBe(0);
  }, SLOW);

  it('is still fail-closed without the adapters', async () => {
    const r = await acceptModelUpload(await model(), 'site-1', 'u', { blobs: new MemoryBlobStore(), models: new MemorySiteModels() });
    expect(r).toMatchObject({ ok: false, status: 503, code: 'not-configured' });
  });
});
