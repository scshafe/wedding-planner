/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_document_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A file attached to a wedding or one of its vendors (issue #48): its metadata. The bytes are a separate record (collection document_content) under the same key, groupedKey(wedding_id, document_id).
 */
export interface WeddingDocument {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
document_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * The wedding's vendor (issue #33) the file belongs to, when it belongs to one.
 */
vendor_id?: string
title: string
kind: ("contract" | "floor_plan" | "quote" | "other")
/**
 * The uploaded file's name, without any path (the planner's reference; downloads are named from the title).
 */
filename: string
/**
 * Decided from the file's content (its signature), never from what the client declared.
 */
content_type: ("application/pdf" | "image/png" | "image/jpeg")
size_bytes: number
/**
 * The SHA-256 of the bytes, checked again on download.
 */
sha256: string
/**
 * Whether the couple sees and downloads it.
 */
shared_with_couple: boolean
/**
 * ISO 8601 UTC upload time, from the injected clock.
 */
created_at: string
/**
 * ISO 8601 UTC time of the last change, when changed.
 */
updated_at?: string
}
