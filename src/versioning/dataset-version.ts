const versionPattern = /^(\d{2})\.(\d{2})\.(\d{3})$/;

export type DatasetVersion = {
  major: number;
  minor: number;
  revision: number;
};

export type VersionDescriptor = {
  uuid: string;
  versionSignificantHash: string;
  semanticHash: string;
  canonicalContentHash?: string;
};

export type PreviousVersionDescriptor = VersionDescriptor & {
  version: string;
  canonicalContentHash: string;
};

export type VersionResolution = {
  version: string;
  change: "initial" | "reuse" | "major" | "minor";
};

export function parseDatasetVersion(value: string): DatasetVersion {
  const match = versionPattern.exec(value);
  if (!match) {
    throw new TypeError(`Invalid dataset version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    revision: Number(match[3]),
  };
}

export function formatDatasetVersion(version: DatasetVersion): string {
  if (
    !Number.isInteger(version.major) ||
    !Number.isInteger(version.minor) ||
    !Number.isInteger(version.revision) ||
    version.major < 0 ||
    version.major > 99 ||
    version.minor < 0 ||
    version.minor > 99 ||
    version.revision < 0 ||
    version.revision > 999
  ) {
    throw new RangeError(
      "Dataset version component is outside 00.00.000 bounds.",
    );
  }
  return `${String(version.major).padStart(2, "0")}.${String(version.minor).padStart(2, "0")}.${String(version.revision).padStart(3, "0")}`;
}

function bumpMajor(value: string): string {
  const version = parseDatasetVersion(value);
  return formatDatasetVersion({
    major: version.major + 1,
    minor: 0,
    revision: 0,
  });
}

function bumpMinor(value: string): string {
  const version = parseDatasetVersion(value);
  return formatDatasetVersion({
    major: version.major,
    minor: version.minor + 1,
    revision: 0,
  });
}

export function resolvePublicDatasetVersion(
  current: VersionDescriptor,
  previous?: PreviousVersionDescriptor,
): VersionResolution {
  if (!previous || previous.uuid.toLowerCase() !== current.uuid.toLowerCase()) {
    return { version: "01.00.000", change: "initial" };
  }
  if (current.semanticHash !== previous.semanticHash) {
    return { version: bumpMajor(previous.version), change: "major" };
  }
  if (current.versionSignificantHash !== previous.versionSignificantHash) {
    return { version: bumpMinor(previous.version), change: "minor" };
  }
  return { version: previous.version, change: "reuse" };
}

export function assertCanonicalIdentityCollisionFree(input: {
  datasetType: string;
  uuid: string;
  version: string;
  canonicalContentHash: string;
  registeredCanonicalContentHash?: string;
}): void {
  if (
    input.registeredCanonicalContentHash &&
    input.registeredCanonicalContentHash !== input.canonicalContentHash
  ) {
    throw new Error(
      `dataset_identity_content_conflict:${input.datasetType}:${input.uuid}:${input.version}`,
    );
  }
}
