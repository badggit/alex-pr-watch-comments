import type { Writable } from 'node:stream';

import { parseArgs, usageText } from './cli.ts';

function writeText(stream: Writable, text: string): Promise<void> {
    return new Promise((resolve) => {
        stream.write(text, () => {
            resolve();
        });
    });
}

const parsed = parseArgs(process.argv.slice(2), process.cwd());

switch (parsed.kind) {
    case 'help': {
        await writeText(process.stdout, usageText());
        process.exitCode = 0;
        break;
    }
    case 'error': {
        await writeText(process.stderr, `pr-watch-comments: ${parsed.message}\n\n${usageText()}`);
        process.exitCode = 2;
        break;
    }
    case 'ok': {
        await writeText(process.stderr, `pr-watch-comments: mode ${parsed.options.mode} is not wired yet\n`);
        process.exitCode = 1;
        break;
    }
}
