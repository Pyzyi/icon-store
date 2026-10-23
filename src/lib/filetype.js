import { fileTypeFromBuffer } from 'file-type';
import { FILE_TYPES } from '../constants.js';
import { AppError } from './errors.js';
import { looksLikeSvg } from './svg.js';

/**
 * Determine the type from the bytes and require it to match the extension.
 * Trusting either alone is not enough: the extension decides the URL and the
 * Content-Type, the bytes decide what a browser actually does with it.
 * @param {Buffer} buffer
 * @param {string} ext lower-case extension
 * @returns {Promise<typeof FILE_TYPES[string]>}
 */
export async function verifyFileType(buffer, ext) {
  const expected = FILE_TYPES[ext];
  if (!expected) throw new AppError(400, 'unsupported_type', { ext });

  const detected = await fileTypeFromBuffer(buffer);
  if (expected.kind === 'svg') {
    // file-type cannot identify SVG; binary formats it does identify are an immediate mismatch.
    const isBinary = detected !== undefined && detected.ext !== 'xml';
    if (isBinary || !looksLikeSvg(buffer)) throw new AppError(400, 'type_mismatch', { ext });
    return expected;
  }
  if (detected?.ext !== expected.detected) throw new AppError(400, 'type_mismatch', { ext });
  return expected;
}
