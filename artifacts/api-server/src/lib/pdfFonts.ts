import { existsSync } from "node:fs";

// DejaVu covers the symbols our PDFs print (°C, £, ✓). Hosts without the
// fonts-dejavu package fall back to PDFKit's built-in Helvetica, so a missing
// font file degrades the typeface instead of failing every PDF download.
const DEJAVU_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const DEJAVU_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const hasDejaVu = existsSync(DEJAVU_REGULAR) && existsSync(DEJAVU_BOLD);

export const PDF_REGULAR_FONT = hasDejaVu ? DEJAVU_REGULAR : "Helvetica";
export const PDF_BOLD_FONT = hasDejaVu ? DEJAVU_BOLD : "Helvetica-Bold";
