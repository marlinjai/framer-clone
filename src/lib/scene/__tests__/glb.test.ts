// checkGlb: the structure guard for an uploaded model (slice S2a). It is NOT the whole upload
// validation (no glTF validator, no decoding, no triangle or texture caps, no re-encode).

import { describe, expect, it } from 'vitest';
import { ALLOWED_EXTENSIONS, GLB_LIMITS, MAX_FILE_BYTES, MAX_JSON_BYTES, checkGlb, type GlbRefusalCode } from '../glb';

const enc = new TextEncoder();
const pad4 = (n: number) => Math.ceil(n / 4) * 4;

/** A GLB from a JSON object and an optional binary chunk length, with every chunk header written by hand. */
function glb(json: unknown, bin?: number, tweak: { totalLength?: number; jsonChunkLength?: number; binChunkLength?: number; version?: number; extraChunk?: boolean; jsonType?: number } = {}): Uint8Array {
  const text = enc.encode(typeof json === 'string' ? json : JSON.stringify(json));
  const jsonLen = pad4(text.length);
  const jsonPadded = new Uint8Array(jsonLen).fill(0x20);
  jsonPadded.set(text);
  const binLen = bin === undefined ? 0 : pad4(bin);
  const total = 12 + 8 + jsonLen + (bin === undefined ? 0 : 8 + binLen) + (tweak.extraChunk ? 8 : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, tweak.version ?? 2, true);
  v.setUint32(8, tweak.totalLength ?? total, true);
  v.setUint32(12, tweak.jsonChunkLength ?? jsonLen, true);
  v.setUint32(16, tweak.jsonType ?? 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  let at = 20 + jsonLen;
  if (bin !== undefined) {
    v.setUint32(at, tweak.binChunkLength ?? binLen, true);
    v.setUint32(at + 4, 0x004e4942, true);
    at += 8 + binLen;
  }
  if (tweak.extraChunk) { v.setUint32(at, 0, true); v.setUint32(at + 4, 0x12345678, true); }
  return out;
}

const model = (extra: Record<string, unknown> = {}) => ({
  asset: { version: '2.0' },
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [] }],
  buffers: [{ byteLength: 100 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 100 }],
  ...extra,
});

const accepts = (bytes: Uint8Array) => {
  const r = checkGlb(bytes);
  if (!r.ok) throw new Error(`expected accepted, got ${r.code}: ${r.message}`);
  return r.summary;
};
const refuses = (bytes: Uint8Array, code: GlbRefusalCode, message?: RegExp) => {
  const r = checkGlb(bytes);
  if (r.ok) throw new Error('expected a refusal');
  expect(r.code).toBe(code);
  if (message) expect(r.message).toMatch(message);
};

describe('checkGlb: accepted files', () => {
  it('accepts a minimal GLB and summarises it', () => {
    const s = accepts(glb(model(), 100));
    expect(s.container).toBe('glb');
    expect(s.counts).toMatchObject({ nodes: 1, meshes: 1, materials: 0, bones: 0 });
    expect(s.bufferBytes).toBe(100);
  });

  it('accepts a binary chunk padded up to 3 bytes past the declared buffer', () => {
    accepts(glb(model({ buffers: [{ byteLength: 98 }], bufferViews: [] }), 98));
  });

  it('accepts a glTF with embedded base64 buffers and images', () => {
    const data = 'A'.repeat(136); // 102 bytes
    const s = accepts(enc.encode(JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ byteLength: 100, uri: `data:application/octet-stream;base64,${data}` }],
      bufferViews: [{ buffer: 0, byteLength: 100 }],
      images: [{ uri: 'data:image/png;base64,iVBORw0KGgo=' }],
    })));
    expect(s.container).toBe('gltf');
  });

  it('accepts the allow-listed extensions, declared and used', () => {
    const s = accepts(glb(model({
      extensionsUsed: [...ALLOWED_EXTENSIONS],
      extensionsRequired: ['KHR_mesh_quantization'],
      materials: [{ extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } }],
    }), 100));
    expect(s.extensionsUsed).toContain('KHR_materials_clearcoat');
  });
});

