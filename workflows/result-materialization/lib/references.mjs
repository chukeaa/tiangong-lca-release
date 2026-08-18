export function globalReference({
  type,
  category,
  uuid,
  version,
  description,
}) {
  return {
    "@refObjectId": uuid.toLowerCase(),
    "@type": type,
    "@uri": `../${category}/${uuid.toLowerCase()}_${version}.json`,
    "@version": version,
    "common:shortDescription": { "@xml:lang": "en", "#text": description },
  };
}

export function suffixName(name, suffix) {
  const copy = structuredClone(name);
  const values = Array.isArray(copy.baseName) ? copy.baseName : [copy.baseName];
  const updated = values.map((item) =>
    item?.["@xml:lang"] === "en"
      ? { ...item, "#text": `${item["#text"]} — ${suffix}` }
      : item,
  );
  copy.baseName = Array.isArray(copy.baseName) ? updated : updated[0];
  return copy;
}
