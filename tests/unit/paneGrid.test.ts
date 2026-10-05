import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { gridLayout, gridRows, layoutChecksum } from '../../src/paneGrid.ts';

await describe('gridRows', async () => {
    await test('columns first, a short last row', () => {
        const shapes = [1, 2, 3, 4, 5, 6, 7, 9, 10].map((count) => gridRows(count));
        assert.deepEqual(shapes, [[1], [2], [2, 1], [2, 2], [3, 2], [3, 3], [3, 3, 1], [3, 3, 3], [4, 4, 2]]);
    });

    await test('no panes give no rows', () => {
        assert.deepEqual(gridRows(0), []);
    });
});

await describe('layoutChecksum', async () => {
    await test('matches the checksum tmux prints for a layout', () => {
        // The #{window_layout} of an even-horizontal 200x50 window of two panes on tmux 3.4.
        assert.equal(layoutChecksum('200x50,0,0{99x50,0,0,0,100x50,100,0,1}'), '1af1');
    });
});

await describe('gridLayout', async () => {
    await test('two panes side by side', () => {
        assert.equal(gridLayout(2, 200, 50), '1af1,200x50,0,0{99x50,0,0,0,100x50,100,0,1}');
    });

    await test('three panes: two above, one full-width below', () => {
        assert.equal(gridLayout(3, 200, 50), '4efd,200x50,0,0[200x24,0,0{99x24,0,0,0,100x24,100,0,1},200x25,0,25,2]');
    });

    await test('four panes: a 2x2 grid', () => {
        assert.equal(
            gridLayout(4, 200, 50),
            '543c,200x50,0,0[200x24,0,0{99x24,0,0,0,100x24,100,0,1},200x25,0,25{99x25,0,25,2,100x25,100,25,3}]'
        );
    });

    await test('one pane or a window too small for the grid gives undefined', () => {
        assert.equal(gridLayout(1, 200, 50), undefined);
        assert.equal(gridLayout(4, 5, 50), undefined);
        assert.equal(gridLayout(3, 200, 5), undefined);
    });
});
