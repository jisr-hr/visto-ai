// Memory: where people stepped in on this repository before (7.4). Its fixed sizes, in one place.
// A memory hands the engine places, days, kinds and counts the service computed, never words a person wrote.

export const MEMORY_TIMEOUT_MS = 5_000;
export const MEMORY_DIRECTORIES = 10;         // directories in the repository block
export const MEMORY_CATEGORIES = 8;           // categories in the repository block
export const MEMORY_MIN_PULL_REQUESTS = 2;    // a directory or a category is listed from this many pull requests
export const MEMORY_LINES = 30;               // lines in the pull request block
export const MEMORY_LINES_PER_FILE = 3;       // records on one changed file
export const MEMORY_NEAR_PER_FILE = 2;        // records near one changed file that has none
export const MEMORY_NAME = /^[A-Za-z0-9._\/\-\[\]()@+$~]{1,120}$/;   // a path or a directory that may be put in a block
