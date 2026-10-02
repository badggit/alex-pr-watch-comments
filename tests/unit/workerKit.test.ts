import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { getArray, getPath, getRecord, getString, isRecord } from '../../src/json.ts';
import { buildPrompt, conveyorCommands } from '../../src/prompt.ts';
import type { RecordPatch, RunRecord } from '../../src/types.ts';
import { shQuote } from '../../src/validate.ts';
import {
    buildHookScript,
    buildLauncherScript,
    buildReactionMutation,
    buildSettings,
    writeWorkerKit,
} from '../../src/workerKit.ts';

const RD = '/state/runs/20261002120000-456';
const TOOLS_DIR = '/opt/tools/bin';
const NODE_ID = 'PRRC_kwDOAbc456';
const KIT_FILES: readonly string[] = [
    'prompt.txt',
    'settings.json',
    'hook.sh',
    'launcher.sh',
    'gql/removeEyes.graphql',
    'gql/removePlus1.graphql',
    'gql/addPlus1.graphql',
];

function kitRecord(patch?: RecordPatch): RunRecord {
    return {
        format: 1,
        runId: '20261002120000-456',
        prKey: 'o+r+12',
        owner: 'o',
        repo: 'r',
        number: 12,
        prUrl: 'https://github.com/o/r/pull/12',
        commentNodeId: NODE_ID,
        commentDbId: 456,
        commentUrl: 'https://github.com/o/r/pull/12#discussion_r456',
        threadId: 'PRRT_kwDOThread9',
        topDbId: 400,
        rocketAt: 1_790_000_000,
        headSha: 'a'.repeat(40),
        remote: 'origin',
        branch: 'feature-x',
        dir: '/path/to/project',
        worktreeKey: '0123456789abcdef',
        claude: `${TOOLS_DIR}/claude`,
        git: `${TOOLS_DIR}/git`,
        gh: `${TOOLS_DIR}/gh`,
        callerPath: `${TOOLS_DIR}:/usr/bin:/bin`,
        claudeArgs: ['--model', 'x'],
        state: 'preparing',
        reason: '',
        eyesAdded: true,
        paneId: '',
        panePid: undefined,
        socket: '/tmp/prwc-test-socket',
        startedAt: undefined,
        watcherPid: 4242,
        ...patch,
    };
}

function tempRoot(t: TestContext): string {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-kit-')));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

function makeRunDir(root: string, stateName: string): string {
    const rd = path.join(root, stateName, 'runs', '20261002120000-456');
    fs.mkdirSync(rd, { recursive: true });
    return rd;
}

function parseSettings(record: RunRecord, rd = RD): unknown {
    const text = buildSettings(record, rd);
    assert.ok(text !== undefined, 'buildSettings refused a valid record');
    const parsed: unknown = JSON.parse(text);
    return parsed;
}

function allowRules(settings: unknown): string[] {
    const allow = getArray(getRecord(settings, 'permissions'), 'allow');
    assert.ok(allow !== undefined);
    return allow.filter((rule) => typeof rule === 'string');
}

function hookEntry(settings: unknown, event: string): unknown {
    const entries = getArray(getRecord(settings, 'hooks'), event);
    assert.ok(entries?.length === 1, event);
    return entries[0];
}

function hookCommand(entry: unknown): string | undefined {
    const hooks = getArray(entry, 'hooks');
    assert.ok(hooks?.length === 1);
    assert.equal(getString(hooks[0], 'type'), 'command');
    return getString(hooks[0], 'command');
}

function everyBuilderRefuses(record: RunRecord, rd: string): void {
    assert.equal(conveyorCommands(record, rd), undefined, 'conveyorCommands');
    assert.equal(buildPrompt(record, rd), undefined, 'buildPrompt');
    assert.equal(buildSettings(record, rd), undefined, 'buildSettings');
    assert.equal(buildLauncherScript(record, rd, 60), undefined, 'buildLauncherScript');
}

function listFiles(dir: string): string[] {
    return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).toSorted();
}

await describe('buildReactionMutation', async () => {
    await test('builds one variable-free document pinned to the node id', () => {
        const removeEyes = buildReactionMutation(NODE_ID, 'remove', 'EYES');
        assert.equal(
            removeEyes,
            `mutation PrwcWorkerRemoveEyes { removeReaction(input: { subjectId: "${NODE_ID}", content: EYES }) { reaction { content } } }`
        );
        const addPlus1 = buildReactionMutation(NODE_ID, 'add', 'THUMBS_UP');
        assert.ok(addPlus1 !== undefined);
        assert.ok(addPlus1.includes('addReaction'));
        assert.ok(addPlus1.includes('THUMBS_UP'));
        assert.ok(!addPlus1.includes('$'));
    });

    await test('refuses a node id that could break out of the quotes', () => {
        assert.equal(buildReactionMutation('PRRC_a"b', 'remove', 'EYES'), undefined);
        assert.equal(buildReactionMutation('', 'add', 'THUMBS_UP'), undefined);
    });
});

