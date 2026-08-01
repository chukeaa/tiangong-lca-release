import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import ts from "typescript";

const REPOSITORY = "chukeaa/tiangong-lca-release";
const CANONICAL_ORIGIN = "git@github.com:chukeaa/tiangong-lca-release.git";
const SCHEMA_PATH = "contracts/supabase-consumer-manifest.v3.schema.json";
const MANIFEST_PATH = "contracts/supabase-consumer-manifest.v3.json";
const SOURCE_PATTERNS = ["src/**/*.ts", "specs/release-targets.json"] as const;
const CLI_ACTIONS = new Set([
  "approve",
  "artifact-download",
  "calculation-artifact",
  "calculation-bundle",
  "finalize",
  "prepare",
  "publish",
  "readback-verify",
  "status",
  "upload",
]);

export class ManifestError extends Error {}

type GitSource = {
  path: string;
  mode: string;
  bytes: Buffer;
  sha256: string;
};

export type Occurrence = {
  id: string;
  file: string;
  line: number;
  span: { start: number; end: number };
  operation: "call" | "configure" | "dispatch" | "download";
  transport:
    "supabase-functions-gateway" | "tiangong-lca-cli" | "signed-storage-url";
  credential:
    "actor-session-api-key" | "publishable-key-profile" | "signed-download-url";
  role: "data_product_manager" | "credential-brokered" | "no-database-role";
  schema: "indirect-cli-edge-contract" | "storage" | "supabase-functions";
  object: string;
  signature: string;
  acl: string;
  sourceClass: "runtime" | "versioned-target-profile";
};

type Manifest = {
  $schema: string;
  schema: string;
  version: number;
  repository: { slug: string; canonicalOrigin: string };
  manifestSchema: { path: string; sha256: string };
  sourceSnapshot: {
    derivation: string;
    sourceTreeCommit: string;
    sourceTreeSha256: string;
    pathPatterns: string[];
    governedFiles: Array<{ path: string; mode: string; sha256: string }>;
    symlinkPolicy: string;
    nonRegularFilePolicy: string;
    setEquality: string;
  };
  delivery: {
    baseCommit: string;
    targetBranch: string;
    deliveryCommit: null;
    deliveryCommitAuthority: string;
    headResolution: string;
    governedSourcePolicy: string;
  };
  authority: Record<string, unknown>;
  occurrences: Occurrence[];
  absenceProof: {
    zeroOccurrenceTransports: string[];
    forbiddenCredentials: string[];
    enforcement: string;
  };
  summary: {
    total: number;
    byTransport: Record<string, number>;
    byCredential: Record<string, number>;
  };
};

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(
  root: string,
  args: string[],
  encoding?: BufferEncoding,
): Buffer | string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ManifestError(
      `git command failed (${args.join(" ")}): ${message}`,
    );
  }
}

function gitText(root: string, ...args: string[]): string {
  return String(git(root, args, "utf8")).trim();
}

function isGovernedPath(filePath: string): boolean {
  return (
    (filePath.startsWith("src/") && filePath.endsWith(".ts")) ||
    filePath === "specs/release-targets.json"
  );
}

export function readGitSources(root: string, commit: string): GitSource[] {
  const resolved = gitText(root, "rev-parse", "--verify", `${commit}^{commit}`);
  if (!/^[0-9a-f]{40}$/u.test(resolved)) {
    throw new ManifestError(`invalid source commit: ${commit}`);
  }
  const raw = git(root, ["ls-tree", "-rz", "--full-tree", resolved]) as Buffer;
  const sources: GitSource[] = [];
  for (const entry of raw.toString("utf8").split("\0").filter(Boolean)) {
    const match =
      /^(?<mode>\d{6}) (?<type>\S+) (?<oid>[0-9a-f]{40})\t(?<path>.+)$/u.exec(
        entry,
      );
    if (!match?.groups) continue;
    const mode = match.groups.mode;
    const type = match.groups.type;
    const oid = match.groups.oid;
    const filePath = match.groups.path;
    if (!mode || !type || !oid || !filePath || !isGovernedPath(filePath))
      continue;
    if (type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new ManifestError(
        `governed source is symlink/non-regular: ${filePath}`,
      );
    }
    const bytes = git(root, ["cat-file", "blob", oid]) as Buffer;
    sources.push({
      path: filePath,
      mode,
      bytes,
      sha256: sha256(bytes),
    });
  }
  sources.sort((left, right) => left.path.localeCompare(right.path));
  if (!sources.some((source) => source.path.startsWith("src/"))) {
    throw new ManifestError(
      "governed source tree contains no TypeScript runtime sources",
    );
  }
  if (!sources.some((source) => source.path === "specs/release-targets.json")) {
    throw new ManifestError("versioned release target profile is missing");
  }
  return sources;
}

