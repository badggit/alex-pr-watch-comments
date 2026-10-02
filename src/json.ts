const ISO_TIME =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u;
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function parseJson(text: string): unknown {
    try {
        const value: unknown = JSON.parse(text);
        return value;
    } catch {
        return;
    }
}

// Plain objects only (prototype Object.prototype or null): arrays, dates, maps and class instances are refused.
export function isRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

// Only own keys count, so prototype members such as constructor or __proto__ never leak through.
function ownValue(value: unknown, key: string): unknown {
    if (!isRecord(value) || !Object.hasOwn(value, key)) {
        return;
    }
    return value[key];
}

export function getString(value: unknown, key: string): string | undefined {
    const item = ownValue(value, key);
    return typeof item === 'string' ? item : undefined;
}

export function getNumber(value: unknown, key: string): number | undefined {
    const item = ownValue(value, key);
    return typeof item === 'number' && Number.isFinite(item) ? item : undefined;
}

export function getBoolean(value: unknown, key: string): boolean | undefined {
    const item = ownValue(value, key);
    return typeof item === 'boolean' ? item : undefined;
}

export function getArray(value: unknown, key: string): unknown[] | undefined {
    const item = ownValue(value, key);
    return isUnknownArray(item) ? item : undefined;
}

export function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
    const item = ownValue(value, key);
    return isRecord(item) ? item : undefined;
}

// String keys step into objects, number keys into arrays; any mismatch yields undefined.
export function getPath(value: unknown, ...keys: readonly (string | number)[]): unknown {
    let current = value;
    for (const key of keys) {
        if (typeof key === 'string') {
            current = ownValue(current, key);
        } else if (isUnknownArray(current) && Number.isInteger(key) && key >= 0) {
            current = current[key];
        } else {
            return;
        }
    }
    return current;
}

function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
    if (month === 2 && isLeapYear(year)) {
        return 29;
    }
    return DAYS_IN_MONTH[month - 1] ?? 0;
}

// Date.parse silently rolls nonexistent dates over (Feb 31 becomes Mar 3), so every field is range-checked first.
function hasValidFields(groups: Readonly<Record<string, string | undefined>>): boolean {
    const field = (name: string): number => Number.parseInt(groups[name] ?? '0', 10);
    const year = field('year');
    const month = field('month');
    const day = field('day');
    return (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= daysInMonth(year, month) &&
        field('hour') <= 23 &&
        field('minute') <= 59 &&
        field('second') <= 59 &&
        field('offsetHour') <= 23 &&
        field('offsetMinute') <= 59
    );
}

// Whole epoch seconds from an ISO 8601 timestamp; undefined for anything that is not a real calendar instant.
export function isoToEpoch(value: unknown): number | undefined {
    if (typeof value !== 'string') {
        return;
    }
    const groups = ISO_TIME.exec(value)?.groups;
    if (groups === undefined || !hasValidFields(groups)) {
        return;
    }
    const milliseconds = Date.parse(value);
    if (Number.isNaN(milliseconds)) {
        return;
    }
    return Math.floor(milliseconds / 1000);
}
