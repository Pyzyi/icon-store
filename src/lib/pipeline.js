import { verifyFileType } from './filetype.js';
import { assertDecodableRaster, reencodeRaster } from './raster.js';
import { sanitizeSvg } from './svg.js';

/**
 * The single path every incoming file takes – browser upload and backup
 * import alike – so there is no second, weaker way into ICONS_DIR.
 * @param {Buffer} buffer
 * @param {string} ext
 * @param {{ reencodeRaster: boolean }} opts
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function processIcon(buffer, ext, opts) {
  const type = await verifyFileType(buffer, ext);
  switch (type.kind) {
    case 'svg':
      return { buffer: sanitizeSvg(buffer), contentType: type.mime };
    case 'raster':
      if (opts.reencodeRaster) {
        return { buffer: await reencodeRaster(buffer, type.detected), contentType: type.mime };
      }
      await assertDecodableRaster(buffer);
      return { buffer, contentType: type.mime };
    default:
      // ICO: sharp cannot decode it; the magic-byte check plus the sandbox CSP on delivery is our protection.
      return { buffer, contentType: type.mime };
  }
}
