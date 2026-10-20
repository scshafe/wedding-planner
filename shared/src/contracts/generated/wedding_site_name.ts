/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_site_name_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The index of site names in a workspace (issue #47): keyed by the site name, naming the wedding whose site holds it — so a name is unique in the workspace, and the public page finds its wedding by name.
 */
export interface WeddingSiteName {
tenant_id: string
site_name: string
wedding_id: string
}
