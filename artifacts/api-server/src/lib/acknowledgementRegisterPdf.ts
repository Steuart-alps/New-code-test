interface RegisterRow {
  staffName: string;
  signature: string;
  acknowledgedAt: string;
  status: "Acknowledged" | "Outstanding";
}

export interface AcknowledgementRegister {
  title: string;
  category: string;
  generatedAt: string;
  dateRange: string;
  rows: RegisterRow[];
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

function pageContent(register: AcknowledgementRegister, rows: RegisterRow[], page: number, totalPages: number): string {
  const commands: string[] = [
    text(50, 790, 18, "Document Acknowledgement Register", true),
    text(50, 765, 11, `Document: ${truncate(register.title, 80)}`, true),
    text(50, 748, 10, `Category: ${register.category}`),
    text(50, 733, 10, `Acknowledgement date range: ${register.dateRange}`),
    text(50, 718, 10, `Generated: ${register.generatedAt}`),
    "0.85 0.85 0.85 RG 50 700 495 0 re S",
    text(52, 682, 9, "Staff member", true),
    text(240, 682, 9, "Typed signature", true),
    text(390, 682, 9, "Date acknowledged", true),
    text(490, 682, 9, "Status", true),
  ];

  let y = 663;
  for (const row of rows) {
    commands.push(
      "0.9 0.9 0.9 RG 50 " + (y - 5) + " 495 0 re S",
      text(52, y, 8, truncate(row.staffName, 35)),
      text(240, y, 8, truncate(row.signature, 27)),
      text(390, y, 8, row.acknowledgedAt),
      text(490, y, 8, row.status, row.status === "Outstanding"),
    );
    y -= 22;
  }

  commands.push(
    "0.85 0.85 0.85 RG 50 48 495 0 re S",
    text(50, 32, 8, "Generated for audit purposes"),
    text(470, 32, 8, `Page ${page} of ${totalPages}`),
  );
  return commands.join("\n");
}

export function createAcknowledgementRegisterPdf(register: AcknowledgementRegister): Buffer {
  const rowsPerPage = 27;
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
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
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