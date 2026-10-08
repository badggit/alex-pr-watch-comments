// On the 23 line the minimum is 23.6.0, the first 23 release with default type stripping.
export const MIN_NODE_VERSION = '22.18.0';

export const STATE_FORMAT = 1;

// Format 2 holds a batch of comments per run; a format 1 record (one comment) reads as unreadable.
export const RECORD_FORMAT = 2;

// The public GitHub host; GitHub Enterprise Server hosts come from the PR URL.
export const GITHUB_HOST = 'github.com';

// Marks every inline reply the worker posts, on its own last line.
export const REPLY_TAG = '#alex-pr-watch-comments';

export const GH_TOKEN_VARS: readonly string[] = [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
];

export const GH_STRIP_VARS: readonly string[] = [...GH_TOKEN_VARS, 'GH_REPO'];

export const DEFAULT_INTERVAL = 120;

// How often a run in flight is checked; the PR itself is polled every --interval.
export const DEFAULT_RUN_CHECK = 15;

export const DEFAULT_KEEP_PANES = 5;

export const DEFAULT_BATCH_MAX = 5;

export const MAX_BATCH = 50;

export const DEFAULT_LAUNCH_WAIT = 60;

export const DEFAULT_START_TIMEOUT = 120;

export const DEFAULT_RATE_RESERVE = 500;

export const DEFAULT_BG_TIMEOUT = 60;

export const DEFAULT_STOP_QUIET = 10;

export const DEFAULT_STOP_WAIT = 10;

export const DEFAULT_READY_WAIT = 15;

export const COMMAND_TIMEOUT_MS = 120_000;

export const KILL_GRACE_MS = 2000;

export const PS_PATH = '/bin/ps';

export const BACKOFF_CAP = 300;

export const THROTTLE_CAP = 3600;

export const PAGE_SIZE = 100;

export const GRAPHQL_OPS = {
    prInfo: 'PrwcPrInfo',
    poll: 'PrwcPoll',
    threadComments: 'PrwcThreadComments',
    lookup: 'PrwcLookup',
    reactions: 'PrwcReactions',
    context: 'PrwcContext',
    addReaction: 'PrwcAddReaction',
    removeReaction: 'PrwcRemoveReaction',
} as const;

export const ENV_NAMES = {
    stateDir: 'PRWC_STATE_DIR',
    launchWait: 'PRWC_LAUNCH_WAIT',
    startTimeout: 'PRWC_START_TIMEOUT',
    rateReserve: 'PRWC_RATE_RESERVE',
    bgTimeout: 'PRWC_BG_TIMEOUT',
    launchToken: 'PRWC_LAUNCH_TOKEN',
    stopQuiet: 'PRWC_STOP_QUIET',
    stopWait: 'PRWC_STOP_WAIT',
    readyWait: 'PRWC_READY_WAIT',
    runCheck: 'PRWC_RUN_CHECK',
} as const;

// How long a retained run waits before the owner is reminded again of approved comments or a closed PR.
export const RETAINED_REMINDER_SECONDS = 1800;
