// One wording for every footer; the year follows the visitor's clock so it
// never needs updating by hand.
export function copyrightNotice(now: Date = new Date()): string {
  return `© ${now.getFullYear()} ALPS Consulting Ltd, trading as ALPS Consultancy. All rights reserved.`;
}
