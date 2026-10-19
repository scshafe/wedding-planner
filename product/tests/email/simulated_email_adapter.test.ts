import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  assertValidOutboundEmail,
  EMAIL_LIMITS,
  InMemoryRecordStore,
  isEmailAddress,
  type OutboundEmail,
  REDACTED_LINK,
  SimulatedEmailAdapter,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { GLOBAL_PARTITION } from '../../src/persistence/record_store'

/**
 * Issue #9: the email port's shared shape check and the offline adapter that records every message in the outbox
 * instead of sending it.
 */

const MESSAGE: OutboundEmail = {
  to: 'planner@example.test',
  subject: 'Reset your password',
  text_body: 'Follow the link to choose a new password.',
  purpose: 'password_reset',
  tenant_id: 'tenant_1',
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

function adapter(): { email: SimulatedEmailAdapter; clock: ManualClock } {
  const clock = new ManualClock('2027-06-01T09:00:00.000Z')
  return { email: new SimulatedEmailAdapter(clock, new SequentialIdGenerator('mail')), clock }
}

describe('email port — the shared shape check', () => {
  it('accepts ordinary addresses and rejects malformed ones', () => {
    for (const ok of ['a@b.co', 'first.last+tag@sub.example.test']) expect(isEmailAddress(ok)).toBe(true)
    for (const bad of ['', 'plain', 'a@b', '@b.co', 'a@@b.co', 'a b@c.co', 'a@b.co\r\nBcc: x@y.z', '<a@b.co>']) {
      expect(isEmailAddress(bad)).toBe(false)
    }
    expect(isEmailAddress(`${'a'.repeat(EMAIL_LIMITS.addressMax)}@b.co`)).toBe(false)
    // Control characters and Unicode line separators (line-break / truncation vectors in some mail libraries).
    for (const bad of ['a\u0000b@x.yz', 'a\u001bb@x.yz', 'a\u0085b@x.yz', 'a\u2028b@x.yz', 'a@x.yz\u007f']) {
      expect(isEmailAddress(bad)).toBe(false)
    }
  })

  it('refuses control characters and line separators in the subject', () => {
    for (const subject of ['ok\u0000x', 'ok\u000bx', 'ok\u0085Bcc: x@y.z', 'ok\u2028Bcc: x@y.z', 'tab\there']) {
      expect(codeOfThrow(() => assertValidOutboundEmail({ ...MESSAGE, subject }))).toBe('PRODUCT.BAD_REQUEST')
    }
  })

  it('refuses header injection in the subject, an empty or oversized body, and a bad recipient', () => {
    expect(codeOfThrow(() => assertValidOutboundEmail(MESSAGE))).toBe('NO_THROW')
    expect(codeOfThrow(() => assertValidOutboundEmail({ ...MESSAGE, subject: 'Hi\r\nBcc: victim@example.test' }))).toBe(
      'PRODUCT.BAD_REQUEST',
    )
    expect(codeOfThrow(() => assertValidOutboundEmail({ ...MESSAGE, subject: '' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOfThrow(() => assertValidOutboundEmail({ ...MESSAGE, subject: 'x'.repeat(EMAIL_LIMITS.subjectMax + 1) }))).toBe(
      'PRODUCT.BAD_REQUEST',
    )
    expect(codeOfThrow(() => assertValidOutboundEmail({ ...MESSAGE, text_body: '' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOfThrow(() => assertValidOutboundEmail({ ...MESSAGE, text_body: 'x'.repeat(EMAIL_LIMITS.bodyMax + 1) }))).toBe(
      'PRODUCT.BAD_REQUEST',
    )
    expect(codeOfThrow(() => assertValidOutboundEmail({ ...MESSAGE, to: 'not-an-address' }))).toBe('PRODUCT.BAD_REQUEST')
  })
})

describe('SimulatedEmailAdapter — every message lands in the outbox', () => {
  it('records to, subject, body, purpose, tenant and created_at, and reports it delivered', () => {
    const { email } = adapter()
    const receipt = email.send(MESSAGE)
    expect(receipt).toEqual({ message_ref: 'email_mail_1', accepted_at: '2027-06-01T09:00:00.000Z' })
    expect(email.recent(10)).toEqual([
      {
        message_id: 'email_mail_1',
        to: 'planner@example.test',
        subject: 'Reset your password',
        text_body: 'Follow the link to choose a new password.',
        purpose: 'password_reset',
        tenant_id: 'tenant_1',
        created_at: '2027-06-01T09:00:00.000Z',
        status: 'delivered',
      },
    ])
    expect(email.deliveryStatus(receipt.message_ref)).toBe('delivered')
    expect(email.deliveryStatus('email_never_sent')).toBe('unknown')
  })

  it('a platform mail carries no tenant key at all', () => {
    const { email } = adapter()
    email.send({ to: 'owner@example.test', subject: 'Test', text_body: 'Body', purpose: 'operator_test' })
    expect(Object.keys(email.recent(1)[0] ?? {})).not.toContain('tenant_id')
  })

  it('lists newest first, bounded by the limit', () => {
    const { email, clock } = adapter()
    for (const n of [1, 2, 3]) {
      email.send({ ...MESSAGE, subject: `Message ${n}` })
      clock.advance(1000)
    }
    expect(email.recent(2).map((m) => m.subject)).toEqual(['Message 3', 'Message 2'])
    expect(email.recent(0)).toEqual([])
  })

  it('keeps a bounded outbox: past the retention the oldest messages are deleted', () => {
    const email = new SimulatedEmailAdapter(new ManualClock('2027-06-01T09:00:00.000Z'), new SequentialIdGenerator('ret'), undefined, 3)
    for (const n of [1, 2, 3, 4, 5]) email.send({ ...MESSAGE, subject: `Message ${n}` })
    expect(email.recent(10).map((m) => m.subject)).toEqual(['Message 5', 'Message 4', 'Message 3'])
    expect(email.deliveryStatus('email_ret_1')).toBe('unknown')
  })

  it('a malformed message is refused and not recorded', () => {
    const { email } = adapter()
    expect(codeOfThrow(() => email.send({ ...MESSAGE, subject: 'a\nb' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(email.recent(10)).toEqual([])
  })

  it('redacts a link secret once it lapses: never shown after, and removed from the stored body on the next send', () => {
    const clock = new ManualClock('2027-06-01T09:00:00.000Z')
    const backing = new InMemoryRecordStore()
    const email = new SimulatedEmailAdapter(clock, new SequentialIdGenerator('sec'), backing)
    email.send({ ...MESSAGE, text_body: 'Open /t/acme/reset?token=reset_abc to continue.', secret: { value: 'reset_abc', expires_at: '2027-06-01T10:00:00.000Z' } })
    expect(email.recent(1)[0]?.text_body).toContain('reset_abc')
    expect(Object.keys(email.recent(1)[0] ?? {})).not.toContain('secret')
    clock.advance(60 * 60 * 1000)
    expect(email.recent(1)[0]?.text_body).toBe(`Open /t/acme/reset?token=${REDACTED_LINK} to continue.`)
    // The stored row still holds it until the next send rewrites it.
    email.send({ ...MESSAGE, subject: 'Later' })
    expect(JSON.stringify(backing.list(COLLECTIONS.emailOutbox, GLOBAL_PARTITION))).not.toContain('reset_abc')
  })

  it('retention is per tenant: one workspace sending a lot never pushes out another\'s messages', () => {
    const email = new SimulatedEmailAdapter(new ManualClock('2027-06-01T09:00:00.000Z'), new SequentialIdGenerator('ten'), undefined, 2)
    email.send({ ...MESSAGE, tenant_id: 'tenant_a', subject: 'A keeps this' })
    for (const n of [1, 2, 3, 4]) email.send({ ...MESSAGE, tenant_id: 'tenant_b', subject: `B ${n}` })
    expect(email.recent(10, 'tenant_a').map((m) => m.subject)).toEqual(['A keeps this'])
    expect(email.recent(10, 'tenant_b').map((m) => m.subject)).toEqual(['B 4', 'B 3'])
  })
})