describe('checkGlb: the file is not a model, or too big', () => {
  it('refuses bytes that are not a Uint8Array, tiny input and unknown formats', () => {
    refuses('x' as never, 'not-a-model');
    refuses(new Uint8Array(0), 'not-a-model');
    refuses(new Uint8Array(11), 'not-a-model');
    refuses(enc.encode('<html>nothing here</html>'), 'not-a-model');
    refuses(enc.encode('﻿{"asset":{"version":"2.0"}}'), 'not-a-model');
  });

  it('refuses a file over the read cap without scanning it', () => {
    refuses(new Uint8Array(MAX_FILE_BYTES + 1), 'too-large');
  });
});

describe('checkGlb: the container', () => {
  it('refuses another GLB version and a header length that lies', () => {
    refuses(glb(model(), 100, { version: 1 }), 'bad-header');
    refuses(glb(model(), 100, { totalLength: 99999 }), 'bad-header', /length in the header/);
    refuses(glb(model(), 100, { totalLength: 20 }), 'bad-header');
  });

  it('refuses a chunk length that runs past the file, and an unpadded one', () => {
    refuses(glb(model(), 100, { jsonChunkLength: 0x7ffffff0 }), 'bad-chunk', /runs past/);
    refuses(glb(model(), 100, { binChunkLength: 0xfffffffc }), 'bad-chunk', /runs past/);
    refuses(glb(model(), 100, { binChunkLength: 98 }), 'bad-chunk', /padded/);
  });

  it('refuses a first chunk that is not JSON, an extra chunk, and a cut-off chunk header', () => {
    refuses(glb(model(), 100, { jsonType: 0x004e4942 }), 'bad-chunk', /must be JSON/);
    refuses(glb(model(), 100, { extraChunk: true }), 'bad-chunk', /not allowed/);
    const cut = glb(model(), 100);
    refuses(cut.subarray(0, cut.length - 4).slice(), 'bad-header');
  });

  it('refuses JSON that is not UTF-8, does not parse, or is not an object', () => {
    refuses(glb('{"asset":'), 'bad-json');
    refuses(glb('[1,2]'), 'bad-json');
    const bad = glb('{"a":"xx"}');
    bad[20 + 6] = 0xff;
    refuses(bad, 'bad-json', /UTF-8/);
  });

  it('refuses a JSON chunk over its cap', () => {
    refuses(glb(`{"asset":{"version":"2.0"},"pad":"${'x'.repeat(MAX_JSON_BYTES)}"}`), 'too-large', /JSON part/);
  });
});

describe('checkGlb: nothing may reach outside the file', () => {
  const bufferWith = (uri: unknown) => model({ buffers: [{ byteLength: 100, uri }] });
  it.each([
    'https://evil.example/x.bin', 'http://a/b', '//evil.example/x.bin', 'file:///etc/passwd', 'ftp://x/y', 'blob:https://a/b',
    'javascript:alert(1)', '../secrets.bin', 'texture.png', '/abs/path.bin', 'data:text/html,<script>alert(1)</script>',
    'data:application/octet-stream,AAAA', 'data:application/octet-stream;base64,AAAA\nhttps://evil', 'data:;base64,AAAA', '',
  ])('refuses the buffer uri %j', (uri) => {
    refuses(glb(bufferWith(uri), 100), 'external-reference');
  });

  it('refuses an external image uri and a non-text uri', () => {
    refuses(glb(model({ images: [{ uri: 'https://evil.example/t.png' }] }), 100), 'external-reference');
    refuses(glb(model({ images: [{ uri: 'tex/a.png' }] }), 100), 'external-reference');
    refuses(glb(model({ images: [{ uri: 5 }] }), 100), 'bad-structure');
  });

  it('refuses an image with neither a view nor an embedded uri', () => {
    refuses(glb(model({ images: [{}] }), 100), 'bad-structure');
    refuses(glb(model({ images: [{ bufferView: 9 }] }), 100), 'bad-structure');
  });
});

