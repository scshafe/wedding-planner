import { describe, expect, it } from 'vitest'

import { MULTIPART_LIMITS, multipartBoundary, parseMultipartForm } from '@wedding-planner/product'

/** Issue #48 — the upload form's multipart parser: what browsers send parses; anything malformed or over a bound is refused. */

const BOUNDARY = '----WebKitFormBoundaryAbC123'
const TYPE = `multipart/form-data; boundary=${BOUNDARY}`

function body(parts: readonly { name: string; value: string | Buffer; filename?: string }[], boundary = BOUNDARY): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}`
    const type = part.filename === undefined ? '' : 'Content-Type: application/octet-stream\r\n'
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`), Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

describe('parseMultipartForm', () => {
  it('reads the fields and the one file, byte for byte (a boundary-like run inside the file does not end it)', () => {
    const file = Buffer.concat([Buffer.from('%PDF-1.4\r\n--'), Buffer.from(BOUNDARY.slice(0, 10)), Buffer.from([0, 255, 13, 10, 45, 45])])
    const form = parseMultipartForm(body([{ name: '_csrf', value: 'tok' }, { name: 'title', value: 'Café contract' }, { name: 'file', value: file, filename: 'a.pdf' }]), TYPE)
    expect(form?.fields.get('_csrf')).toBe('tok')
    expect(form?.fields.get('title')).toBe('Café contract')
    expect(form?.file?.filename).toBe('a.pdf')
    expect(Buffer.from(form?.file?.bytes ?? []).equals(file)).toBe(true)
  })

  it('keeps the first value of a repeated field; an empty file part is still a file', () => {
    const form = parseMultipartForm(body([{ name: 'title', value: 'first' }, { name: 'title', value: 'second' }, { name: 'file', value: '', filename: '' }]), TYPE)
    expect(form?.fields.get('title')).toBe('first')
    expect(form?.file?.bytes.length).toBe(0)
  })

  it('takes the boundary from the content type, quoted or not; anything else is refused', () => {
    expect(multipartBoundary(TYPE)).toBe(BOUNDARY)
    expect(multipartBoundary(`Multipart/Form-Data; charset=utf-8; boundary="${BOUNDARY}"`)).toBe(BOUNDARY)
    for (const type of [undefined, 'application/x-www-form-urlencoded', 'multipart/form-data', 'multipart/form-data; boundary=', `multipart/mixed; boundary=${BOUNDARY}`, `multipart/form-data; boundary=${'a'.repeat(71)}`, 'multipart/form-data; boundary=a\u0000b']) {
      expect(multipartBoundary(type)).toBeUndefined()
      expect(parseMultipartForm(body([{ name: 'a', value: 'b' }]), type)).toBeUndefined()
    }
  })

  it('refuses malformed bodies: no leading delimiter, no end, no header end, no disposition, a second file', () => {
    const good = body([{ name: 'a', value: 'b' }])
    expect(parseMultipartForm(Buffer.concat([Buffer.from('preamble\r\n'), good]), TYPE)).toBeUndefined()
    expect(parseMultipartForm(good.subarray(0, good.length - 10), TYPE)).toBeUndefined()
    expect(parseMultipartForm(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"`), TYPE)).toBeUndefined()
    expect(parseMultipartForm(Buffer.from(`--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nx\r\n--${BOUNDARY}--`), TYPE)).toBeUndefined()
    expect(parseMultipartForm(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: attachment; name="a"\r\n\r\nx\r\n--${BOUNDARY}--`), TYPE)).toBeUndefined()
    expect(parseMultipartForm(body([{ name: 'f', value: 'x', filename: 'a.pdf' }, { name: 'g', value: 'y', filename: 'b.pdf' }]), TYPE)).toBeUndefined()
    expect(parseMultipartForm(Buffer.alloc(0), TYPE)).toBeUndefined()
  })

  it('is bounded: parts, header size and field size', () => {
    const many = Array.from({ length: MULTIPART_LIMITS.parts + 1 }, (_, n) => ({ name: `f${n}`, value: 'x' }))
    expect(parseMultipartForm(body(many.slice(0, MULTIPART_LIMITS.parts)), TYPE)?.fields.size).toBe(MULTIPART_LIMITS.parts)
    expect(parseMultipartForm(body(many), TYPE)).toBeUndefined()
    expect(parseMultipartForm(body([{ name: 'n'.repeat(MULTIPART_LIMITS.header_bytes), value: 'x' }]), TYPE)).toBeUndefined()
    expect(parseMultipartForm(body([{ name: 'a', value: 'x'.repeat(MULTIPART_LIMITS.field_bytes) }]), TYPE)?.fields.get('a')?.length).toBe(MULTIPART_LIMITS.field_bytes)
    expect(parseMultipartForm(body([{ name: 'a', value: 'x'.repeat(MULTIPART_LIMITS.field_bytes + 1) }]), TYPE)).toBeUndefined()
  })
})
