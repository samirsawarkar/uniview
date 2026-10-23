/** Format bytes as classic hex dump rows: offset, 16 hex bytes, ASCII. */
export function hexRows(bytes: Uint8Array, baseOffset = 0): string[] {
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, i + 16);
    let hex = "";
    let text = "";
    for (let j = 0; j < 16; j++) {
      if (j < chunk.length) {
        const c = chunk[j]!;
        hex += c.toString(16).padStart(2, "0") + " ";
        text += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
      } else {
        hex += "   ";
      }
      if (j === 7) hex += " ";
    }
    rows.push(`${(baseOffset + i).toString(16).padStart(8, "0")}  ${hex} |${text}|`);
  }
  return rows;
}