function sourceTreeSha256(sources: GitSource[]): string {
  const hash = createHash("sha256");
  for (const source of sources) {
    hash.update(source.path);
    hash.update("\0");
    hash.update(source.mode);
    hash.update("\0");
    hash.update(source.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function literalText(node: ts.Node | undefined): string | null {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === name)),
  );
  return property?.initializer;
}

function callName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression))
    return call.expression.name.text;
  return null;
}

function lineAndSpan(
  source: ts.SourceFile,
  node: ts.Node,
): {
  line: number;
  span: { start: number; end: number };
} {
  return {
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    span: { start: node.getStart(source), end: node.getEnd() },
  };
}

function occurrence(input: Omit<Occurrence, "id">): Occurrence {
  const identity = JSON.stringify(input);
  return { id: `occ-${sha256(identity).slice(0, 20)}`, ...input };
}

function actorCliOccurrence(
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  action: string,
): Occurrence {
  if (!CLI_ACTIONS.has(action)) {
    throw new ManifestError(
      `unreviewed tiangong-lca release action: ${file}:${action}`,
    );
  }
  return occurrence({
    file,
    ...lineAndSpan(source, node),
    operation: "call",
    transport: "tiangong-lca-cli",
    credential: "actor-session-api-key",
    role: "data_product_manager",
    schema: "indirect-cli-edge-contract",
    object: `release.${action}`,
    signature: `cli:tiangong-lca release ${action}`,
    acl:
      action === "finalize"
        ? "caller=data_product_manager; downstream artifact finalization remains service-only after Edge byte/hash verification"
        : "caller=data_product_manager; Edge and Database remain authoritative for capability authorization",
    sourceClass: "runtime",
  });
}

