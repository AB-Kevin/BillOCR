// Ported from 837-claim-viewer's src/render/text.ts -- deliberately just the
// two pure, dependency-free helpers x12ClaimSource.ts needs (composeName),
// not that file's PDF-export text-fitting/font-embedding code (which pulls
// in pdf-lib/@pdf-lib/fontkit and Node's fs -- irrelevant until/unless a
// later pass ports PDF export too). See BillOCR's own render/text.ts note.

export function composeName(name: { last: string; first: string; middle: string }): string {
  const parts: string[] = [];
  if (name.last !== "") parts.push(name.last);
  const firstMiddle = [name.first, name.middle].filter((p) => p !== "").join(" ");
  if (parts.length > 0 && firstMiddle !== "") {
    return `${parts[0]}, ${firstMiddle}`;
  }
  if (parts.length > 0) return parts[0]!;
  return firstMiddle;
}

/** Composes a single-line "line1 line2, city, state zip" address, skipping missing parts. */
export function composeAddressLine(addr: { line1: string; line2: string; city: string; state: string; zip: string }): string {
  const streetParts = [addr.line1, addr.line2].filter((p) => p !== "");
  const cityStateZip = [addr.city, [addr.state, addr.zip].filter((p) => p !== "").join(" ")]
    .filter((p) => p !== "")
    .join(", ");
  return [streetParts.join(" "), cityStateZip].filter((p) => p !== "").join(", ");
}
