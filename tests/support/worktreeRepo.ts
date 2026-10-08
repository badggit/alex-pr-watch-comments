import fs from 'node:fs';
import path from 'node:path';

import type { Env } from '../../src/types.ts';

import { gitSync, makePrClone } from './gitRepo.ts';

// ROOT/clone checked out on main, with refs/remotes/origin/main and refs/remotes/origin/feature; returns its
// canonical path.
export function mainClone(root: string, env: Env): string {
    const clone = makePrClone(root, 'feature', 'o/r', env);
    gitSync(env, ['-C', clone, 'checkout', '--quiet', 'main']);
    return fs.realpathSync.native(clone);
}

// Adds ROOT/remote.git to the clone as remote NAME by its local path and fetches it.
export function addFetchedRemote(root: string, clone: string, env: Env, name: string): void {
    gitSync(env, ['-C', clone, 'remote', 'add', name, path.join(root, 'remote.git')]);
    gitSync(env, ['-C', clone, 'fetch', '--quiet', name]);
}

export function headOf(env: Env, dir: string): string {
    return gitSync(env, ['-C', dir, 'rev-parse', 'HEAD']).trim();
}
