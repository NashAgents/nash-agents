/**
 * 文件一致性与写保护强类型错误
 */

export class FileConsistencyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "FileConsistencyError";
    this.code = code;
  }
}

export class StaleFileVersionError extends FileConsistencyError {
  readonly filePath: string;
  readonly lastObservedHash: string;
  readonly currentDiskHash: string;

  constructor(filePath: string, lastObservedHash: string, currentDiskHash: string) {
    super(
      "STALE_FILE_VERSION",
      `文件版本已过期: 路径 '${filePath}' 在你读取后已被其他 Agent 或外部进程修改。\n` +
        `预期版本 Hash: ${lastObservedHash.slice(0, 8)}\n` +
        `当前磁盘 Hash: ${currentDiskHash.slice(0, 8)}\n` +
        `请重新使用 'read_file' 读取最新文件内容，并基于最新版本重新组织修改。`
    );
    this.name = "StaleFileVersionError";
    this.filePath = filePath;
    this.lastObservedHash = lastObservedHash;
    this.currentDiskHash = currentDiskHash;
  }
}

export class WriteScopeConflictError extends FileConsistencyError {
  readonly conflictingPath: string;
  readonly currentScope: string[];
  readonly conflictingScope: string[];

  constructor(
    conflictingPath: string,
    currentScope: string[],
    conflictingScope: string[]
  ) {
    super(
      "WRITE_SCOPE_CONFLICT",
      `检测到文件写范围冲突: 目标路径 '${conflictingPath}' 与其他活跃任务声明的 writeScopes 存在重叠冲突。\n` +
        `当前 Task Scope: [${currentScope.join(", ")}]\n` +
        `冲突 Task Scope: [${conflictingScope.join(", ")}]`
    );
    this.name = "WriteScopeConflictError";
    this.conflictingPath = conflictingPath;
    this.currentScope = currentScope;
    this.conflictingScope = conflictingScope;
  }
}