function assertNoDirectDatabaseBypass(
  file: string,
  source: ts.SourceFile,
): void {
  const forbiddenModules = new Set([
    "@supabase/supabase-js",
    "pg",
    "postgres",
    "postgres.js",
  ]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      forbiddenModules.has(node.moduleSpecifier.text)
    ) {
      throw new ManifestError(
        `direct database client import requires reviewed parser support: ${file}`,
      );
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      const standardFrom =
        name === "from" &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        ["Array", "Buffer", "Object", "Uint8Array"].includes(
          node.expression.expression.text,
        );
      if (
        !standardFrom &&
        ["from", "rpc", "schema", "channel"].includes(name ?? "")
      ) {
        throw new ManifestError(
          `direct PostgREST/Realtime call requires reviewed parser support: ${file}:${name}`,
        );
      }
      if (["query", "execute", "unsafe"].includes(name ?? "")) {
        const first = literalText(node.arguments[0]);
        if (
          first &&
          /\b(select|insert|update|delete|call|copy|with)\b/iu.test(first)
        ) {
          throw new ManifestError(
            `direct SQL requires reviewed parser support: ${file}:${name}`,
          );
        }
        if (!first && name === "query") {
          throw new ManifestError(
            `dynamic SQL bypass requires reviewed disposition: ${file}:${name}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

export function deriveOccurrences(sources: GitSource[]): Occurrence[] {
  const found: Occurrence[] = [];
  const boundedActions = new Set<string>();
  let helper: { file: string; source: ts.SourceFile; node: ts.Node } | null =
    null;

  for (const input of sources) {
    if (input.path === "specs/release-targets.json") {
      let catalog: unknown;
      try {
        catalog = JSON.parse(input.bytes.toString("utf8"));
      } catch (error) {
        throw new ManifestError(
          `release target profile is invalid JSON: ${String(error)}`,
        );
      }
      const targets = (catalog as { targets?: unknown }).targets;
      if (!Array.isArray(targets) || targets.length === 0) {
        throw new ManifestError("release target catalog has no targets");
      }
      for (const target of targets) {
        if (!target || typeof target !== "object")
          throw new ManifestError("release target entry invalid");
        const entry = target as Record<string, unknown>;
        if (
          typeof entry.targetId !== "string" ||
          typeof entry.apiBaseUrl !== "string" ||
          !/^https:\/\/[^/]+\/functions\/v1$/u.test(entry.apiBaseUrl) ||
          typeof entry.publishableKeySha256 !== "string"
        ) {
          throw new ManifestError(
            "release target Supabase gateway profile is incomplete",
          );
        }
        const text = input.bytes.toString("utf8");
        const start = text.indexOf(JSON.stringify(entry.apiBaseUrl));
        const line = text.slice(0, start).split("\n").length;
        found.push(
          occurrence({
            file: input.path,
            line,
            span: {
              start,
              end: start + JSON.stringify(entry.apiBaseUrl).length,
            },
            operation: "configure",
            transport: "supabase-functions-gateway",
            credential: "publishable-key-profile",
            role: "credential-brokered",
            schema: "supabase-functions",
            object: `${entry.targetId}.functions-v1`,
            signature: "https://<project-ref>.supabase.co/functions/v1",
            acl: "publishable-key fingerprint plus actor session; no secret/service-role credential",
            sourceClass: "versioned-target-profile",
          }),
        );
      }
      continue;
    }

    const text = input.bytes.toString("utf8");
    const source = ts.createSourceFile(
      input.path,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    assertNoDirectDatabaseBypass(input.path, source);
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "invokeReleaseCli"
      ) {
        helper = { file: input.path, source, node };
      }
      if (ts.isCallExpression(node)) {
        const name = callName(node);
        if (name === "invokeReleaseCli") {
          const argument = node.arguments[0];
          if (!argument || !ts.isObjectLiteralExpression(argument)) {
            throw new ManifestError(
              `dynamic invokeReleaseCli argument: ${input.path}`,
            );
          }
          const action = literalText(objectProperty(argument, "action"));
          if (!action)
            throw new ManifestError(
              `dynamic release action bypass: ${input.path}`,
            );
          boundedActions.add(action);
          found.push(actorCliOccurrence(input.path, source, node, action));
        }
        if (name === "runJsonCommand") {
          const argument = node.arguments[0];
          if (argument && ts.isObjectLiteralExpression(argument)) {
            const executable = objectProperty(argument, "executable");
            const isCli =
              executable &&
              ts.isCallExpression(executable) &&
              callName(executable) === "tiangongCliExecutable";
            if (isCli) {
              const args = objectProperty(argument, "args");
              if (!args || !ts.isArrayLiteralExpression(args)) {
                throw new ManifestError(
                  `dynamic tiangong-lca args bypass: ${input.path}`,
                );
              }
              const first = literalText(args.elements[0]);
              const second = literalText(args.elements[1]);
              if (first === "release" && second) {
                found.push(
                  actorCliOccurrence(input.path, source, node, second),
                );
              } else if (
                input.path === "src/publication/remote-stages.ts" &&
                first === "release" &&
                args.elements[1] &&
                ts.isPropertyAccessExpression(args.elements[1]) &&
                args.elements[1].name.text === "action"
              ) {
                // The bounded helper is emitted after every literal action call site is collected.
              } else {
                throw new ManifestError(
                  `unresolved tiangong-lca CLI dispatch: ${input.path}`,
                );
              }
            }
          }
        }
        if (name === "fetch") {
          const first = node.arguments[0];
          if (
            !first ||
            !ts.isIdentifier(first) ||
            first.text !== "signedDownloadUrl"
          ) {
            throw new ManifestError(
              `unreviewed runtime fetch transport: ${input.path}`,
            );
          }
          found.push(
            occurrence({
              file: input.path,
              ...lineAndSpan(source, node),
              operation: "download",
              transport: "signed-storage-url",
              credential: "signed-download-url",
              role: "no-database-role",
              schema: "storage",
              object: "calculation-bundle-manifest",
              signature: "signed-url:GET application/octet-stream",
              acl: "opaque short-lived URL issued by actor-scoped CLI projection; exact byte size and SHA-256 required",
              sourceClass: "runtime",
            }),
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  if (!helper) throw new ManifestError("bounded release CLI helper is missing");
  const boundedHelper = helper as {
    file: string;
    source: ts.SourceFile;
    node: ts.Node;
  };
  const actions = [...boundedActions].sort();
  if (actions.some((action) => !CLI_ACTIONS.has(action))) {
    throw new ManifestError("bounded helper contains an unreviewed action");
  }
  found.push(
    occurrence({
      file: boundedHelper.file,
      ...lineAndSpan(boundedHelper.source, boundedHelper.node),
      operation: "dispatch",
      transport: "tiangong-lca-cli",
      credential: "actor-session-api-key",
      role: "data_product_manager",
      schema: "indirect-cli-edge-contract",
      object: "release.<bounded-action>",
      signature: `dynamic-cli-helper:${actions.join("|")}`,
      acl: "only literal reviewed release actions may reach the actor-scoped CLI helper",
      sourceClass: "runtime",
    }),
  );

  found.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.span.start - right.span.start ||
      left.operation.localeCompare(right.operation) ||
      left.object.localeCompare(right.object),
  );
  const identities = new Set(found.map((item) => JSON.stringify(item)));
  if (identities.size !== found.length)
    throw new ManifestError("derived duplicate occurrences");
  return found;
}

function countBy(
  occurrences: Occurrence[],
  field: "transport" | "credential",
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const occurrence of occurrences)
    counts[occurrence[field]] = (counts[occurrence[field]] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summary(occurrences: Occurrence[]): Manifest["summary"] {
  return {
    total: occurrences.length,
    byTransport: countBy(occurrences, "transport"),
    byCredential: countBy(occurrences, "credential"),
  };
}

function manifestBytes(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function regularArtifact(filePath: string): Buffer {
  const status = lstatSync(filePath);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new ManifestError(
      `artifact must be a no-follow regular file: ${filePath}`,
    );
  }
  return readFileSync(filePath);
}

function comparable(value: unknown): string {
  return JSON.stringify(value);
}

function assertSetEquality(
  declared: Occurrence[],
  derived: Occurrence[],
): void {
  const declaredSet = new Map(declared.map((item) => [comparable(item), item]));
  if (declaredSet.size !== declared.length)
    throw new ManifestError("manifest contains duplicate occurrences");
  const derivedSet = new Map(derived.map((item) => [comparable(item), item]));
  const missing = [...derivedSet.keys()].filter((key) => !declaredSet.has(key));
  const forged = [...declaredSet.keys()].filter((key) => !derivedSet.has(key));
  if (missing.length || forged.length) {
    throw new ManifestError(
      `source/manifest occurrence sets differ: ${JSON.stringify({
        missingFromManifest: missing
          .slice(0, 5)
          .map((key) => derivedSet.get(key)),
        notDerivedFromSource: forged
          .slice(0, 5)
          .map((key) => declaredSet.get(key)),
      })}`,
    );
  }
}

function normalizeOrigin(value: string): string {
  const normalized = value
    .replace(/^https:\/\/github\.com\//u, "")
    .replace(/^ssh:\/\/git@github\.com\//u, "")
    .replace(/^git@github\.com:/u, "")
    .replace(/\.git$/u, "");
  return normalized;
}

function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    execFileSync(
      "git",
      ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant],
      {
        stdio: "ignore",
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("GIT_"),
          ),
        ),
      },
    );
    return true;
  } catch {
    return false;
  }
}

export function buildManifest(input: {
  root: string;
  sourceCommit: string;
  baseCommit: string;
}): Manifest {
  const sourceCommit = gitText(
    input.root,
    "rev-parse",
    "--verify",
    `${input.sourceCommit}^{commit}`,
  );
  const baseCommit = gitText(
    input.root,
    "rev-parse",
    "--verify",
    `${input.baseCommit}^{commit}`,
  );
  const sources = readGitSources(input.root, sourceCommit);
  const occurrences = deriveOccurrences(sources);
  const schemaBytes = regularArtifact(path.join(input.root, SCHEMA_PATH));
  return {
    $schema: "./supabase-consumer-manifest.v3.schema.json",
    schema: "tiangong.supabase-consumer-manifest.v3",
    version: 3,
    repository: { slug: REPOSITORY, canonicalOrigin: CANONICAL_ORIGIN },
    manifestSchema: { path: SCHEMA_PATH, sha256: sha256(schemaBytes) },
    sourceSnapshot: {
      derivation: "git-tree-typescript-ast-v3",
      sourceTreeCommit: sourceCommit,
      sourceTreeSha256: sourceTreeSha256(sources),
      pathPatterns: [...SOURCE_PATTERNS],
      governedFiles: sources.map(
        ({ path: filePath, mode, sha256: digest }) => ({
          path: filePath,
          mode,
          sha256: digest,
        }),
      ),
      symlinkPolicy: "reject",
      nonRegularFilePolicy: "reject",
      setEquality: "bidirectional-exact",
    },
    delivery: {
      baseCommit,
      targetBranch: "main",
      deliveryCommit: null,
      deliveryCommitAuthority: "external-verifier-must-bind-actual-head",
      headResolution: "scan-actual-git-head",
      governedSourcePolicy: "exact-bytes-equal-source-snapshot",
    },
    authority: {
      status: "candidate",
      authorizesDatabaseFreeze: false,
      authorizesDatabaseMigration: false,
      authorizesHostedMutation: false,
      authorizesProductionMutation: false,
    },
    occurrences,
    absenceProof: {
      zeroOccurrenceTransports: [
        "postgrest-from-rpc-schema",
        "direct-postgresql-sql",
        "dynamic-sql",
        "pgmq",
        "cron",
        "realtime",
        "supabase-cli",
      ],
      forbiddenCredentials: ["service-role", "supabase-secret-key"],
      enforcement: "typescript-ast-fail-closed",
    },
    summary: summary(occurrences),
  };
}

export function verifyManifest(input: {
  root: string;
  manifestPath?: string;
  requireOrigin?: boolean;
}): Record<string, unknown> {
  const root = realpathSync(input.root);
  const manifestPath = path.resolve(root, input.manifestPath ?? MANIFEST_PATH);
  const schemaPath = path.resolve(root, SCHEMA_PATH);
  const raw = regularArtifact(manifestPath);
  const schemaRaw = regularArtifact(schemaPath);
  let manifest: Manifest;
  let schema: object;
  try {
    manifest = JSON.parse(raw.toString("utf8")) as Manifest;
    schema = JSON.parse(schemaRaw.toString("utf8")) as object;
  } catch (error) {
    throw new ManifestError(
      `manifest/schema JSON parse failed: ${String(error)}`,
    );
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  if (!ajv.validate(schema, manifest)) {
    throw new ManifestError(
      `manifest schema validation failed: ${ajv.errorsText()}`,
    );
  }
  if (manifest.manifestSchema.sha256 !== sha256(schemaRaw)) {
    throw new ManifestError("manifest schema SHA-256 drift");
  }
  if (
    manifest.repository.slug !== REPOSITORY ||
    manifest.repository.canonicalOrigin !== CANONICAL_ORIGIN
  ) {
    throw new ManifestError("repository identity drift");
  }
  const head = gitText(root, "rev-parse", "--verify", "HEAD^{commit}");
  if (!isAncestor(root, manifest.delivery.baseCommit, head)) {
    throw new ManifestError(
      "delivery baseCommit is not an ancestor of actual HEAD",
    );
  }
  if (!isAncestor(root, manifest.sourceSnapshot.sourceTreeCommit, head)) {
    throw new ManifestError(
      "audited sourceTreeCommit is not an ancestor of actual HEAD",
    );
  }
  const sourceSources = readGitSources(
    root,
    manifest.sourceSnapshot.sourceTreeCommit,
  );
  const headSources = readGitSources(root, head);
  const sourceFiles = sourceSources.map(
    ({ path: filePath, mode, sha256: digest }) => ({
      path: filePath,
      mode,
      sha256: digest,
    }),
  );
  if (
    manifest.sourceSnapshot.sourceTreeSha256 !==
      sourceTreeSha256(sourceSources) ||
    comparable(manifest.sourceSnapshot.governedFiles) !==
      comparable(sourceFiles)
  ) {
    throw new ManifestError("audited source snapshot bytes drift");
  }
  if (
    sourceTreeSha256(headSources) !== manifest.sourceSnapshot.sourceTreeSha256
  ) {
    throw new ManifestError(
      "consumer-governed source bytes drifted from sourceTreeCommit to actual HEAD",
    );
  }
  const derived = deriveOccurrences(headSources);
  assertSetEquality(manifest.occurrences, derived);
  if (comparable(manifest.summary) !== comparable(summary(derived))) {
    throw new ManifestError("manifest summary drift");
  }

  if (input.requireOrigin !== false) {
    const origin = gitText(root, "remote", "get-url", "origin");
    if (normalizeOrigin(origin) !== REPOSITORY)
      throw new ManifestError("canonical origin URL drift");
    const originMain = gitText(
      root,
      "rev-parse",
      "--verify",
      "refs/remotes/origin/main^{commit}",
    );
    if (
      !isAncestor(root, manifest.sourceSnapshot.sourceTreeCommit, originMain)
    ) {
      throw new ManifestError(
        "sourceTreeCommit is not reachable from canonical origin/main",
      );
    }
    if (!isAncestor(root, manifest.delivery.baseCommit, originMain)) {
      throw new ManifestError(
        "baseCommit is not reachable from canonical origin/main",
      );
    }
  }

  return {
    schema: manifest.schema,
    repository: REPOSITORY,
    auditedSourceTreeCommit: manifest.sourceSnapshot.sourceTreeCommit,
    deliveryCommit: head,
    deliveryCommitAuthority: manifest.delivery.deliveryCommitAuthority,
    manifestSha256: sha256(raw),
    manifestSchemaSha256: sha256(schemaRaw),
    governedSourceTreeSha256: manifest.sourceSnapshot.sourceTreeSha256,
    occurrenceCountDerived: derived.length,
    summary: summary(derived),
    setEquality: true,
    governedSourceDrift: false,
    authority: manifest.authority,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const rootOption = option("--root");
  const root = rootOption
    ? path.resolve(rootOption)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (args.includes("--generate")) {
    const sourceCommit = option("--source-commit");
    const baseCommit = option("--base-commit");
    if (!sourceCommit || !baseCommit) {
      throw new ManifestError(
        "--generate requires --source-commit and --base-commit",
      );
    }
    const output = path.resolve(root, option("--output") ?? MANIFEST_PATH);
    writeFileSync(
      output,
      manifestBytes(buildManifest({ root, sourceCommit, baseCommit })),
      {
        encoding: "utf8",
        mode: 0o644,
      },
    );
    process.stdout.write(`${output}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify(verifyManifest({ root }), null, 2)}\n`,
  );
}

const invoked =
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `consumer manifest check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
