// Builds docs/user-guide/RoomOps-User-Guide.docx from USER_GUIDE.md.
//
//   npm run docs:guide
//
// Supported Markdown: "#", "##", "###" headings, paragraphs with **bold** and
// *italic*, "- " bullet lists, "1. " numbered lists, pipe tables, images
// (two images on one line are shown side by side), "> " tip boxes and
// "<!-- pagebreak -->". Keep the guide within that subset.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, ImageRun,
  LevelFormat, Packer, PageBreak, PageNumber, Paragraph, ShadingType, Table,
  TableCell, TableOfContents, TableRow, TextRun, WidthType,
} from "docx";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "USER_GUIDE.md");
const OUTPUT = join(here, "RoomOps-User-Guide.docx");

// Living Waters Methodist Church palette (matches app/globals.css).
const NAVY = "265784";
const SKY = "4280CF";
const SOFT = "EEF4FA";
const LINE = "D5DFEA";
const MUTED = "5D6874";
const FONT = "Calibri";

// A4 with 1" margins leaves 9026 DXA (6.27") of text width.
const TEXT_WIDTH_DXA = 9026;
const FULL_WIDTH_PX = 600; // docx ImageRun sizes are in 96-dpi pixels
const PHONE_WIDTH_PX = 250;
const MAX_HEIGHT_PX = 560;
const MAX_WIDE_HEIGHT_PX = 760;

function imageSize(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: "png" };
  }
  let offset = 2;
  while (offset < buffer.length) {
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), type: "jpg" };
    }
    offset += 2 + length;
  }
  throw new Error("Unsupported image format");
}

function inlineRuns(text, base = {}) {
  const runs = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) runs.push(new TextRun({ text: text.slice(last, match.index), ...base }));
    const token = match[0];
    runs.push(token.startsWith("**")
      ? new TextRun({ text: token.slice(2, -2), bold: true, ...base })
      : new TextRun({ text: token.slice(1, -1), italics: true, ...base }));
    last = match.index + token.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), ...base }));
  return runs;
}

function fitImage(size, maxWidth, maxHeight) {
  let width = Math.min(maxWidth, size.width);
  let height = Math.round((size.height * width) / size.width);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round((size.width * height) / size.height);
  }
  return { width, height };
}

function imageRun(path, maxWidth) {
  const data = readFileSync(join(here, path));
  const size = imageSize(data);
  // Phone screens and emails are much taller than wide; show them at phone size.
  const phone = size.height / size.width > 1.6;
  const box = fitImage(size, phone ? Math.min(maxWidth, PHONE_WIDTH_PX) : maxWidth, phone ? MAX_HEIGHT_PX : MAX_WIDE_HEIGHT_PX);
  return new ImageRun({ type: size.type, data, transformation: box, altText: { title: path, description: path, name: path } });
}

const caption = (text) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 60, after: 240 },
  children: [new TextRun({ text, italics: true, size: 18, color: MUTED })],
});

const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder };

function images(line) {
  const found = [...line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((m) => ({ alt: m[1], path: m[2] }));
  if (found.length === 1) {
    return [
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, keepNext: true, children: [imageRun(found[0].path, FULL_WIDTH_PX)] }),
      caption(found[0].alt),
    ];
  }
  const cellWidth = Math.floor(TEXT_WIDTH_DXA / found.length);
  return [new Table({
    width: { size: TEXT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: found.map(() => cellWidth),
    borders: noBorders,
    rows: [new TableRow({ cantSplit: true, children: found.map((item) => new TableCell({
      width: { size: cellWidth, type: WidthType.DXA },
      borders: noBorders,
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, children: [imageRun(item.path, PHONE_WIDTH_PX)] }),
        caption(item.alt),
      ],
    })) })],
  }), new Paragraph({ spacing: { after: 120 }, children: [] })];
}

