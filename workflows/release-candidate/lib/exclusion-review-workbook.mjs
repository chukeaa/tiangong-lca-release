import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";

const WORKBOOK_NAME = "exclusion-impact-review.xlsx";
const RECEIPT_NAME = "exclusion-impact-review-receipt.json";
const SHEET_NAMES = Object.freeze([
  "Summary",
  "Invalid Data",
  "Affected Roots",
  "Derived Data",
  "Unreachable Support",
  "Complete Exclusion Set",
  "Reference Conflicts",
]);

export async function buildExclusionImpactReviewWorkbook({
  impactReportPath,
  outDir,
  previewDir,
}) {
  const reportPath = path.resolve(impactReportPath);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report.schemaVersion !== "tiangong.release.exclusion-impact-report.v1")
    fail(
      "exclusion_impact_report_invalid",
      "Expected tiangong.release.exclusion-impact-report.v1",
    );
  const sourceReportSha256 = hashJson(report);
  const target = path.resolve(outDir);
  if (!previewDir)
    fail(
      "review_workbook_preview_dir_required",
      "A preview directory is required to visually verify every workbook sheet",
    );
  const previews = path.resolve(previewDir);
  await assertTargetAbsent(target);
  await assertTargetAbsent(previews);
  const model = buildExclusionReviewWorkbookModel(report, {
    sourceReportSha256,
  });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TianGong LCA Release";
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  workbook.calcProperties.fullCalcOnLoad = true;
  const sheets = new Map(
    SHEET_NAMES.map((name) => [name, workbook.addWorksheet(name)]),
  );
  populateDetailSheet(sheets.get("Invalid Data"), model.invalidData, {
    widths: [15, 39, 13, 66, 24, 12, 13, 30, 18, 19],
  });
  populateDetailSheet(sheets.get("Affected Roots"), model.affectedRoots, {
    widths: [39, 13, 16],
  });
  populateDetailSheet(sheets.get("Derived Data"), model.derivedData, {
    widths: [16, 20, 21, 39, 13, 16, 53, 56],
  });
  populateDetailSheet(
    sheets.get("Unreachable Support"),
    model.unreachableSupport,
    { widths: [16, 20, 39, 13, 58] },
  );
  populateDetailSheet(
    sheets.get("Complete Exclusion Set"),
    model.completeExclusionSet,
    { widths: [16, 20, 21, 39, 13, 58, 34] },
  );
  populateDetailSheet(
    sheets.get("Reference Conflicts"),
    model.referenceConflicts,
    { widths: [62, 39, 13] },
  );
  populateSummarySheet(sheets.get("Summary"), model);

  const keyInspection = inspectRange(sheets.get("Summary"), 1, 1, 22, 4);
  const formulaErrors = scanFormulaErrors(workbook);
  if (formulaErrors.length)
    fail(
      "review_workbook_formula_error",
      "Spreadsheet review workbook contains a formula error",
      { scan: formulaErrors },
    );
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp-${process.pid}`;
  await mkdir(staging, { recursive: false });
  try {
    await mkdir(previews, { recursive: true });
    const previewFiles = [];
    for (const sheetName of SHEET_NAMES) {
      const previewFile = `${fileSafe(sheetName)}.svg`;
      await writeFile(
        path.join(previews, previewFile),
        renderWorksheetPreview(sheets.get(sheetName)),
        { flag: "wx" },
      );
      previewFiles.push(previewFile);
    }
    const stagedWorkbook = path.join(staging, WORKBOOK_NAME);
    const workbookBytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const readbackWorkbook = new ExcelJS.Workbook();
    await readbackWorkbook.xlsx.load(workbookBytes);
    const readbackSheets = readbackWorkbook.worksheets.map(({ name }) => name);
    if (JSON.stringify(readbackSheets) !== JSON.stringify(SHEET_NAMES))
      fail(
        "review_workbook_readback_invalid",
        "Spreadsheet workbook readback does not contain the required sheets",
        { expected: SHEET_NAMES, observed: readbackSheets },
      );
    const readbackFormulaErrors = scanFormulaErrors(readbackWorkbook);
    if (readbackFormulaErrors.length)
      fail(
        "review_workbook_formula_error",
        "Spreadsheet workbook readback contains a formula error",
        { scan: readbackFormulaErrors },
      );
    await writeFile(stagedWorkbook, workbookBytes, { flag: "wx" });
    const receipt = {
      schemaVersion: "tiangong.release.exclusion-impact-review-receipt.v1",
      authoritative: false,
      publicationAuthorized: false,
      source: {
        impactReportSha256: sourceReportSha256,
      },
      workbook: {
        path: WORKBOOK_NAME,
        sha256: sha256Bytes(workbookBytes),
        byteSize: workbookBytes.length,
        sheets: SHEET_NAMES,
      },
      verification: {
        keyRangeInspected: "Summary!A1:D22",
        workbookReadbackCompleted: true,
        formulaErrorScanCompleted: true,
        formulaErrorCount: 0,
        visualPreviewSheetCount: SHEET_NAMES.length,
        visualPreviewFormat: "svg",
        visualPreviewFiles: previewFiles,
      },
    };
    await writeFile(path.join(staging, RECEIPT_NAME), canonicalJson(receipt), {
      flag: "wx",
    });
    await rename(staging, target);
    return {
      path: target,
      impactReportPath: reportPath,
      workbookPath: path.join(target, WORKBOOK_NAME),
      receiptPath: path.join(target, RECEIPT_NAME),
      previewDir: previews,
      receipt,
      model,
      sourceReportSha256,
      inspection: {
        keyRange: keyInspection,
        formulaErrors,
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(previews, { recursive: true, force: true });
    throw error;
  }
}

export function buildExclusionReviewWorkbookModel(
  report,
  { sourceReportSha256 = hashJson(report) } = {},
) {
  const impact = report.impact ?? {};
  const invalid = report.validationIssues?.invalidDatasets ?? [];
  const derived = impact.affectedMaterializedDatasets ?? [];
  const unreachable = impact.newlyUnreachableSupportDatasets ?? [];
  const reasonsByPath = new Map();
  const addReason = (items, reason) => {
    for (const item of items) {
      const reasons = reasonsByPath.get(item.path) ?? [];
      reasons.push(reason);
      reasonsByPath.set(item.path, reasons);
    }
  };
  addReason(invalid, "Initial validation error");
  addReason(derived, "Affected materialized dataset");
  addReason(unreachable, "Newly unreachable support dataset");
  return {
    sourceReportSha256,
    excludedSetHash: impact.excludedSetHash,
    status: report.status,
    safeToExclude: impact.safeToExclude === true,
    originalDatasetCount: impact.originalDatasetCount,
    resultingDatasetCount: impact.resultingDatasetCount,
    options: report.options ?? [],
    invalidData: {
      title: "Invalid Data",
      note: "Exact validation failures. A selected release root is not an orphan merely because inbound edges are zero.",
      headers: [
        "Dataset Type",
        "UUID",
        "Version",
        "Canonical Path",
        "Classification",
        "Orphan",
        "Issue Count",
        "Issue Codes",
        "Inbound Edges",
        "Outbound Edges",
      ],
      rows: invalid.map((item) => [
        item.datasetType,
        item.uuid,
        item.version,
        item.path,
        item.classification,
        item.orphan,
        item.issueCount,
        (item.issueCodes ?? []).join(", "),
        item.inboundCalculationEdgeCount,
        item.outboundCalculationEdgeCount,
      ]),
    },
    affectedRoots: {
      title: "Affected Process Roots",
      note: "Initial invalid processes plus every reverse-dependent process root blocked by their exclusion.",
      headers: ["UUID", "Version", "Process Index"],
      rows: (impact.affectedProcessRoots ?? []).map((item) => [
        item.id,
        item.version,
        item.processIndex,
      ]),
    },
    derivedData: {
      title: "Affected Materialized Data",
      note: "Result Process and LifecycleModel datasets derived from affected process roots.",
      headers: [
        "Dataset Type",
        "Role",
        "Materialization Role",
        "UUID",
        "Version",
        "Process Index",
        "Source Process",
        "Canonical Path",
      ],
      rows: derived.map((item) => [
        item.datasetType,
        item.role ?? "",
        item.materializationRole ?? "",
        item.uuid,
        item.version,
        item.processIndex ?? "",
        identityLabel(item.sourceProcess),
        item.path,
      ]),
    },
    unreachableSupport: {
      title: "Newly Unreachable Support",
      note: "Support datasets reachable before the scope change but unreachable after affected roots are removed.",
      headers: ["Dataset Type", "Role", "UUID", "Version", "Canonical Path"],
      rows: unreachable.map((item) => [
        item.datasetType,
        item.role ?? "",
        item.uuid,
        item.version,
        item.path,
      ]),
    },
    completeExclusionSet: {
      title: "Complete Exclusion Set",
      note: "This entire set—not only the initially invalid files—is the object of any exclusion confirmation.",
      headers: [
        "Dataset Type",
        "Role",
        "Materialization Role",
        "UUID",
        "Version",
        "Canonical Path",
        "Exclusion Reason",
      ],
      rows: (impact.excludedCanonicalDatasets ?? []).map((item) => [
        item.datasetType,
        item.role ?? "",
        item.materializationRole ?? "",
        item.uuid,
        item.version,
        item.path,
        (reasonsByPath.get(item.path) ?? ["Dependency impact"]).join("; "),
      ]),
    },
    referenceConflicts: {
      title: "Remaining Reference Conflicts",
      note: "Any row here blocks exclusion. Empty means no reachable document still resolves only to excluded datasets.",
      headers: ["Referencing Canonical Path", "Referenced UUID", "Version"],
      rows: (impact.remainingReferenceConflicts ?? []).map((item) => [
        item.from,
        item.reference?.uuid ?? "",
        item.reference?.version ?? "",
      ]),
    },
  };
}

function populateSummarySheet(sheet, model) {
  sheet.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
  sheet.mergeCells("A1:D1");
  sheet.getCell("A1").value = "Release Exclusion Impact Review";
  sheet.mergeCells("A2:D2");
  sheet.getCell("A2").value =
    "Human review view only. The immutable JSON impact report and its SHA-256 remain authoritative for every decision.";
  setMatrix(sheet, 4, 1, [
    ["Metric", "Workbook Value", "Report Evidence", "Interpretation"],
  ]);
  setMatrix(sheet, 5, 1, [
    ["Analysis status", model.status, model.status, "complete or blocked"],
    [
      "Safe to exclude",
      model.safeToExclude,
      model.safeToExclude,
      "false blocks exclusion",
    ],
    ["Initial invalid datasets", null, null, "exact validation failures"],
    ["Affected process roots", null, null, "reverse dependency closure"],
    ["Affected materialized datasets", null, null, "Result/Model lineage"],
    ["Newly unreachable support", null, null, "support closure reduction"],
    ["Complete exclusion set", null, null, "confirmation scope"],
    [
      "Original dataset count",
      model.originalDatasetCount,
      model.originalDatasetCount,
      "preserved failed build",
    ],
    [
      "Resulting dataset count",
      null,
      model.resultingDatasetCount,
      "must equal original minus exclusion set",
    ],
    ["Remaining reference conflicts", null, null, "non-zero blocks exclusion"],
    ["Impact report SHA-256", model.sourceReportSha256, "", "decision binding"],
    ["Excluded set hash", model.excludedSetHash, "", "complete set identity"],
  ]);
  const ranges = {
    invalid: detailFormula("Invalid Data", model.invalidData.rows.length),
    roots: detailFormula("Affected Roots", model.affectedRoots.rows.length),
    derived: detailFormula("Derived Data", model.derivedData.rows.length),
    unreachable: detailFormula(
      "Unreachable Support",
      model.unreachableSupport.rows.length,
    ),
    excluded: detailFormula(
      "Complete Exclusion Set",
      model.completeExclusionSet.rows.length,
    ),
    conflicts: detailFormula(
      "Reference Conflicts",
      model.referenceConflicts.rows.length,
    ),
  };
  [
    [ranges.invalid, model.invalidData.rows.length],
    [ranges.roots, model.affectedRoots.rows.length],
    [ranges.derived, model.derivedData.rows.length],
    [ranges.unreachable, model.unreachableSupport.rows.length],
    [ranges.excluded, model.completeExclusionSet.rows.length],
  ].forEach(([formula, result], index) => {
    sheet.getCell(7 + index, 2).value = formulaCellValue(formula, result);
  });
  setMatrix(sheet, 7, 3, [
    [model.invalidData.rows.length],
    [model.affectedRoots.rows.length],
    [model.derivedData.rows.length],
    [model.unreachableSupport.rows.length],
    [model.completeExclusionSet.rows.length],
  ]);
  sheet.getCell("B13").value = {
    formula: "B12-B11",
    result: model.resultingDatasetCount,
  };
  sheet.getCell("B14").value = formulaCellValue(
    ranges.conflicts,
    model.referenceConflicts.rows.length,
  );
  sheet.getCell("C14").value = model.referenceConflicts.rows.length;

  sheet.mergeCells("A18:D18");
  sheet.getCell("A18").value = "Decision Guide";
  setMatrix(sheet, 19, 1, [["Action", "Recommended", "Allowed", "Meaning"]]);
  const options = new Map(model.options.map((item) => [item.action, item]));
  setMatrix(
    sheet,
    20,
    1,
    ["repair", "exclude", "stop"].map((action) => {
      const option = options.get(action) ?? {};
      return [
        action,
        option.recommended === true,
        option.allowed === true,
        option.description ?? "",
      ];
    }),
  );
  applyTitleStyle(sheet, 4);
  applyHeaderStyle(sheet, 4, 1, 4);
  applyHeaderStyle(sheet, 19, 1, 4);
  applyHorizontalBorders(sheet, 5, 1, 16, 4, "FFD8E1E8");
  applyHorizontalBorders(sheet, 20, 1, 22, 4, "FFD8E1E8");
  styleCells(sheet, 18, 1, 18, 4, {
    fill: solidFill("FFDCEFEA"),
    font: { bold: true, color: { argb: "FF123B35" }, size: 13 },
    alignment: { vertical: "middle" },
  });
  sheet.getRow(18).height = 26;
  styleCells(sheet, 7, 2, 14, 3, { numFmt: "#,##0" });
  styleCells(sheet, 15, 2, 16, 2, { numFmt: "@" });
  setColumnWidths(sheet, [29, 68, 21, 58]);
  styleCells(sheet, 1, 1, 22, 4, {
    alignment: { vertical: "middle" },
  });
  styleCells(sheet, 1, 4, 22, 4, {
    alignment: { vertical: "middle", wrapText: true },
  });
  styleCells(sheet, 15, 2, 16, 2, {
    alignment: { vertical: "middle", wrapText: true },
  });
  sheet.getRow(15).height = 30;
  sheet.getRow(16).height = 30;
  styleCells(sheet, 20, 1, 20, 4, { fill: solidFill("FFE8F3EF") });
  styleCells(sheet, 21, 1, 21, 4, {
    fill: solidFill(model.safeToExclude ? "FFFFF4D6" : "FFFDE8E7"),
  });
  styleCells(sheet, 22, 1, 22, 4, { fill: solidFill("FFF1F4F6") });
}

function populateDetailSheet(sheet, section, { widths }) {
  const columnCount = section.headers.length;
  const lastColumn = columnName(columnCount);
  const dataRows =
    section.rows.length > 0
      ? section.rows
      : [["No records", ...Array(columnCount - 1).fill("")]];
  const lastRow = 4 + dataRows.length;
  sheet.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
  sheet.mergeCells(`A1:${lastColumn}1`);
  sheet.getCell("A1").value = section.title;
  sheet.mergeCells(`A2:${lastColumn}2`);
  sheet.getCell("A2").value = section.note;
  setMatrix(sheet, 4, 1, [section.headers]);
  setMatrix(sheet, 5, 1, dataRows);
  applyTitleStyle(sheet, columnCount);
  applyHeaderStyle(sheet, 4, 1, columnCount);
  applyHorizontalBorders(sheet, 5, 1, lastRow, columnCount, "FFE1E7EB");
  styleCells(sheet, 5, 1, lastRow, columnCount, {
    alignment: { vertical: "middle", wrapText: true },
  });
  setColumnWidths(sheet, widths);
  for (let row = 5; row <= lastRow; row += 1) sheet.getRow(row).height = 30;
  sheet.getRow(1).height = 31;
  sheet.getRow(2).height = 36;
  sheet.getRow(4).height = 25;
  sheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: lastRow, column: columnCount },
  };
}

function applyTitleStyle(sheet, columnCount) {
  styleCells(sheet, 1, 1, 1, columnCount, {
    fill: solidFill("FF153B50"),
    font: { bold: true, color: { argb: "FFFFFFFF" }, size: 17 },
    alignment: { vertical: "middle" },
  });
  styleCells(sheet, 2, 1, 2, columnCount, {
    fill: solidFill("FFEAF1F4"),
    font: { color: { argb: "FF365A6C" }, italic: true, size: 10 },
    alignment: { vertical: "middle", wrapText: true },
  });
  sheet.getRow(1).height = 31;
  sheet.getRow(2).height = 36;
}

function applyHeaderStyle(sheet, row, firstColumn, lastColumn) {
  styleCells(sheet, row, firstColumn, row, lastColumn, {
    fill: solidFill("FF2B6F72"),
    font: { bold: true, color: { argb: "FFFFFFFF" }, size: 10 },
    alignment: { vertical: "middle", wrapText: true },
    border: thinBorder("FF245E61"),
  });
}

function setMatrix(sheet, startRow, startColumn, rows) {
  rows.forEach((row, rowOffset) => {
    row.forEach((value, columnOffset) => {
      sheet.getCell(startRow + rowOffset, startColumn + columnOffset).value =
        value ?? null;
    });
  });
}

function setColumnWidths(sheet, widths) {
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
}

function styleCells(sheet, firstRow, firstColumn, lastRow, lastColumn, style) {
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const cell = sheet.getCell(row, column);
      if (style.fill) cell.fill = style.fill;
      if (style.font) cell.font = { ...(cell.font ?? {}), ...style.font };
      if (style.alignment)
        cell.alignment = { ...(cell.alignment ?? {}), ...style.alignment };
      if (style.border) cell.border = style.border;
      if (style.numFmt) cell.numFmt = style.numFmt;
    }
  }
}

function applyHorizontalBorders(
  sheet,
  firstRow,
  firstColumn,
  lastRow,
  lastColumn,
  color,
) {
  for (let row = firstRow; row <= lastRow; row += 1)
    for (let column = firstColumn; column <= lastColumn; column += 1)
      sheet.getCell(row, column).border = {
        bottom: { style: "thin", color: { argb: color } },
      };
}

function solidFill(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(argb) {
  const side = { style: "thin", color: { argb } };
  return { top: side, left: side, bottom: side, right: side };
}

function inspectRange(sheet, firstRow, firstColumn, lastRow, lastColumn) {
  const rows = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const values = [];
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const value = sheet.getCell(row, column).value;
      values.push(
        value && typeof value === "object" && "formula" in value
          ? { formula: value.formula, result: value.result }
          : value,
      );
    }
    rows.push(values);
  }
  return JSON.stringify({ range: "Summary!A1:D22", rows });
}

function formulaCellValue(formula, result) {
  return formula === "=0" ? 0 : { formula: formula.slice(1), result };
}

function scanFormulaErrors(workbook) {
  const errors = [];
  const errorPattern = /#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A)/u;
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const value = cell.value;
        if (
          value &&
          typeof value === "object" &&
          "formula" in value &&
          (errorPattern.test(String(value.formula)) ||
            errorPattern.test(String(value.result ?? "")))
        )
          errors.push({ sheet: sheet.name, cell: cell.address });
      });
    });
  });
  return errors;
}

function renderWorksheetPreview(sheet) {
  const rowCount = Math.min(Math.max(sheet.rowCount, 1), 24);
  const columnCount = Math.min(Math.max(sheet.columnCount, 1), 10);
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.min(Math.max((sheet.getColumn(index + 1).width ?? 12) * 7, 84), 240),
  );
  const rowHeight = 34;
  const footerHeight = sheet.rowCount > rowCount ? 28 : 0;
  const width = widths.reduce((total, value) => total + value, 0);
  const height = rowCount * rowHeight + footerHeight;
  const cells = [];
  let y = 0;
  for (let row = 1; row <= rowCount; row += 1) {
    let x = 0;
    for (let column = 1; column <= columnCount;) {
      const cell = sheet.getCell(row, column);
      const masterAddress = cell.isMerged ? cell.master.address : cell.address;
      if (cell.isMerged && masterAddress !== cell.address) {
        x += widths[column - 1];
        column += 1;
        continue;
      }
      let span = 1;
      while (column + span <= columnCount) {
        const candidate = sheet.getCell(row, column + span);
        if (!candidate.isMerged || candidate.master.address !== masterAddress)
          break;
        span += 1;
      }
      const cellWidth = widths
        .slice(column - 1, column - 1 + span)
        .reduce((total, value) => total + value, 0);
      const fill = colorFromStyle(cell.fill?.fgColor?.argb, "FFFFFF");
      const fontColor = colorFromStyle(cell.font?.color?.argb, "243746");
      const fontWeight = cell.font?.bold ? "700" : "400";
      const value = truncate(displayCellValue(cell.value), 100);
      cells.push(
        `<rect x="${x}" y="${y}" width="${cellWidth}" height="${rowHeight}" fill="#${fill}" stroke="#D8E1E8"/>`,
        `<text x="${x + 7}" y="${y + 21}" fill="#${fontColor}" font-family="Arial, sans-serif" font-size="11" font-weight="${fontWeight}">${escapeXml(value)}</text>`,
      );
      x += cellWidth;
      column += span;
    }
    y += rowHeight;
  }
  if (footerHeight)
    cells.push(
      `<rect x="0" y="${y}" width="${width}" height="${footerHeight}" fill="#F1F4F6"/>`,
      `<text x="8" y="${y + 19}" fill="#506572" font-family="Arial, sans-serif" font-size="11">Preview shows ${rowCount} of ${sheet.rowCount} rows</text>`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${cells.join("")}</svg>\n`;
}

function displayCellValue(value) {
  if (value === null || value === undefined) return "";
  if (value && typeof value === "object" && "formula" in value)
    return String(value.result ?? `=${value.formula}`);
  return String(value);
}

function colorFromStyle(value, fallback) {
  const normalized = String(value ?? "").replace(/^#?/u, "");
  if (/^[0-9A-Fa-f]{8}$/u.test(normalized)) return normalized.slice(2);
  if (/^[0-9A-Fa-f]{6}$/u.test(normalized)) return normalized;
  return fallback;
}

function truncate(value, maximum) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function detailFormula(sheetName, rowCount) {
  if (rowCount === 0) return "=0";
  return `=COUNTA('${sheetName}'!$A$5:$A$${4 + rowCount})`;
}

function identityLabel(value) {
  if (!value) return "";
  return `${value.id ?? value.uuid ?? ""}@${value.version ?? ""}`;
}

function columnName(columnCount) {
  let value = columnCount;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function fileSafe(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}

async function assertTargetAbsent(target) {
  try {
    await stat(target);
    fail("output_exists", `Refusing to overwrite existing output: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
