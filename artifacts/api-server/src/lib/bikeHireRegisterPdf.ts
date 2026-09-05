export interface BikeHireRegisterRow {
  guestName: string;
  guestContact: string;
  bikeRef: string;
  hireDate: string;
  returnDate: string;
  preCheckResult: string;
  postCheckResult: string;
  deposit: string;
  notes: string;
}

export interface BikeHireRegister {
  from: string;
  to: string;
  generatedAt: string;
  rows: BikeHireRegisterRow[];
}

function pdfText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function text(x: number, y: number, size: number, value: string, bold = false): string {
  return `BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${pdfText(value)}) Tj ET`;
}

function pageContent(register: BikeHireRegister, rows: BikeHireRegisterRow[], page: number, totalPages: number): string {
  const commands = [
    text(32, 565, 17, "Bike Hire Register", true),
    text(32, 545, 9, `Hire date range: ${register.from} to ${register.to}`),
    text(32, 531, 9, `Generated: ${register.generatedAt}    Total hires: ${register.rows.length}`),
    "0.82 0.82 0.82 RG 32 516 778 0 re S",
    text(34, 501, 7, "Guest", true),
    text(126, 501, 7, "Contact", true),
    text(218, 501, 7, "Bike", true),
    text(268, 501, 7, "Hire", true),
    text(322, 501, 7, "Return", true),
    text(376, 501, 7, "Pre", true),
    text(412, 501, 7, "Post", true),
    text(448, 501, 7, "Deposit", true),
    text(502, 501, 7, "Notes", true),
  ];

  let y = 484;
  for (const row of rows) {
    commands.push(
      `0.9 0.9 0.9 RG 32 ${y - 5} 778 0 re S`,
      text(34, y, 7, truncate(row.guestName, 20)),
      text(126, y, 7, truncate(row.guestContact, 20)),
      text(218, y, 7, truncate(row.bikeRef, 10)),
      text(268, y, 7, row.hireDate),
      text(322, y, 7, row.returnDate),
      text(376, y, 7, row.preCheckResult),
      text(412, y, 7, row.postCheckResult),
      text(448, y, 7, row.deposit),
      text(502, y, 7, truncate(row.notes, 66)),
    );
    y -= 18;
  }

  commands.push(
    "0.82 0.82 0.82 RG 32 30 778 0 re S",
    text(32, 17, 7, "Generated for insurance and liability records"),
    text(748, 17, 7, `Page ${page} of ${totalPages}`),
  );
  return commands.join("\n");
}

export function createBikeHireRegisterPdf(register: BikeHireRegister): Buffer {
  const rowsPerPage = 25;
  const pages = Array.from(
    { length: Math.max(1, Math.ceil(register.rows.length / rowsPerPage)) },
    (_, index) => register.rows.slice(index * rowsPerPage, (index + 1) * rowsPerPage),
  );
  const objects: string[] = [];
  const addObject = (value: string) => {
    objects.push(value);
    return objects.length;
  };
  const catalogId = addObject("");
  const pagesId = addObject("");
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const boldFontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds: number[] = [];

  pages.forEach((pageRows, index) => {
    const content = pageContent(register, pageRows, index + 1, pages.length);
    const contentId = addObject(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    pageIds.push(addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
  });

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output);
}