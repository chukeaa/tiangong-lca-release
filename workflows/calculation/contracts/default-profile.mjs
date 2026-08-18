const REVIEWED_LCIA_METHODS = [
  [
    "01500b74-7ffb-463e-9bd4-72f17c2263ff",
    "01.00.000",
    "Human toxicity, cancer_inorganics",
    "Comparative Toxic Unit for human (CTUh)",
  ],
  [
    "05316e7a-b254-4bea-9cf0-6bf33eb5c630",
    "01.00.000",
    "Ecotoxicity, freshwater",
    "Comparative Toxic Unit for ecosystems (CTUe)",
  ],
  [
    "14af9ca7-aa1d-4832-b1d9-ab05a06dcb12",
    "01.00.000",
    "Climate change-Land use and land use change",
    "Radiative forcing as Global Warming Potential (GWP100)",
  ],
  [
    "2299222a-bbd8-474f-9d4f-4dd1f18aea7c",
    "01.01.000",
    "Human toxicity, cancer",
    "Comparative Toxic Unit for human (CTUh)",
  ],
  [
    "503699e0-eca9-4089-8bf8-e0f49c93e578",
    "01.01.000",
    "Human toxicity, cancer_organics",
    "Comparative Toxic Unit for human (CTUh)",
  ],
  [
    "6209b35f-9447-40b5-b68c-a1099e3674a0",
    "01.00.000",
    "Climate change",
    "Radiative forcing as Global Warming Potential (GWP100)",
  ],
  [
    "706261af-a357-4cc0-a50a-f3033fcbd556",
    "01.00.000",
    "Climate change-Biogenic",
    "Radiative forcing as Global Warming Potential (GWP100)",
  ],
  [
    "7cfdcfcf-b222-4b26-888a-a55f9fbf7ac8",
    "01.00.000",
    "Human toxicity, non-cancer",
    "Comparative Toxic Unit for human (CTUh)",
  ],
  [
    "7fce5b3a-66b8-4ce1-91e8-a925aee1f186",
    "01.00.000",
    "Climate change-Fossil",
    "Radiative forcing as Global Warming Potential (GWP100)",
  ],
  [
    "8c3141e9-1f15-43b5-bff2-182e49893a46",
    "01.00.000",
    "Human toxicity, non-cancer_organics",
    "Comparative Toxic Unit for human (CTUh)",
  ],
  [
    "9d1d43a2-e1aa-4c16-acd4-3dd8a6a2fb85",
    "01.00.000",
    "Human toxicity, non-cancer_inorganics",
    "Comparative Toxic Unit for human (CTUh)",
  ],
  [
    "b2ad6110-c78d-11e6-9d9d-cec0c932ce01",
    "01.00.010",
    "Resource use, fossils",
    "Abiotic resource depletion fossil fuels (ADP-fossil)",
  ],
  [
    "b2ad6494-c78d-11e6-9d9d-cec0c932ce01",
    "01.00.010",
    "Resource use, minerals and metals",
    "Abiotic resource depletion (ADP ultimate reserve)",
  ],
  [
    "b2ad66ce-c78d-11e6-9d9d-cec0c932ce01",
    "03.00.014",
    "Water use",
    "User deprivation potential (deprivation-weighted water consumption)",
  ],
  [
    "b2ad6890-c78d-11e6-9d9d-cec0c932ce01",
    "01.00.010",
    "Land use",
    "Soil quality index",
  ],
  [
    "b53ec18f-7377-4ad3-86eb-cc3f4f276b2b",
    "01.00.010",
    "Eutrophication, freshwater",
    "Fraction of nutrients reaching freshwater end compartment (P)",
  ],
  [
    "b5c602c6-def3-11e6-bf01-fe55135034f3",
    "02.00.011",
    "EF-particulate Matter",
    "Impact on human health",
  ],
  [
    "b5c610fe-def3-11e6-bf01-fe55135034f3",
    "02.01.000",
    "Photochemical ozone formation - human health",
    "Tropospheric ozone concentration increase",
  ],
  [
    "b5c611c6-def3-11e6-bf01-fe55135034f3",
    "01.04.000",
    "Acidification",
    "Accumulated Exceedance (AE)",
  ],
  [
    "b5c614d2-def3-11e6-bf01-fe55135034f3",
    "01.02.009",
    "Eutrophication, terrestrial",
    "Accumulated Exceedance (AE)",
  ],
  [
    "b5c619fa-def3-11e6-bf01-fe55135034f3",
    "02.00.010",
    "Eutrophication marine",
    "Fraction of nutrients reaching marine end compartment (N)",
  ],
  [
    "b5c629d6-def3-11e6-bf01-fe55135034f3",
    "02.00.012",
    "Ozone depletion",
    "Ozone Depletion Potential (ODP)",
  ],
  [
    "b5c632be-def3-11e6-bf01-fe55135034f3",
    "01.00.011",
    "Ionising radiation, human health",
    "Human exposure efficiency relative to U235",
  ],
  [
    "dacd48b5-4da5-49aa-aff4-cd5f5495c037",
    "01.00.000",
    "Ecotoxicity, freshwater_inorganics",
    "Comparative Toxic Unit for ecosystems (CTUe)",
  ],
  [
    "fd530f00-9325-424a-92ef-aaac67922fd9",
    "01.00.000",
    "Ecotoxicity, freshwater_organics",
    "Comparative Toxic Unit for ecosystems (CTUe)",
  ],
].map(([id, version, name, indicator]) =>
  Object.freeze({ id, version, name, indicator }),
);

export const DEFAULT_CALCULATION_PROFILE = Object.freeze({
  coverageMode: "global_eligible",
  defaultImpactCategory: "6209b35f-9447-40b5-b68c-a1099e3674a0",
  lciaMethods: Object.freeze(REVIEWED_LCIA_METHODS),
});

export function defaultMethodSelections() {
  return DEFAULT_CALCULATION_PROFILE.lciaMethods.map(({ id, version }) => ({
    id,
    version,
  }));
}
