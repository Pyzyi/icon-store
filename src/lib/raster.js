import sharp from 'sharp';
import { LIMITS } from '../constants.js';
import { AppError } from './errors.js';

// libvips' operation cache would hold up to ~50 MB for repeated work we never do;
// in a 256 MB container that memory is better left free.
sharp.cache(false);

/** JPEG is the only lossy re-encode; 90 is visually indistinguishable for icons. */
const JPEG_QUALITY = 90;

/** @typedef {(img: import('sharp').Sharp) => import('sharp').Sharp} Encoder */

/** @type {Record<string, Encoder>} */
const ENCODERS = {
  png: (img) => img.png({ compressionLevel: 9 }),
  jpg: (img) => img.jpeg({ quality: JPEG_QUALITY }),
  // Lossless so an already-optimised WebP icon does not lose detail.
  webp: (img) => img.webp({ lossless: true }),
  gif: (img) => img.gif(),
};

/** @param {Buffer} buffer @param {boolean} animated */
function open(buffer, animated) {
  return sharp(buffer, { animated, limitInputPixels: LIMITS.MAX_INPUT_PIXELS, failOn: 'error' });
}

/**
 * Re-encode a raster image. sharp drops EXIF/XMP/comments by default and the
 * encoder only writes pixel data, so anything appended to the original file
 * (polyglots, hidden archives) is gone afterwards.
 * @param {Buffer} buffer
 * @param {string} detected normalised type from FILE_TYPES (png, jpg, webp, gif)
 * @returns {Promise<Buffer>}
 */
export async function reencodeRaster(buffer, detected) {
  const encode = ENCODERS[detected];
  if (!encode) throw new AppError(400, 'unsupported_type', { ext: detected });
  const animated = detected === 'gif' || detected === 'webp';
  try {
    // rotate() bakes in the EXIF orientation that is about to be stripped.
    return await encode(open(buffer, animated).rotate()).toBuffer();
  } catch {
    throw new AppError(400, 'invalid_image');
  }
}

/**
 * Validation without changing the bytes (REENCODE_RASTER=false): decoding the
 * header still rejects corrupt files and decompression bombs.
 * @param {Buffer} buffer
 */
export async function assertDecodableRaster(buffer) {
  try {
    const meta = await open(buffer, true).metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
  } catch {
    throw new AppError(400, 'invalid_image');
  }
}
