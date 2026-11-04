/**
 * Old Word files (.doc, Word 97-2003), read in the browser for imports. The
 * text comes from the document's piece table ([MS-DOC] 2.4.1); a table's
 * cells end in a cell mark and each row in a row mark, both character 7.
 */
import * as XLSX from "@e965/xlsx";

const SAVE_AS_DOCX = "In Word, choose File > Save As > Word Document (.docx), then upload that.";

export class WordDocError extends Error {}

/** The parts of SheetJS's (untyped) compound-file reader used here. */
interface CompoundFile { FullPaths: string[]; FileIndex: Array<{ content?: ArrayLike<number> }> }

function stream(cfb: CompoundFile, name: string): Uint8Array | null {
  const index = cfb.FullPaths.findIndex(path => path.replace(/\/$/, "").split("/").pop() === name);
  const content = index >= 0 ? cfb.FileIndex[index]?.content : null;
  return content ? new Uint8Array(content) : null;
}

/** The main text of a .doc file, with Word's control characters still in it. */
export function oldWordText(data: Uint8Array): string {
  let cfb: CompoundFile;
  try {
    cfb = XLSX.CFB.read(data, { type: "array" }) as CompoundFile;
  } catch {
    throw new WordDocError(`This Word file could not be read. ${SAVE_AS_DOCX}`);
  }
  const doc = stream(cfb, "WordDocument");
  if (!doc || doc.length < 0x200) throw new WordDocError(`This Word file could not be read. ${SAVE_AS_DOCX}`);
  const fib = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  if (fib.getUint16(0, true) !== 0xA5EC || fib.getUint16(2, true) < 0xC1) {
    throw new WordDocError(`This Word file is from an older version of Word that can't be read here. ${SAVE_AS_DOCX}`);
  }
  const flags = fib.getUint16(0x0A, true);
  if (flags & 0x0100) throw new WordDocError(`This Word file is password protected. Remove the password, or ${SAVE_AS_DOCX[0].toLowerCase()}${SAVE_AS_DOCX.slice(1)}`);
  const table = stream(cfb, flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw new WordDocError(`This Word file could not be read. ${SAVE_AS_DOCX}`);

  // The FIB: a 32-byte base, then counted blocks of 16-bit and 32-bit values,
  // then the file offset / length pairs. ccpText is the 4th 32-bit value and
  // the piece table (Clx) the 34th pair.
  let pos = 32;
  pos += 2 + fib.getUint16(pos, true) * 2;
  const longs = pos + 2;
  const ccpText = fib.getInt32(longs + 12, true);
  pos += 2 + fib.getUint16(pos, true) * 4;
  const pairs = pos + 2;
  const fcClx = fib.getUint32(pairs + 33 * 8, true);
  const lcbClx = fib.getUint32(pairs + 33 * 8 + 4, true);
  if (fcClx + lcbClx > table.length || ccpText < 0) throw new WordDocError(`This Word file could not be read. ${SAVE_AS_DOCX}`);

  const clx = new DataView(table.buffer, table.byteOffset + fcClx, lcbClx);
  let at = 0;
  while (at < lcbClx && clx.getUint8(at) === 1) at += 3 + clx.getUint16(at + 1, true);
  if (at >= lcbClx || clx.getUint8(at) !== 2) throw new WordDocError(`This Word file could not be read. ${SAVE_AS_DOCX}`);
  const plc = at + 5;
  const pieces = (clx.getUint32(at + 1, true) - 4) / 12;
  const ansi = new TextDecoder("windows-1252");
  const unicode = new TextDecoder("utf-16le");
  let text = "";
  for (let i = 0; i < pieces; i++) {
    const cpStart = clx.getUint32(plc + i * 4, true);
    const cpEnd = Math.min(clx.getUint32(plc + (i + 1) * 4, true), ccpText);
    if (cpEnd <= cpStart) continue;
    const raw = clx.getUint32(plc + (pieces + 1) * 4 + i * 8 + 2, true);
    const compressed = (raw & 0x40000000) !== 0;
    const fc = raw & 0x3FFFFFFF;
    const count = cpEnd - cpStart;
    text += compressed
      ? ansi.decode(doc.subarray(fc / 2, fc / 2 + count))
      : unicode.decode(doc.subarray(fc, fc + count * 2));
  }
  // Fields: keep what Word shows (the result), not the field code.
  let previous;
  do {
    previous = text;
    text = text.replace(/\x13[^\x13\x14\x15]*(?:\x14([^\x13\x15]*))?\x15/g, (_match, shown: string | undefined) => shown ?? "");
  } while (text !== previous);
  return text.replace(/\x1e/g, "-").replace(/[\x1f\x01\x08]/g, "").replace(/ /g, " ");
}

/**
 * Rows from a .doc file: its first table, one row per record; or, with no
 * table, the lines of text. Cell and row marks are both character 7, so the
 * heading row (which has no blank cells) sets how many cells each row has.
 */
export function oldWordRows(text: string): { table: string[][] | null; lines: string } {
  const cell = (value: string) => value.replace(/[\r\x0b\x0c]/g, " ").replace(/\s+/g, " ").trim();
  const first = text.indexOf("\x07");
  if (first >= 0) {
    const marks = text.slice(text.lastIndexOf("\r", first) + 1).split("\x07");
    const columns = marks.findIndex((value, index) => index > 0 && value === "");
    if (columns > 0) {
      const rows: string[][] = [];
      for (let at = 0; at + columns < marks.length && marks[at + columns] === ""; at += columns + 1) {
        rows.push(marks.slice(at, at + columns).map(cell));
      }
      return { table: rows.filter(row => row.some(Boolean)), lines: "" };
    }
  }
  return { table: null, lines: text.replace(/[\r\x0b\x0c]/g, "\n") };
}

/** A .doc file as plain text, for the AI list reader (which can't open .doc itself). */
export function oldWordPlainText(data: Uint8Array): string {
  const { table, lines } = oldWordRows(oldWordText(data));
  return table ? table.map(row => row.join("\t")).join("\n") : lines;
}
