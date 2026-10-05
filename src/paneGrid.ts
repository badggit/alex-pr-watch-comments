// The pane grid of a window: as many columns as rows or one more, filled row by row, and the panes of a short last
// row share its full width. 2 panes sit side by side, 3 are two above one, 4 a 2x2 grid, 5 three above two. tmux's
// own tiled layout prefers rows instead and stacks 2 panes on top of each other.

// Every pane keeps at least this many cells in each direction, or the grid is not applied.
const MIN_CELLS = 2;

// The number of panes in each row, top to bottom.
export function gridRows(count: number): number[] {
    if (count < 1) {
        return [];
    }
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    return Array.from({ length: rows }, (_, row) => Math.min(columns, count - row * columns));
}

// Splits total cells into parts separated by one-cell borders, the remainder going to the last parts.
function spans(total: number, parts: number): { offset: number; size: number }[] {
    const free = total - (parts - 1);
    const base = Math.floor(free / parts);
    const extra = free % parts;
    let offset = 0;
    return Array.from({ length: parts }, (_, index) => {
        const size = base + (index >= parts - extra ? 1 : 0);
        const span = { offset, size };
        offset += size + 1;
        return span;
    });
}

// tmux's layout checksum: a 16-bit rotate-right-and-add over the layout text.
export function layoutChecksum(layout: string): string {
    let sum = 0;
    for (const char of layout) {
        sum = ((sum >> 1) + ((sum & 1) << 15) + (char.codePointAt(0) ?? 0)) & 0xff_ff;
    }
    return sum.toString(16).padStart(4, '0');
}

// A select-layout string for count panes in a width x height window, or undefined when the grid does not fit. tmux
// hands the cells to the window's panes in pane index order and ignores the pane numbers written in the leaves.
export function gridLayout(count: number, width: number, height: number): string | undefined {
    const rows = gridRows(count);
    const columns = rows[0] ?? 0;
    if (count < 2 || width < columns * (MIN_CELLS + 1) || height < rows.length * (MIN_CELLS + 1)) {
        return;
    }
    let pane = 0;
    const rowCells = spans(height, rows.length).map((row, rowIndex) => {
        const cells = spans(width, rows[rowIndex] ?? 1).map((cell) => {
            const leaf = `${cell.size}x${row.size},${cell.offset},${row.offset},${pane}`;
            pane += 1;
            return leaf;
        });
        if (cells.length === 1) {
            return cells[0] ?? '';
        }
        return `${width}x${row.size},0,${row.offset}{${cells.join(',')}}`;
    });
    // A single row already spans the whole window, so it is the root as it is.
    const layout = rowCells.length === 1 ? (rowCells[0] ?? '') : `${width}x${height},0,0[${rowCells.join(',')}]`;
    return `${layoutChecksum(layout)},${layout}`;
}
