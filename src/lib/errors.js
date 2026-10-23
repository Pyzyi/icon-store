/**
 * Every error the API can return has a stable code. The UI translates codes
 * (see public/i18n.js); the English message is only a fallback for API users.
 */
export const ERROR_MESSAGES = Object.freeze({
  auth_required: 'Login required',
  invalid_credentials: 'Wrong admin key',
  rate_limited: 'Too many requests, please wait a moment',
  forbidden_origin: 'Request origin not allowed',
  not_found: 'Not found',
  icon_not_found: 'Icon not found',
  invalid_id: 'Invalid icon id',
  no_file: 'No file provided (field name must be "file")',
  unsupported_type: 'Unsupported file type',
  type_mismatch: 'File content does not match its extension',
  invalid_image: 'The image could not be read',
  svg_unsafe: 'The SVG contains constructs that cannot be made safe',
  svg_invalid: 'The SVG is not well-formed',
  file_too_large: 'File is too large',
  quota_exceeded: 'Storage limit reached',
  name_too_long: 'Name is too long',
  name_invalid: 'Name is invalid',
  too_many_tags: 'Too many tags',
  tag_too_long: 'A tag is too long',
  invalid_body: 'Invalid request body',
  body_too_large: 'Request body too large',
  server_busy: 'Server is busy, please retry',
  invalid_zip: 'Invalid or unsafe backup file',
  internal_error: 'Internal server error',
});

/** @typedef {keyof typeof ERROR_MESSAGES} ErrorCode */

export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {ErrorCode} code
   * @param {Record<string, string | number>} [params] values the UI may interpolate
   */
  constructor(status, code, params = {}) {
    super(ERROR_MESSAGES[code]);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/** multer error codes that mean "the client sent a malformed or oversized form". */
const MULTER_INVALID = new Set([
  'LIMIT_FILE_COUNT',
  'LIMIT_FIELD_COUNT',
  'LIMIT_PART_COUNT',
  'LIMIT_FIELD_KEY',
  'LIMIT_FIELD_VALUE',
  'LIMIT_UNEXPECTED_FILE',
  'MISSING_FIELD_NAME',
]);
/** body-parser error types. */
const BODY_INVALID = new Set(['entity.parse.failed', 'encoding.unsupported']);

/**
 * Translate errors thrown by body parsers and multer into AppErrors so the
 * client never sees library internals.
 * @param {any} err
 * @returns {AppError | null}
 */
export function fromLibraryError(err) {
  if (err instanceof AppError) return err;
  if (err?.code === 'LIMIT_FILE_SIZE') return new AppError(413, 'file_too_large');
  if (err?.type === 'entity.too.large') return new AppError(413, 'body_too_large');
  if (MULTER_INVALID.has(err?.code) || BODY_INVALID.has(err?.type)) return new AppError(400, 'invalid_body');
  // Malformed multipart from busboy surfaces as a plain Error with a 4xx status.
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    return new AppError(400, 'invalid_body');
  }
  return null;
}

/**
 * @param {import('./log.js').Logger} log
 * @returns {import('express').ErrorRequestHandler}
 */
export function errorHandler(log) {
  return (err, req, res, _next) => {
    const appErr = fromLibraryError(err);
    if (appErr) {
      res.status(appErr.status).json({ error: appErr.message, code: appErr.code, params: appErr.params });
      return;
    }
    // Unknown error: log details server-side, never leak them.
    log.error('unhandled error', { path: req.path, method: req.method, err: String(err?.stack ?? err) });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(500).json({ error: ERROR_MESSAGES.internal_error, code: 'internal_error', params: {} });
  };
}
