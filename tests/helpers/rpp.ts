/**
 * Tiny test helper for slice 8+: wrap raw decision text in a minimal
 * valid R++ document. Slice 5 and 6 tests carry text patterns that
 * still need to trip the substrate's text-based law checks; this
 * helper makes them R++-parseable without changing the inner text.
 */
export function rppDecision(text: string): string {
  return `TARGET { output: "decision" }\nBEHAVIOR Decide {\n  ${text}\n}\n`;
}