describe('checkGlb: extensions', () => {
  it('refuses an unknown extension used, required, or only found on an object', () => {
    refuses(glb(model({ extensionsUsed: ['VENDOR_shader_hook'] }), 100), 'extension', /VENDOR_shader_hook/);
    refuses(glb(model({ extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'] }), 100), 'extension');
    refuses(glb(model({ materials: [{ extensions: { EVIL_ext: {} } }] }), 100), 'extension', /EVIL_ext/);
    refuses(glb(model({ nodes: [{ extensions: { KHR_lights_punctual: {} } }] }), 100), 'extension');
  });

  it('refuses an extension list that is not a short list of names', () => {
    refuses(glb(model({ extensionsUsed: 'KHR_mesh_quantization' }), 100), 'bad-structure');
    refuses(glb(model({ extensionsUsed: [1] }), 100), 'bad-structure');
    refuses(glb(model({ extensionsUsed: new Array(65).fill('KHR_mesh_quantization') }), 100), 'bad-structure');
  });
});

describe('checkGlb: counts', () => {
  const filler: Record<string, unknown> = { meshes: { primitives: [] }, animations: { channels: [], samplers: [] } };
  const list = (n: number, key = '') => Array.from({ length: n }, () => ({ ...((filler[key] as object) ?? {}) }));
  it.each<[string, number]>([
    ['meshes', GLB_LIMITS.meshes], ['materials', GLB_LIMITS.materials], ['textures', GLB_LIMITS.textures],
    ['animations', GLB_LIMITS.animations], ['nodes', GLB_LIMITS.nodes],
  ])('refuses more than %s allows, and accepts exactly the cap', (key, cap) => {
    accepts(glb(model({ [key]: list(cap, key) }), 100));
    refuses(glb(model({ [key]: list(cap + 1, key) }), 100), 'too-many', new RegExp(`${key} has ${cap + 1}`));
  });

  it('refuses too many images and too many bones in one skin', () => {
    refuses(glb(model({ images: Array.from({ length: GLB_LIMITS.images + 1 }, () => ({ bufferView: 0 })) }), 100), 'too-many');
    refuses(glb(model({ skins: [{ joints: Array.from({ length: GLB_LIMITS.bones + 1 }, () => 0) }] }), 100), 'too-many', /bones/);
    expect(accepts(glb(model({ skins: [{ joints: Array.from({ length: 128 }, () => 0) }] }), 100)).counts.bones).toBe(128);
  });

  it('refuses a list that is not a list', () => {
    refuses(glb(model({ meshes: { length: 1 } }), 100), 'bad-structure');
  });
});

describe('checkGlb: the node tree', () => {
  const chain = (n: number) => Array.from({ length: n }, (_, i) => (i < n - 1 ? { children: [i + 1] } : {}));
  it('accepts depth 32 and refuses 33', () => {
    accepts(glb(model({ nodes: chain(32) }), 100));
    refuses(glb(model({ nodes: chain(33) }), 100), 'too-deep');
  });

  it('refuses a cycle, a self-parent, two parents and a missing child', () => {
    refuses(glb(model({ nodes: [{ children: [1] }, { children: [0] }] }), 100), 'bad-structure');
    refuses(glb(model({ nodes: [{ children: [0] }] }), 100), 'bad-structure');
    refuses(glb(model({ nodes: [{ children: [2] }, { children: [2] }, {}] }), 100), 'bad-structure', /more than one parent/);
    refuses(glb(model({ nodes: [{ children: [5] }] }), 100), 'bad-structure', /does not exist/);
    refuses(glb(model({ nodes: [{ children: [-1] }] }), 100), 'bad-structure');
    refuses(glb(model({ nodes: [{ children: [1.5] }, {}] }), 100), 'bad-structure');
  });

  it('survives a node list that repeats one child many times without hanging', () => {
    refuses(glb(model({ nodes: [{ children: new Array(999).fill(1) }, {}] }), 100), 'bad-structure');
  });
});

describe('checkGlb: buffers', () => {
  it('refuses a buffer larger than the binary chunk, or a chunk with slack over 3 bytes', () => {
    refuses(glb(model({ buffers: [{ byteLength: 200 }] }), 100), 'bad-buffer', /does not match/);
    refuses(glb(model({ buffers: [{ byteLength: 80 }], bufferViews: [] }), 100), 'bad-buffer');
  });

  it('refuses a missing binary chunk, an unused one, and a uri-less buffer beyond the first', () => {
    refuses(glb(model()), 'bad-buffer', /missing/);
    refuses(glb(model({ buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }], bufferViews: [] }), 100), 'bad-buffer', /no buffer uses/);
    refuses(glb(model({ buffers: [{ byteLength: 100 }, { byteLength: 4 }] }), 100), 'bad-buffer', /only the first/);
    refuses(enc.encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] })), 'bad-buffer');
  });

  it('refuses an embedded buffer shorter than it declares', () => {
    refuses(enc.encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 1000, uri: 'data:application/octet-stream;base64,AAAA' }] })), 'bad-buffer', /declares/);
  });

  it('refuses a bufferView outside its buffer, with huge, negative or fractional numbers', () => {
    refuses(glb(model({ bufferViews: [{ buffer: 0, byteOffset: 50, byteLength: 51 }] }), 100), 'bad-buffer', /past the end/);
    refuses(glb(model({ bufferViews: [{ buffer: 3, byteLength: 1 }] }), 100), 'bad-structure', /does not exist/);
    refuses(glb(model({ bufferViews: [{ buffer: 0, byteOffset: -1, byteLength: 1 }] }), 100), 'bad-structure');
    refuses(glb(model({ bufferViews: [{ buffer: 0, byteOffset: 2 ** 53, byteLength: 1 }] }), 100), 'bad-structure');
    refuses(glb(model({ bufferViews: [{ buffer: 0, byteLength: 0.5 }] }), 100), 'bad-structure');
    refuses(glb(model({ bufferViews: [{ buffer: 0, byteOffset: Number.MAX_SAFE_INTEGER, byteLength: Number.MAX_SAFE_INTEGER }] }), 100), 'bad-buffer');
  });
});

