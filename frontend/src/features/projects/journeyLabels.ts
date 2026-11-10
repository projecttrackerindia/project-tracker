/**
 * Where each stage name sits under the journey line so that no two names ever overlap.
 *
 * Stages are drawn in proportion to their dates, so a short stage is a few pixels wide and its name (centred on it) would sit on top of its
 * neighbours'. Instead of shrinking every name, names that would touch are put on the next row down, left to right, each on the first row with
 * room. A name is also kept inside the line, so the first and last never hang off the card. Pure and measured in pixels, so it is testable.
 */
export interface LabelBox {
  /** Where the stage is centred, in pixels from the left of the line. */
  center: number;
  /** How wide the name is drawn, in pixels. */
  width: number;
}

export interface LabelSpot {
  /** 0 is the row nearest the line. */
  row: number;
  /** Pixels to move the name from the centre of its stage (negative: left). */
  shift: number;
}

/** A name's drawn width: about 7.7px a character at 14.5px, plus its padding and the tick/check mark. */
export const labelWidth = (text: string) => Math.min(190, Math.ceil(text.length * 7.7) + 26);

/** The gap kept between two names on one row. */
const GAP = 8;

export function layoutLabels(boxes: LabelBox[], lineWidth: number, maxRows = 4): LabelSpot[] {
  const rowRight: number[] = [];       // the right edge of the last name on each row
  return boxes.map((b) => {
    const half = b.width / 2;
    // keep the name inside the line (a name wider than the line is simply left at the edge)
    const centre = lineWidth > b.width ? Math.min(Math.max(b.center, half), lineWidth - half) : b.center;
    const left = centre - half;
    let row = rowRight.findIndex((right) => right + GAP <= left);
    if (row < 0) row = rowRight.length < maxRows ? rowRight.length : rowRight.indexOf(Math.min(...rowRight));
    rowRight[row] = Math.max(rowRight[row] ?? -Infinity, centre + half);
    return { row, shift: Math.round(centre - b.center) };
  });
}
