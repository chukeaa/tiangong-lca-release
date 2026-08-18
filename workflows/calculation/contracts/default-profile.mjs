export const DEFAULT_CALCULATION_PROFILE = Object.freeze({
  coverageMode: "global_eligible",
  lciaMethods: Object.freeze([
    Object.freeze({
      id: "6209b35f-9447-40b5-b68c-a1099e3674a0",
      version: "01.00.000",
      label: "Climate change (GWP)",
    }),
  ]),
});

export function defaultMethodSelections() {
  return DEFAULT_CALCULATION_PROFILE.lciaMethods.map(({ id, version }) => ({
    id,
    version,
  }));
}
