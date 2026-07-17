export type CalculationBundleArtifactKind =
  | "process_axis"
  | "inventory_axis"
  | "technosphere_edges"
  | "biosphere_edges"
  | "lci"
  | "lcia"
  | "coverage"
  | "source_closure"
  | "csv"
  | "json"
  | "hdf5";

export type CalculationBundleArtifact = {
  kind: CalculationBundleArtifactKind;
  path: string;
  schemaVersion: string;
  mediaType: string;
  compression?: "gzip" | "none";
  sha256: string;
  uncompressedSha256?: string;
  byteSize: number;
  uncompressedByteSize?: number;
  recordCount: number;
  firstProcessIndex?: number;
  lastProcessIndex?: number;
  derived?: boolean;
};

export type CalculationBundleManifest = {
  schemaVersion: "tiangong.calculation-bundle.v1";
  calculationContractVersion: string;
  calculationId: string;
  createdAt?: string;
  bundleContentHash: string;
  scope: {
    coverageMode: "subset" | "global_eligible";
    processCount: number;
    selectionManifestHash: string;
  };
  snapshot: {
    id: string;
    sha256: string;
    processCount: number;
    flowCount: number;
    impactCount: number;
  };
  solver: Record<string, unknown>;
  methodSet: Record<string, unknown>;
  artifacts: CalculationBundleArtifact[];
  calculationEvidence: Record<string, unknown>;
  hashes: Record<string, unknown>;
};

export type BundleProcessRecord = {
  processIndex: number;
  rootProcess: { id: string; version: string };
  quantitativeReference: {
    exchangeInternalId: string;
    flow: { id: string; version: string };
    direction: "Output";
    referenceUnit: string;
    meanAmount: number;
  };
};

export type BundleTechnosphereEdgeRecord = {
  consumerProcessIndex: number;
  consumerInputExchangeInternalId: string;
  providerProcessIndex: number;
  providerOutputExchangeInternalId: string;
  providerWeight: number;
  normalizedAmount: number;
  flow: { id: string; version: string };
  location?: string | null;
};

export type BundleInventoryRecord = {
  processIndex: number;
  exchangeInternalId?: string;
  flow: { id: string; version: string };
  direction: "Input" | "Output";
  unit: string;
  location?: string | null;
  meanAmount: number;
  allocationTargetInternalId?: string;
  allocationFraction?: number;
};

export type BundleLciaRecord = {
  processIndex: number;
  method: { id: string; version: string };
  meanAmount: number;
};