describe('checkGlb: review findings', () => {
  const B64 = (mime: string) => `data:${mime};base64,AAAA`;
  const glbWith = (extra: Record<string, unknown>) => glb(model(extra), 100);

  it('allows only image types for an image and buffer types for a buffer data address', () => {
    refuses(glbWith({ images: [{ uri: B64('image/svg+xml') }] }), 'external-reference', /not an allowed type/);
    refuses(glbWith({ images: [{ uri: B64('text/html') }] }), 'external-reference');
    refuses(glbWith({ buffers: [{ byteLength: 3, uri: B64('text/html') }], bufferViews: [] }), 'external-reference', /not an allowed type/);
    refuses(glbWith({ buffers: [{ byteLength: 3, uri: B64('image/png') }], bufferViews: [] }), 'external-reference');
    for (const m of ['image/png', 'image/jpeg', 'image/webp']) accepts(glbWith({ images: [{ uri: B64(m) }] }));
    refuses(glbWith({ images: [{ bufferView: 0, mimeType: 'image/svg+xml' }] }), 'bad-structure', /mimeType/);
    accepts(glbWith({ images: [{ bufferView: 0, mimeType: 'image/png' }] }));
  });

  it('refuses base64 a strict decoder would refuse, and empty data', () => {
    refuses(glbWith({ images: [{ uri: 'data:image/png;base64,AAAAA' }] }), 'external-reference', /base64/);
    refuses(glbWith({ images: [{ uri: 'data:image/png;base64,' }] }), 'external-reference', /base64/);
  });

  it('refuses a zero-length buffer or bufferView, and an image with both a uri and a view', () => {
    refuses(glbWith({ buffers: [{ byteLength: 0 }], bufferViews: [] }), 'bad-buffer', /at least 1/);
    refuses(glbWith({ bufferViews: [{ buffer: 0, byteLength: 0 }] }), 'bad-buffer', /at least 1/);
    refuses(glbWith({ images: [{ uri: B64('image/png'), bufferView: 0 }] }), 'bad-structure', /both/);
  });

  it('accepts a meshopt fallback buffer with no data, and checks the compressed view against its buffer', () => {
    const buffers = [{ byteLength: 100 }, { byteLength: 5000, extensions: { EXT_meshopt_compression: { fallback: true } } }];
    const s = accepts(glbWith({
      extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'], buffers,
      bufferViews: [{ buffer: 1, byteLength: 5000, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 80, byteStride: 12, mode: 'ATTRIBUTES', count: 10 } } }],
    }));
    expect(s.bufferBytes).toBe(100);
    refuses(glbWith({
      extensionsUsed: ['EXT_meshopt_compression'], buffers,
      bufferViews: [{ buffer: 1, byteLength: 5000, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 90, byteLength: 80 } } }],
    }), 'bad-buffer', /past the end/);
    // Without the flag a uri-less second buffer is still refused.
    refuses(glbWith({ buffers: [{ byteLength: 100 }, { byteLength: 5 }], bufferViews: [] }), 'bad-buffer', /only the first/);
  });

  it.each<[string, Record<string, unknown>]>([
    ['node mesh', { nodes: [{ mesh: 99 }] }],
    ['node skin', { nodes: [{ skin: 7 }] }],
    ['scene node', { scenes: [{ nodes: [500] }] }],
    ['default scene', { scene: 4 }],
    ['skin joint', { skins: [{ joints: [9999] }] }],
    ['skin joint negative', { skins: [{ joints: [-1] }] }],
    ['texture source', { textures: [{ source: 50 }] }],
    ['texture sampler', { textures: [{ source: 0, sampler: 50 }], images: [{ bufferView: 0 }] }],
    ['accessor view', { accessors: [{ bufferView: 77, count: 1 }] }],
    ['accessor count', { accessors: [{ bufferView: 0, count: 1e15 + 0.5 }] }],
    ['sparse view', { accessors: [{ count: 1, sparse: { indices: { bufferView: 9 }, values: { bufferView: 0 } } }] }],
    ['primitive attribute', { meshes: [{ primitives: [{ attributes: { POSITION: 3 } }] }] }],
    ['primitive material', { meshes: [{ primitives: [{ attributes: {}, material: 3 }] }] }],
    ['material texture', { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 9 } } }] }],
    ['extension material texture', { materials: [{ extensions: { KHR_materials_clearcoat: { clearcoatTexture: { index: 9 } } } }] }],
    ['draco view', { meshes: [{ primitives: [{ attributes: {}, extensions: { KHR_draco_mesh_compression: { bufferView: 9, attributes: {} } } }] }] }],
    ['variant material', { meshes: [{ primitives: [{ attributes: {}, extensions: { KHR_materials_variants: { mappings: [{ material: 9, variants: [0] }] } } }] }] }],
    ['animation sampler', { animations: [{ channels: [{ sampler: 9, target: { node: 0, path: 'translation' } }], samplers: [] }] }],
    ['animation node', { animations: [{ channels: [{ sampler: 0, target: { node: 1e9, path: 'translation' } }], samplers: [{ input: 0, output: 0 }] }], accessors: [{ count: 1 }] }],
    ['animation accessor', { animations: [{ channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 5, output: 5 }] }] }],
  ])('refuses a dangling index: %s', (_name, extra) => {
    const needsExt = JSON.stringify(extra).includes('KHR_') ? { extensionsUsed: [...ALLOWED_EXTENSIONS] } : {};
    refuses(glbWith({ ...needsExt, ...extra }), 'bad-structure', /does not exist|whole number|must be/);
  });

  it('accepts a coherent model that uses every kind of reference', () => {
    accepts(glbWith({
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, skin: 0, children: [1] }, {}],
      skins: [{ joints: [1], skeleton: 0, inverseBindMatrices: 0 }],
      accessors: [{ bufferView: 0, count: 3 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 0, material: 0, targets: [{ POSITION: 0 }] }] }],
      images: [{ bufferView: 0 }], samplers: [{}], textures: [{ source: 0, sampler: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      animations: [{ channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }], samplers: [{ input: 0, output: 0 }] }],
    }));
  });

  it('caps primitives per mesh, in total, morph targets, samplers and animation channels', () => {
    const prim = { attributes: {} };
    refuses(glbWith({ meshes: [{ primitives: Array.from({ length: 65 }, () => prim) }] }), 'too-many', /65 primitives/);
    refuses(glbWith({ meshes: Array.from({ length: 17 }, () => ({ primitives: Array.from({ length: 64 }, () => prim) })) }), 'too-many', /more than 1024 primitives/);
    refuses(glbWith({ meshes: [{ primitives: [{ attributes: {}, targets: Array.from({ length: 65 }, () => ({})) }] }] }), 'too-many', /morph targets/);
    refuses(glbWith({ samplers: Array.from({ length: 257 }, () => ({})) }), 'too-many');
    refuses(glbWith({ animations: [{ channels: [], samplers: Array.from({ length: 1025 }, () => ({})) }] }), 'too-many', /channels or samplers/);
  });

  it('refuses a byte order mark in the GLB JSON chunk', () => {
    refuses(glb('\uFEFF{"asset":{"version":"2.0"}}'), 'bad-json');
  });

  it('does not take an extensions key inside extras for an extension block', () => {
    accepts(glbWith({ extras: { extensions: { anything: 1 } }, nodes: [{ mesh: 0, extras: { extensions: { x: 1 } } }] }));
    refuses(glbWith({ nodes: [{ mesh: 0, extensions: { x: 1 } }] }), 'extension');
  });

  it('refuses a long list of extension names early and cheaply', () => {
    const many = Object.fromEntries(Array.from({ length: 100000 }, (_, i) => [`EVIL_${i}`, {}]));
    const started = Date.now();
    refuses(glbWith({ nodes: [{ mesh: 0, extensions: many }] }), 'extension');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('keeps its own cost small on a large array of small objects', () => {
    const started = Date.now();
    const r = checkGlb(glb(`{"asset":{"version":"2.0"},"extras":[${'{},'.repeat(900000)}{}]}`));
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('checkGlb: hostile JSON', () => {
  it('refuses a number that is not finite (1e999 parses to Infinity)', () => {
    refuses(glb('{"asset":{"version":"2.0"},"nodes":[{"translation":[1e999,0,0]}]}'), 'bad-structure', /not finite/);
  });

  it('refuses JSON nested past its depth, without a stack overflow', () => {
    refuses(glb(`{"asset":{"version":"2.0"},"x":${'['.repeat(200)}${']'.repeat(200)}}`), 'too-deep');
    // Deep enough that JSON.parse itself may give up: still a refusal, never a throw.
    expect(() => checkGlb(glb(`{"asset":{"version":"2.0"},"x":${'['.repeat(100000)}${']'.repeat(100000)}}`))).not.toThrow();
  });

  it('is not fooled by __proto__ or constructor keys', () => {
    const r = checkGlb(glb('{"asset":{"version":"2.0"},"__proto__":{"extensionsUsed":["EVIL"]},"constructor":{"prototype":{}}}'));
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).extensionsUsed).toBeUndefined();
  });

  it('refuses a wrong or missing asset version', () => {
    for (const asset of [undefined, {}, { version: 2 }, { version: '1.0' }, { version: '2' }, { version: '3.0' }]) {
      refuses(glb(model({ asset })), 'bad-structure', /asset\.version/);
    }
  });

  it('never throws, whatever the bytes', () => {
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const base = glb(model(), 100);
    for (let i = 0; i < 300; i++) {
      const copy = base.slice();
      for (let j = 0; j < 1 + Math.floor(rand() * 6); j++) copy[Math.floor(rand() * copy.length)] = Math.floor(rand() * 256);
      expect(() => checkGlb(rand() < 0.3 ? copy.subarray(0, Math.floor(rand() * copy.length)) : copy)).not.toThrow();
    }
  });
});
