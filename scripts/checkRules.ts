import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface Finding {
    rule: string;
    file: string;
    line: number;
    text: string;
}

interface LineRule {
    name: string;
    applies: (_file: string) => boolean;
    matches: (_line: string, _file: string) => boolean;
}

const ROOT = path.resolve(import.meta.dirname, '..');
const SELF = 'scripts/checkRules.ts';
const ESLINT_CONFIG = 'eslint.config.mjs';
const MAX_TEXT = 120;

const NON_ASCII = /[^\t -~]/u;
const NON_ASCII_GLOBAL = /[^\t -~]/gu;
const TYPOGRAPHY = /[\u00A0\u00AB\u00BB\u2000-\u200D\u2010-\u2015\u2018-\u201F\u202F\u205F\u2060\u3000\uFEFF]/u;
const BLANK_WHITESPACE = /^[\t ]+$/u;
const CODE_FILE = /\.(?:ts|mjs|js)$/u;
const SRC_TS = /^src\/.+\.ts$/u;
// Covers member access (dot, optional chaining, bracket), a named import of env and destructuring from process.
const PROCESS_ENV: readonly RegExp[] = [
    /\bprocess\s*(?:\??\.\s*env\b|(?:\?\.)?\[\s*['"`]env['"`]\s*\])/u,
    /\bimport\s*(?:type\s+)?\{[^}]*\benv\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/u,
    /\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/u,
];

const SUPPRESSIONS: readonly string[] = [
    'eslint-disable',
    '@ts-ignore',
    '@ts-expect-error',
    '@ts-nocheck',
    'as unknown as',
];
const PRIVATE_DATA: readonly string[] = ['/home/', '/Users/', '@gmail.', 'users.noreply'];
const DEPENDENCY_KEYS: readonly string[] = [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
];

const LINE_RULES: readonly LineRule[] = [
    {
        name: 'ascii',
        applies: (file) => file !== ESLINT_CONFIG && !file.endsWith('.md'),
        matches: (line) => NON_ASCII.test(line),
    },
    {
        name: 'typography',
        applies: (file) => file !== ESLINT_CONFIG,
        matches: (line) => TYPOGRAPHY.test(line),
    },
    {
        name: 'blank-line-whitespace',
        applies: (file) => file !== ESLINT_CONFIG,
        matches: (line) => BLANK_WHITESPACE.test(line),
    },
    {
        name: 'suppression',
        applies: (file) => file !== SELF && CODE_FILE.test(file),
        matches: (line) => SUPPRESSIONS.some((marker) => line.includes(marker)),
    },
    {
        name: 'dynamic-import',
        applies: (file) => SRC_TS.test(file),
        matches: (line) => line.includes('import('),
    },
    {
        name: 'child-process',
        applies: (file) => SRC_TS.test(file),
        matches: (line, file) =>
            (file !== 'src/proc.ts' && line.includes('node:child_process')) || line.includes('shell: true'),
    },
    {
        name: 'process-env',
        applies: (file) => SRC_TS.test(file) && file !== 'src/main.ts',
        matches: (line) => PROCESS_ENV.some((pattern) => pattern.test(line)),
    },
    {
        name: 'private-data',
        applies: (file) => file !== SELF,
        matches: (line) => PRIVATE_DATA.some((marker) => line.includes(marker)),
    },
];

function displayText(line: string): string {
    return line.replaceAll(NON_ASCII_GLOBAL, '?').slice(0, MAX_TEXT);
}

function isRegularFile(filePath: string): boolean {
    try {
        return fs.lstatSync(filePath).isFile();
    } catch {
        return false;
    }
}

function listRepositoryFiles(): string[] {
    const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    const names = output.split('\0').filter((name) => name.length > 0);
    return [...new Set(names)].filter((name) => isRegularFile(path.join(ROOT, name)));
}

function ownValue(record: object, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function isNonEmpty(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (typeof value === 'object' && value !== null) {
        return Object.keys(value).length > 0;
    }
    return value === true || (typeof value === 'string' && value.length > 0);
}

function checkRuntimeDeps(file: string, text: string, lines: readonly string[]): Finding[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [{ rule: 'runtime-deps', file, line: 1, text: 'package.json is not valid JSON' }];
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return [{ rule: 'runtime-deps', file, line: 1, text: 'package.json is not a JSON object' }];
    }
    const findings: Finding[] = [];
    for (const key of DEPENDENCY_KEYS) {
        if (isNonEmpty(ownValue(parsed, key))) {
            const index = lines.findIndex((line) => line.includes(`"${key}"`));
            const lineNumber = index === -1 ? 1 : index + 1;
            findings.push({ rule: 'runtime-deps', file, line: lineNumber, text: lines[lineNumber - 1] ?? key });
        }
    }
    return findings;
}

function checkFile(displayName: string, relative: string): Finding[] {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const lines = text.split('\n');
    const rules = LINE_RULES.filter((rule) => rule.applies(relative));
    const findings: Finding[] = [];
    for (const [index, line] of lines.entries()) {
        for (const rule of rules) {
            if (rule.matches(line, relative)) {
                findings.push({ rule: rule.name, file: displayName, line: index + 1, text: displayText(line) });
            }
        }
    }
    if (relative === 'package.json') {
        findings.push(...checkRuntimeDeps(displayName, text, lines));
    }
    return findings;
}

function toRelative(argument: string): string {
    return path.relative(ROOT, path.resolve(argument)).split(path.sep).join('/');
}

function run(argumentsList: readonly string[]): number {
    const targets =
        argumentsList.length > 0
            ? argumentsList.map((argument) => ({ displayName: argument, relative: toRelative(argument) }))
            : listRepositoryFiles().map((name) => ({ displayName: name, relative: name }));
    const findings: Finding[] = [];
    for (const target of targets) {
        if (isRegularFile(path.join(ROOT, target.relative))) {
            findings.push(...checkFile(target.displayName, target.relative));
        } else {
            findings.push({ rule: 'missing', file: target.displayName, line: 0, text: 'not a regular file' });
        }
    }
    for (const finding of findings) {
        process.stdout.write(`${finding.rule} ${finding.file}:${finding.line}: ${finding.text}\n`);
    }
    if (findings.length === 0) {
        process.stdout.write('rules: OK\n');
        return 0;
    }
    process.stdout.write(`rules: ${findings.length} finding(s)\n`);
    return 1;
}

process.exitCode = run(process.argv.slice(2));
