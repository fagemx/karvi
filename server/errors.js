class OptimisticLockError extends Error {
  constructor(message, expectedVersion, actualVersion) {
    super(message);
    this.name = 'OptimisticLockError';
    this.code = 'VERSION_CONFLICT';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

module.exports = { OptimisticLockError };
