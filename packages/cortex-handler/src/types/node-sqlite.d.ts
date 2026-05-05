/**
 * Type stub for node:sqlite (experimental Node.js built-in).
 * Remove when @types/node >=22 is installed.
 */
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface StatementSync {
    all(...namedParameters: unknown[]): unknown[];
    get(...namedParameters: unknown[]): unknown;
    run(...namedParameters: unknown[]): StatementResultingChanges;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