function table(lines) {
  const rows = lines
    .filter((line) => !/^\|\s*-{3}/.test(line))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  const columns = rows[0].length;
  // Size columns by their longest cell, within sensible bounds.
  const weights = Array.from({ length: columns }, (_, c) =>
    Math.min(60, Math.max(14, ...rows.map((row) => (row[c] ?? "").length))));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.floor((w / total) * TEXT_WIDTH_DXA));
  widths[widths.length - 1] += TEXT_WIDTH_DXA - widths.reduce((a, b) => a + b, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  return new Table({
    width: { size: TEXT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map((row, r) => new TableRow({
      tableHeader: r === 0,
      cantSplit: true,
      children: row.map((cell, c) => new TableCell({
        width: { size: widths[c], type: WidthType.DXA },
        shading: r === 0 ? { type: ShadingType.CLEAR, color: "auto", fill: SOFT } : undefined,
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: inlineRuns(cell, r === 0 ? { bold: true, color: NAVY, size: 20 } : { size: 20 }) })],
      })),
    })),
  });
}

function tip(text) {
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, color: "auto", fill: SOFT },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: NAVY, space: 8 } },
    spacing: { before: 160, after: 200 },
    indent: { left: 160, right: 160 },
    children: inlineRuns(text),
  });
}

function build(markdown) {
  const lines = markdown.split("\n");
  const body = [];
  let listInstance = 0;
  let listKind = null;
  let isFirstHeading = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const bullet = /^- (.*)/.exec(trimmed);
    const numbered = /^\d+\. (.*)/.exec(trimmed);
    if (!bullet && !numbered) listKind = null;
    if (!trimmed) continue;
    if (trimmed === "<!-- pagebreak -->") { body.push(new Paragraph({ children: [new PageBreak()] })); continue; }
    if (trimmed.startsWith("# ")) {
      body.push(new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 120 }, children: [new TextRun({ text: trimmed.slice(2), bold: true, color: NAVY, size: 56 })] }));
      continue;
    }
    if (trimmed.startsWith("## ")) {
      if (isFirstHeading) {
        // Contents page before the first section. Word fills it in on open.
        // Styled like a heading but not one, so it doesn't list itself.
        body.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "Contents", bold: true, size: 34, color: NAVY })] }));
        body.push(new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }));
        body.push(new Paragraph({ children: [new PageBreak()] }));
        isFirstHeading = false;
      }
      body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, children: [new TextRun(trimmed.slice(3))] }));
      continue;
    }
    if (trimmed.startsWith("### ")) { body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun(trimmed.slice(4))] })); continue; }
    if (trimmed.startsWith("![")) { body.push(...images(trimmed)); continue; }
    if (trimmed.startsWith("|")) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) block.push(lines[i++]);
      i--;
      body.push(table(block), new Paragraph({ spacing: { after: 120 }, children: [] }));
      continue;
    }
    if (trimmed.startsWith("> ")) { body.push(tip(trimmed.slice(2))); continue; }
    if (bullet) {
      body.push(new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 60 }, children: inlineRuns(bullet[1]) }));
      continue;
    }
    if (numbered) {
      if (listKind !== "numbered") { listInstance += 1; listKind = "numbered"; }
      body.push(new Paragraph({ numbering: { reference: "numbers", level: 0, instance: listInstance }, spacing: { after: 60 }, children: inlineRuns(numbered[1]) }));
      continue;
    }
    // A bold-only line is a small subheading that should stay with what follows.
    const label = /^\*\*[^*]+\*\*$/.test(trimmed);
    body.push(new Paragraph({ keepNext: label, spacing: { before: label ? 200 : 0, after: 120 }, children: inlineRuns(trimmed, label ? { color: NAVY } : {}) }));
  }
  return body;
}

const doc = new Document({
  creator: "RoomOps",
  title: "Room Booking User Guide",
  description: "Plain-language guide to the Living Waters Methodist Church room booking system",
  features: { updateFields: true },
  styles: {
    default: { document: { run: { font: FONT, size: 22 }, paragraph: { spacing: { line: 300 } } } },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", run: { font: FONT, size: 56, bold: true, color: NAVY } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: 34, bold: true, color: NAVY },
        paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 4 } } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: 26, bold: true, color: SKY }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Room Booking User Guide · Living Waters Methodist Church", size: 16, color: MUTED })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16, color: MUTED }),
    ] })] }) },
    children: build(readFileSync(SOURCE, "utf8")),
  }],
});

writeFileSync(OUTPUT, await Packer.toBuffer(doc));
console.log(`Wrote ${OUTPUT}`);
