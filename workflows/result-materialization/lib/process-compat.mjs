const SPACE_PLACEHOLDER = Object.freeze({
  "@xml:lang": "en",
  "#text": " ",
});

export function normalizeCompatibleProcessDocument(document) {
  const normalized = structuredClone(document);
  const name =
    normalized?.processDataSet?.processInformation?.dataSetInformation?.name;
  if (!name) return normalized;
  for (const field of ["treatmentStandardsRoutes", "mixAndLocationTypes"]) {
    if (!name[field] || name[field].length === 0) {
      name[field] = [structuredClone(SPACE_PLACEHOLDER)];
    }
  }
  return normalized;
}
