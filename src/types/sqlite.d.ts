declare module 'node:sqlite' {
  export interface RunResult {
    changes: number;
  }

  export class StatementSync<T = any> {
    run(...params: any[]): RunResult;
    get<U = T>(...params: any[]): U | undefined;
    all<U = T>(...params: any[]): U[];
  }

  export class DatabaseSync {
    constructor(filename: string);
    exec(sql: string): void;
    prepare<T = any>(sql: string): StatementSync<T>;
    close(): void;
  }

  export const backup: (sourceFileName: string, destinationFileName: string) => Promise<void>;

  export const constants: Record<string, number>;

  export default {
    DatabaseSync,
    StatementSync,
    backup,
    constants,
  };
}
