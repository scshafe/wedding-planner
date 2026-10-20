import { ProductError } from '../product_error'

/**
 * @canonical plain_text -- what text people type into the product may hold: never a control character (C0, DEL,
 * C1), a line or paragraph separator, or a bidirectional override or isolate that could make text display as
 * something else, nor a lone surrogate (ill-formed UTF-16, which cannot be encoded). A `multiline` field (notes) may
 * also break lines (\n, \r) and hold tabs. Refused with PRODUCT.BAD_REQUEST. Output is escaped anyway; this keeps stored text honest wherever it is shown or exported.
 */
export function assertPlainText(values: readonly (string | undefined)[], options: { readonly multiline?: boolean } = {}): void {
  for (const value of values) {
    if (value === undefined) continue
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      // A surrogate must be half of a pair: a high one followed by a low one.
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ProductError('PRODUCT.BAD_REQUEST', 'Text must be well-formed.', {})
        i += 1
        continue
      }
      if (code >= 0xdc00 && code <= 0xdfff) throw new ProductError('PRODUCT.BAD_REQUEST', 'Text must be well-formed.', {})
      if (options.multiline === true && (code === 0x0a || code === 0x0d || code === 0x09)) continue
      if (isDisallowed(code)) throw new ProductError('PRODUCT.BAD_REQUEST', 'Text may not hold control characters, line separators or direction overrides.', {})
    }
  }
}

function isDisallowed(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/** `value` with every lone surrogate replaced by U+FFFD, so it can always be encoded (a backstop for stored text). */
export function toWellFormedText(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}
