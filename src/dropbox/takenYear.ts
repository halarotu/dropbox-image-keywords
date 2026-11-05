/** Where an image's `takenYear` came from. */
export type TakenYearSource =
  | "filename" // a date in the file name, e.g. "2016-05-04 12.34.56.jpg" or "IMG_20160504_…"
  | "folder" //   a folder named after a year, e.g. "/Photos/2016/…" or "/Photos/2016-07 Lapland/…"
  | "default"; // nothing found: the year the record was written

export interface TakenYear {
  year: number;
  source: TakenYearSource;
}

/** Years outside [MIN_YEAR, current year] are treated as noise (project numbers, ids, …). */
export const MIN_YEAR = 1990;

/** YYYY[-_.]MM[-_.]DD not surrounded by other digits. Covers Camera Uploads, IMG_/PXL_/VID_, screenshots. */
const FILENAME_DATE = /(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/g;

/** A folder name that is, or starts with, a year: "2016", "2016-07 Lapland", "2016 Summer". */
const FOLDER_YEAR = /^((?:19|20)\d{2})(?!\d)/;

/**
 * Best guess of the year a photo was taken, from its path and file name only:
 * a date in the file name, else the deepest year-named folder, else the current year.
 */
export function deriveTakenYear(path: string, name: string, now: Date = new Date()): TakenYear {
  const currentYear = now.getUTCFullYear();
  const plausible = (y: number) => y >= MIN_YEAR && y <= currentYear;

  for (const m of name.matchAll(FILENAME_DATE)) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (plausible(year) && isValidDate(year, month, day)) return { year, source: "filename" };
  }

  // Folders only: the last path segment is the file itself.
  const folders = path.split("/").filter(Boolean).slice(0, -1);
  for (let i = folders.length - 1; i >= 0; i--) {
    const m = FOLDER_YEAR.exec(folders[i]);
    if (m && plausible(Number(m[1]))) return { year: Number(m[1]), source: "folder" };
  }

  return { year: currentYear, source: "default" };
}

function isValidDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
