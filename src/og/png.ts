// Minimal PNG helpers for the OG images (Story 1.10): an 8-bit RGB encoder
// (resvg emits RGBA; the images must carry no alpha channel) and an IHDR
// reader used by the `og` build check. Node built-ins only.
import { crc32, deflateSync } from 'node:zlib';

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour type 2: truecolour without alpha. */
export const PNG_COLOR_RGB = 2;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes straight RGBA pixels (row-major, 4 bytes per pixel) as an 8-bit RGB
 * PNG, dropping alpha. Throws unless every pixel is fully opaque, so a
 * transparent render can never be flattened silently.
 */
export function encodeRgbPng(rgba: Uint8Array, width: number, height: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`png: invalid size ${width}×${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`png: expected ${width * height * 4} RGBA bytes for ${width}×${height}, got ${rgba.length}`);
  }
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride; // filter byte 0 (None) stays 0
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      if (rgba[src + 3] !== 255) throw new Error(`png: pixel (${x}, ${y}) is not opaque (alpha ${rgba[src + 3]})`);
      const dst = row + 1 + x * 3;
      raw[dst] = rgba[src]!;
      raw[dst + 1] = rgba[src + 1]!;
      raw[dst + 2] = rgba[src + 2]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = PNG_COLOR_RGB;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

/** The IHDR fields of a PNG; null when the bytes are not a PNG starting with IHDR. */
export function readPngHeader(bytes: Uint8Array): PngHeader | null {
  if (bytes.length < 33) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (view.getUint32(8) !== 13 || type !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20), bitDepth: bytes[24]!, colorType: bytes[25]! };
}
