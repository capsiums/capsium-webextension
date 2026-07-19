/** Error codes classifying why a package could not be loaded/installed. */
export type PackageErrorCode =
  | 'unzip'
  | 'config'
  | 'integrity'
  | 'signature'
  | 'encryption'
  | 'missing-resource';

/** A load/verification failure with a machine-readable code. */
export class PackageError extends Error {
  constructor(
    public readonly code: PackageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PackageError';
  }
}
