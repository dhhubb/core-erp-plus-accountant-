/**
 * Parse a two-column CSV (variant_id, price) for a price-list import. A header row is skipped when
 * present. Blank lines and rows missing a column are dropped, so a hand-edited file does not fail
 * the whole import on one stray line.
 */
export function parsePriceCsv(text: string): Array<{ variant_id: string; price: string }> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^variant_id\s*,\s*price$/i.test(line))
    .map((line) => {
      const [variantId, price] = line.split(',');
      return { variant_id: (variantId ?? '').trim(), price: (price ?? '').trim() };
    })
    .filter((row) => row.variant_id.length > 0 && row.price.length > 0);
}
