import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { AppError } from './errors.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** DTDs enable entity expansion (billion laughs) and external entities (XXE). Icons never need them. */
const DTD_RE = /<!DOCTYPE|<!ENTITY/i;
/** url(...) that points anywhere but a local fragment (#id). */
const EXTERNAL_URL_RE = /url\s*\(\s*(?!['"]?\s*#)/i;
const IMPORT_RE = /@import/i;
/** Embedded raster previews are common in exported icons; anything else (incl. nested SVG) is not allowed. */
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const HREF_ATTRS = new Set(['href', 'xlink:href']);

/** @type {{ purify: import('dompurify').DOMPurify, window: any } | null} */
let instance = null;

/**
 * jsdom is expensive to construct, so one window is shared. Sanitising is
 * synchronous, which keeps the shared hooks free of interleaving.
 */
function getInstance() {
  if (instance) return instance;
  const { window } = new JSDOM('');
  const purify = createDOMPurify(/** @type {any} */ (window));

  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && isDangerousCss(node.textContent ?? '')) {
      node.textContent = '';
    }
  });
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase();
    const value = data.attrValue;
    if (HREF_ATTRS.has(name)) {
      const v = value.trim();
      const isLocal = v.startsWith('#');
      const isEmbeddedImage = node.nodeName.toLowerCase() === 'image' && DATA_IMAGE_RE.test(v);
      if (!isLocal && !isEmbeddedImage) data.keepAttr = false;
      return;
    }
    if (EXTERNAL_URL_RE.test(value) || IMPORT_RE.test(value)) data.keepAttr = false;
  });

  instance = { purify, window };
  return instance;
}

/** @param {string} css */
function isDangerousCss(css) {
  return EXTERNAL_URL_RE.test(css) || IMPORT_RE.test(css);
}

/**
 * Parse an uploaded SVG strictly as XML, strip everything that can execute or
 * fetch (scripts, event handlers, foreignObject, external references) and
 * re-serialise it. We store the cleaned output, never the original bytes.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function sanitizeSvg(buffer) {
  const text = decodeUtf8(buffer);
  if (DTD_RE.test(text)) throw new AppError(400, 'svg_unsafe');

  const { purify, window } = getInstance();
  const doc = new window.DOMParser().parseFromString(addMissingNamespace(text), 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length > 0 || root?.namespaceURI !== SVG_NS || root.localName !== 'svg') {
    throw new AppError(400, 'svg_invalid');
  }

  purify.sanitize(root, {
    IN_PLACE: true,
    USE_PROFILES: { svg: true, svgFilters: true },
    // <use> is safe once its href is restricted to local fragments (see hook above).
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'embed', 'object', 'audio', 'video', 'animate', 'set'],
    // Attributes that can trigger navigation or SMIL tricks on top of DOMPurify's defaults.
    FORBID_ATTR: ['attributename', 'from', 'to', 'values', 'begin', 'onbegin', 'onend', 'onrepeat'],
    ALLOW_DATA_ATTR: false,
  });

  if (purify.removed.some((r) => 'element' in r && r.element === root)) {
    throw new AppError(400, 'svg_unsafe');
  }
  const out = new window.XMLSerializer().serializeToString(root);
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${out}\n`, 'utf8');
}

/**
 * Cheap pre-check used for extension/content matching before we invest in a
 * full parse: an SVG is UTF-8 text whose first element is <svg>.
 * @param {Buffer} buffer
 */
export function looksLikeSvg(buffer) {
  let text;
  try {
    text = decodeUtf8(buffer);
  } catch {
    return false;
  }
  const head = text
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '')
    .trimStart();
  return /^<svg[\s>]/i.test(head);
}

/**
 * Hand-written SVGs often omit xmlns; browsers then refuse to render them as
 * images. Adding it is lossless and saves the user a confusing rejection.
 * @param {string} text
 */
function addMissingNamespace(text) {
  return text.replace(/<svg(?=[\s>/])([^>]*)>/i, (tag, attrs) =>
    /\sxmlns\s*=/.test(attrs) ? tag : `<svg xmlns="${SVG_NS}"${attrs}>`,
  );
}

/** @param {Buffer} buffer */
function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new AppError(400, 'svg_invalid');
  }
}