await describe('buildSettings', async () => {
    await test('declares exactly the four hooks with their matchers and commands', () => {
        const settings = parseSettings(kitRecord());
        const hooks = getRecord(settings, 'hooks');
        assert.ok(hooks !== undefined);
        assert.deepEqual(Object.keys(hooks).toSorted(), ['Notification', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
        const expected: Record<string, [string | undefined, string]> = {
            UserPromptSubmit: [undefined, 'prompt'],
            Stop: [undefined, 'stop'],
            Notification: ['permission_prompt', 'permission'],
            PreToolUse: ['*', 'tool'],
        };
        for (const [event, [matcher, kind]] of Object.entries(expected)) {
            const entry = hookEntry(settings, event);
            assert.equal(getString(entry, 'matcher'), matcher, event);
            assert.equal(hookCommand(entry), `/bin/sh '${RD}/hook.sh' ${kind}`, event);
        }
    });

    await test('allows exactly the conveyor commands and the run files', () => {
        const record = kitRecord();
        const rules = allowRules(parseSettings(record));
        assert.ok(rules.includes('Bash(git push origin HEAD:refs/heads/feature-x)'));
        assert.ok(rules.includes('Bash(git diff)'));
        assert.ok(rules.includes('Bash(git diff --cached)'));
        assert.ok(rules.includes(`Bash(gh api graphql --hostname github.com -F query=@${RD}/gql/addPlus1.graphql)`));
        assert.ok(rules.includes('Bash(git diff --cached --name-only)'));
        const commands = conveyorCommands(record, RD) ?? [];
        assert.deepEqual(
            rules.filter((rule) => rule.startsWith('Bash(')),
            commands.map((line) => `Bash(${line})`)
        );
        for (const forbidden of ['Bash(git push *)', 'Bash(gh *)', 'Bash(git diff *)']) {
            assert.ok(!rules.includes(forbidden), forbidden);
        }
        for (const rule of rules) {
            assert.ok(!rule.startsWith('Bash(/'), rule);
            assert.ok(!rule.includes('--output'), rule);
            assert.ok(!rule.includes(TOOLS_DIR), rule);
            assert.ok(!rule.includes('GH_HOST'), rule);
        }
    });

    await test('allows no pathspec wildcard on git diff, which could read files outside the clone', () => {
        const rules = allowRules(parseSettings(kitRecord()));
        for (const unsafe of ['Bash(git diff -- *)', 'Bash(git diff --cached -- *)']) {
            assert.ok(!rules.includes(unsafe), unsafe);
        }
        const wildcard = rules.filter((rule) => rule.startsWith('Bash(') && rule.includes('*'));
        assert.deepEqual(wildcard, ['Bash(git add -- *)', `Bash(git commit -F ${RD}/commit-msg.txt -- *)`]);
    });

    await test('every gh rule pins the host', () => {
        const rules = allowRules(parseSettings(kitRecord())).filter((rule) => rule.startsWith('Bash(gh '));
        assert.ok(rules.length > 0);
        for (const rule of rules) {
            assert.ok(rule.startsWith('Bash(gh api '), rule);
            assert.ok(rule.includes('--hostname github.com'), rule);
        }
    });

    await test('allows the exact PR body PATCH and no wildcard PATCH', () => {
        const rules = allowRules(parseSettings(kitRecord()));
        assert.ok(
            rules.includes(`Bash(gh api -X PATCH repos/o/r/pulls/12 --hostname github.com -F body=@${RD}/pr-body.md)`)
        );
        assert.ok(!rules.some((rule) => rule.endsWith('-X PATCH *)')));
    });

    await test('uses the double-slash absolute form for Read, Edit and Write', () => {
        const text = buildSettings(kitRecord(), RD) ?? '';
        assert.ok(text.includes('Read(//'));
        assert.ok(text.includes('Edit(//'));
        assert.ok(text.includes('Write(//'));
        const rules = allowRules(parseSettings(kitRecord()));
        assert.ok(rules.includes(`Read(/${RD}/**)`));
        const files = ['reply.md', 'commit-msg.txt', 'pr-body.md'];
        const editRules = rules.filter((rule) => rule.startsWith('Edit(')).toSorted();
        const writeRules = rules.filter((rule) => rule.startsWith('Write(')).toSorted();
        assert.deepEqual(editRules, files.map((file) => `Edit(/${RD}/${file})`).toSorted());
        assert.deepEqual(writeRules, files.map((file) => `Write(/${RD}/${file})`).toSorted());
    });

    await test('has no deny list, no default mode and no bypass', () => {
        const settings = parseSettings(kitRecord());
        const permissions = getRecord(settings, 'permissions');
        assert.ok(permissions !== undefined);
        assert.deepEqual(Object.keys(permissions), ['allow']);
        assert.ok(isRecord(settings));
        assert.deepEqual(Object.keys(settings).toSorted(), ['hooks', 'permissions']);
        const text = buildSettings(kitRecord(), RD) ?? '';
        assert.ok(!text.includes('deny'));
        assert.ok(!text.includes('defaultMode'));
        assert.ok(!text.toLowerCase().includes('bypass'));
        assert.ok(!text.includes('pr edit') && !text.includes('pr view'));
    });
});

await describe('buildHookScript', async () => {
    await test('appends KIND EPOCH to the run events file and prints nothing', () => {
        const script = buildHookScript(RD);
        assert.ok(script.startsWith('#!/bin/sh\n'));
        assert.ok(script.includes(`>> ${shQuote(`${RD}/events`)}`));
        assert.ok(script.includes('date +%s'));
        assert.ok(script.includes('exec >/dev/null 2>&1'));
        assert.ok(script.includes('grep -E'));
        const lines = script.split('\n');
        assert.equal(lines[2], 'PATH=/usr/bin:/bin');
        assert.equal(lines[3], 'export PATH');
        assert.ok(script.trimEnd().endsWith('exit 0'));
    });
});

await describe('buildLauncherScript', async () => {
    await test('embeds the tool paths for its check and the owner args as quoted words', () => {
        const record = kitRecord({ claudeArgs: ['--model', 'x', 'a b', '$(echo pwned)', "it's"] });
        const script = buildLauncherScript(record, RD, 60);
        assert.ok(script !== undefined);
        assert.ok(script.includes(shQuote(`${TOOLS_DIR}/git`)));
        assert.ok(script.includes(shQuote(`${TOOLS_DIR}/gh`)));
        assert.ok(script.includes(shQuote(`${TOOLS_DIR}/claude`)));
        assert.ok(script.includes(shQuote(`${TOOLS_DIR}:/usr/bin:/bin`)));
        assert.ok(script.includes(shQuote('/path/to/project')));
        assert.ok(script.includes(`${shQuote('a b')} ${shQuote('$(echo pwned)')} ${shQuote("it's")}`));
        assert.ok(script.includes('unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_REPO'));
        assert.ok(script.includes('GH_HOST=github.com'));
        assert.ok(
            script.includes(
                'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_NAMESPACE GIT_COMMON_DIR'
            )
        );
        assert.ok(script.includes(shQuote('60')));
    });

    await test('tool paths with an at sign and a space stay one quoted word each', () => {
        const dir = '/opt/homebrew/opt/node@22 x/bin';
        const record = kitRecord({ claude: `${dir}/claude`, git: `${dir}/git`, gh: `${dir}/gh` });
        const script = buildLauncherScript(record, RD, 60);
        assert.ok(script !== undefined);
        for (const tool of ['claude', 'git', 'gh']) {
            assert.ok(script.includes(shQuote(`${dir}/${tool}`)), tool);
        }
        assert.ok(buildSettings(record, RD) !== undefined);
        assert.ok(conveyorCommands(record, RD) !== undefined);
    });

    await test('refuses a launch wait that is not a positive integer', () => {
        assert.equal(buildLauncherScript(kitRecord(), RD, 0), undefined);
        assert.equal(buildLauncherScript(kitRecord(), RD, 1.5), undefined);
    });
});

await describe('builder refusals', async () => {
    await test('relative or multi-line tool paths make every builder refuse', () => {
        const bad: RecordPatch[] = [
            { git: 'git' },
            { git: `${TOOLS_DIR}/git\n` },
            { gh: 'gh' },
            { claude: 'claude' },
            { claude: `${TOOLS_DIR}/cl\naude` },
        ];
        for (const patch of bad) {
            everyBuilderRefuses(kitRecord(patch), RD);
        }
    });

    await test('invalid names, ids and paths make every builder refuse', () => {
        const bad: RecordPatch[] = [
            { branch: 'x;rm' },
            { owner: 'o x' },
            { remote: 'origin;x' },
            { commentNodeId: 'PRRC_a"b' },
            { headSha: 'HEAD' },
            { topDbId: 0 },
            { repo: 'r x' },
            { callerPath: '/usr/bin::/bin' },
            { callerPath: 'bin:/usr/bin' },
            { dir: 'path/to/project' },
        ];
        for (const patch of bad) {
            everyBuilderRefuses(kitRecord(patch), RD);
        }
    });
});

await describe('run directory spelling', async () => {
    await test('a trailing slash or a non-normalized run directory makes every builder refuse', () => {
        for (const rd of [`${RD}/`, '/state//runs/20261002120000-456', '/state/./runs/20261002120000-456', '/']) {
            everyBuilderRefuses(kitRecord(), rd);
        }
    });

    await test('the canonical spelling gives single slashes in every file rule', () => {
        const rules = allowRules(parseSettings(kitRecord()));
        for (const rule of rules.filter((item) => !item.startsWith('Bash('))) {
            const inner = rule.slice(rule.indexOf('(') + 3);
            assert.ok(!inner.includes('//'), rule);
        }
    });
});

await describe('writeWorkerKit', async () => {
    await test('writes every kit file owner-only and the three mutations', (t) => {
        const rd = makeRunDir(tempRoot(t), 'state');
        assert.equal(writeWorkerKit(rd, kitRecord(), 60), true);
        assert.deepEqual(listFiles(rd), [...KIT_FILES, 'gql'].toSorted());
        for (const name of KIT_FILES) {
            assert.equal(fs.statSync(path.join(rd, name)).mode & 0o777, 0o600, name);
        }
        assert.equal(fs.statSync(path.join(rd, 'gql')).mode & 0o777, 0o700);
        const read = (name: string): string => fs.readFileSync(path.join(rd, 'gql', name), 'utf8');
        const removeEyes = read('removeEyes.graphql');
        assert.ok(removeEyes.includes('removeReaction'));
        assert.ok(removeEyes.includes(`"${NODE_ID}"`));
        assert.ok(removeEyes.includes('EYES'));
        const removePlus1 = read('removePlus1.graphql');
        assert.ok(removePlus1.includes('removeReaction'));
        assert.ok(removePlus1.includes('THUMBS_UP'));
        assert.ok(removePlus1.includes(`"${NODE_ID}"`));
        const addPlus1 = read('addPlus1.graphql');
        assert.ok(addPlus1.includes('addReaction'));
        assert.ok(addPlus1.includes('THUMBS_UP'));
        assert.ok(addPlus1.includes(`"${NODE_ID}"`));
        for (const text of [removeEyes, removePlus1, addPlus1]) {
            assert.ok(!text.includes('$'));
        }
    });

    await test('an underscore in the run directory is accepted and named in the Read rule', (t) => {
        const rd = makeRunDir(tempRoot(t), 'state_dir_x');
        assert.equal(writeWorkerKit(rd, kitRecord(), 60), true);
        const settings: unknown = JSON.parse(fs.readFileSync(path.join(rd, 'settings.json'), 'utf8'));
        assert.ok(allowRules(settings).includes(`Read(/${rd}/**)`));
        assert.equal(getPath(settings, 'permissions', 'deny'), undefined);
    });

    await test('a semicolon or a space in the run directory refuses everything and writes nothing', (t) => {
        const root = tempRoot(t);
        for (const stateName of ['state;x', 'state x']) {
            const rd = makeRunDir(root, stateName);
            everyBuilderRefuses(kitRecord(), rd);
            assert.equal(writeWorkerKit(rd, kitRecord(), 60), false, stateName);
            assert.deepEqual(listFiles(rd), [], stateName);
        }
        const accepted = makeRunDir(root, 'state_x');
        assert.equal(writeWorkerKit(accepted, kitRecord(), 60), true);
    });

    await test('a refused record writes nothing', (t) => {
        const rd = makeRunDir(tempRoot(t), 'state');
        assert.equal(writeWorkerKit(rd, kitRecord({ git: 'git' }), 60), false);
        assert.equal(writeWorkerKit(rd, kitRecord({ commentNodeId: 'PRRC_a"b' }), 60), false);
        assert.deepEqual(listFiles(rd), []);
    });

    await test('a missing run directory is refused', (t) => {
        const root = tempRoot(t);
        const rd = path.join(root, 'state', 'runs', 'missing');
        assert.equal(writeWorkerKit(rd, kitRecord(), 60), false);
        assert.ok(!fs.existsSync(rd));
    });
});
