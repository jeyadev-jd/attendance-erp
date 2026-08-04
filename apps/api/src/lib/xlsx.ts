// Thin wrapper around SheetJS (works on Workers with nodejs_compat) — turns a
// plain header+rows table into an .xlsx file buffer, and CSV text into rows.
import * as XLSX from "xlsx";

export function buildXlsx(header: string[], rows: (string | number | null)[][]): Uint8Array {
  const worksheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Report");
  const out = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Uint8Array(out);
}

export function rowsToCsv(header: string[], rows: (string | number | null)[][]): string {
  const escape = (v: string | number | null) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
}
