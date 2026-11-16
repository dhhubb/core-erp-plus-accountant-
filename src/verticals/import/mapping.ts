/**
 * Column mapping for the migration wizard.
 *
 * A Pastel export names its columns however the shop's Pastel was configured. The wizard maps each
 * source column to one of our fields, saves that mapping per shop, and reuses it next time. This
 * module is pure: the mapping is data, and `applyMapping` turns a parsed CSV row into the JSON the
 * staging table stores.
 */

export type ImportKind = 'products' | 'customers' | 'opening_stock';

export const IMPORT_KINDS: readonly ImportKind[] = ['products', 'customers', 'opening_stock'];

export interface ImportFieldSpec {
  /** The field name in `import_rows.data`. */
  field: string;
  label: string;
  required: boolean;
  hint?: string;
}

/**
 * The fields each kind accepts. Required fields are the ones validation rejects a row for when
 * they are empty; the rest are optional and simply absent from the staged row.
 */
export const IMPORT_FIELDS: Record<ImportKind, readonly ImportFieldSpec[]> = {
  products: [
    { field: 'external_code', label: 'Pastel code', required: true, hint: 'The idempotency key' },
    { field: 'name', label: 'Description', required: true },
    { field: 'sku', label: 'Stock code', required: false, hint: 'Defaults to a generated SKU' },
    { field: 'barcode', label: 'Barcode', required: false },
    { field: 'unit', label: 'Unit', required: false, hint: 'each, kg, g, l, ml, pack' },
    { field: 'price', label: 'Selling price', required: false, hint: 'Lands in the retail list' },
    { field: 'cost', label: 'Cost', required: false, hint: 'Recorded for reference' },
  ],
  customers: [
    { field: 'external_code', label: 'Pastel code', required: true, hint: 'The idempotency key' },
    { field: 'name', label: 'Name', required: true },
    { field: 'email', label: 'Email', required: false },
    { field: 'phone', label: 'Telephone', required: false },
    { field: 'kind', label: 'Account type', required: false, hint: 'customer, supplier, both' },
  ],
  opening_stock: [
    { field: 'external_code', label: 'Pastel code', required: false, hint: 'Or map the SKU' },
    { field: 'sku', label: 'Stock code', required: false, hint: 'Or map the Pastel code' },
    { field: 'warehouse_code', label: 'Warehouse', required: false, hint: 'Defaults to the branch' },
    { field: 'qty', label: 'Quantity', required: true },
    { field: 'unit_cost', label: 'Unit cost', required: false, hint: 'Defaults to 0' },
  ],
};

/** One saved mapping: source column header -> our field. */
export type ColumnMapping = Record<string, string>;

export function fieldSpec(kind: ImportKind, field: string): ImportFieldSpec | undefined {
  return IMPORT_FIELDS[kind].find((spec) => spec.field === field);
}

export function requiredFields(kind: ImportKind): readonly string[] {
  return IMPORT_FIELDS[kind].filter((spec) => spec.required).map((spec) => spec.field);
}

/**
 * Validate a mapping against the kind's fields: every target must be a known field, no two source
 * columns may target the same field, and every required field must be mapped.
 */
export function validateMapping(kind: ImportKind, mapping: ColumnMapping): string[] {
  const errors: string[] = [];
  const targets = new Set<string>();

  for (const [source, target] of Object.entries(mapping)) {
    if (!target) continue;
    if (!fieldSpec(kind, target)) {
      errors.push(`column "${source}" maps to unknown field "${target}"`);
      continue;
    }
    if (targets.has(target)) {
      errors.push(`field "${target}" is mapped from more than one column`);
    }
    targets.add(target);
  }

  for (const required of requiredFields(kind)) {
    if (!targets.has(required)) {
      errors.push(`required field "${required}" is not mapped`);
    }
  }

  return errors;
}

/** A parsed row from the file: the raw header -> value record. */
export type SourceRow = Record<string, string | undefined>;

/**
 * Apply a mapping to a source row, producing the staged row's data. Empty strings become absent
 * keys, so validation sees a missing field rather than an empty one and the UI shows a blank.
 */
export function applyMapping(mapping: ColumnMapping, row: SourceRow): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [source, target] of Object.entries(mapping)) {
    if (!target) continue;
    const value = row[source];
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (trimmed === '') continue;
    data[target] = trimmed;
  }
  return data;
}

/**
 * The idempotency key the row is deduped on. Only opening stock has one (product + warehouse);
 * products and customers are deduped by their external key, so this returns null for them.
 */
export function naturalKey(kind: ImportKind, data: Record<string, string>): string | null {
  if (kind !== 'opening_stock') return null;
  const product = data['external_code'] ?? data['sku'] ?? '';
  const warehouse = data['warehouse_code'] ?? 'default';
  return `opening_stock:${product}@${warehouse}`;
}

/**
 * Common Pastel export headings for each field, so the wizard can guess a mapping on upload.
 * A shop that used different headings still maps by hand; this only saves the common case.
 */
const FIELD_ALIASES: Record<string, readonly string[]> = {
  external_code: ['stockcode', 'code', 'itemcode', 'productcode', 'customercode', 'accountcode', 'suppliercode'],
  name: ['description', 'stockdescription', 'itemdescription', 'customername', 'accountname', 'name'],
  sku: ['stockcode', 'sku', 'itemcode'],
  barcode: ['barcode', 'barcodeno', 'ean'],
  unit: ['unitofmeasure', 'uom', 'unit', 'stockunit'],
  price: ['sellingprice', 'price', 'sellprice', 'listprice', 'unitprice'],
  cost: ['costprice', 'cost', 'averagecost', 'lastcost'],
  email: ['email', 'emailaddress'],
  phone: ['telephone', 'phone', 'tel', 'cell', 'mobile'],
  kind: ['accounttype', 'type', 'customertype'],
  warehouse_code: ['warehouse', 'warehousecode', 'store', 'location'],
  qty: ['quantity', 'qty', 'onhand', 'stockonhand', 'balance'],
  unit_cost: ['unitcost', 'cost', 'costprice', 'averagecost'],
};

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A suggested mapping: our field name or a common Pastel heading matched against the headers. */
export function suggestMapping(kind: ImportKind, headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  for (const header of headers) {
    const key = normalise(header);
    const match = IMPORT_FIELDS[kind].find((spec) => {
      if (used.has(spec.field)) return false;
      if (normalise(spec.field) === key) return true;
      if (normalise(spec.label) === key) return true;
      const aliases = FIELD_ALIASES[spec.field] ?? [];
      return aliases.includes(key);
    });
    if (match) {
      mapping[header] = match.field;
      used.add(match.field);
    }
  }
  return mapping;
}
