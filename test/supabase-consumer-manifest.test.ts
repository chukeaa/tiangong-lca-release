import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildManifest,
  deriveOccurrences,
  readGitSources,
  verifyManifest,
} from "../scripts/verify-supabase-consumer-manifest.js";

const schemaSource = path.resolve(
  "contracts/supabase-consumer-manifest.v3.schema.json",
);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
  }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixture(): {
  root: string;
  commit: string;
  manifestPath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "release-consumer-manifest-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "manifest-test@example.invalid");
  git(root, "config", "user.name", "Manifest Test");
  git(root, "config", "core.hooksPath", "/dev/null");
  mkdirSync(path.join(root, "src/publication"), { recursive: true });
  mkdirSync(path.join(root, "specs"), { recursive: true });
  mkdirSync(path.join(root, "contracts"), { recursive: true });
  writeFileSync(
    path.join(root, "src/publication/remote-stages.ts"),
    `async function invokeReleaseCli(input: { action: string }): Promise<void> { void input; }\n` +
      `void invokeReleaseCli({ action: "prepare" });\n`,
    "utf8",
  );
  writeJson(path.join(root, "specs/release-targets.json"), {
    schemaVersion: "tiangong.release-target-catalog.v1",
    targets: [
      {
        schemaVersion: "tiangong.release-target-profile.v1",
        targetId: "fixture",
        apiBaseUrl: "https://fixture.invalid/functions/v1",
        publishableKeySha256: "a".repeat(64),
      },
    ],
  });
  copyFileSync(
    schemaSource,
    path.join(root, "contracts/supabase-consumer-manifest.v3.schema.json"),
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture source");
  const commit = git(root, "rev-parse", "HEAD");
  const manifestPath = path.join(
    root,
    "contracts/supabase-consumer-manifest.v3.json",
  );
  writeJson(
    manifestPath,
    buildManifest({ root, sourceCommit: commit, baseCommit: commit }),
  );
  return {
    root,
    commit,
    manifestPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function mutateManifest(
  fixtureRoot: ReturnType<typeof fixture>,
  mutation: (manifest: Record<string, any>) => void,
): void {
  const manifest = JSON.parse(
    readFileSync(fixtureRoot.manifestPath, "utf8"),
  ) as Record<string, any>;
  mutation(manifest);
  writeJson(fixtureRoot.manifestPath, manifest);
}

test("repository manifest derives an exact candidate snapshot", () => {
  const result = verifyManifest({
    root: path.resolve("."),
    requireOrigin: true,
  });
  assert.equal(result.setEquality, true);
  assert.equal(result.governedSourceDrift, false);
  assert.equal(result.occurrenceCountDerived, 16);
  assert.deepEqual(result.authority, {
    status: "candidate",
    authorizesDatabaseFreeze: false,
    authorizesDatabaseMigration: false,
    authorizesHostedMutation: false,
    authorizesProductionMutation: false,
  });
});

test("AST derivation covers bounded CLI, gateway profile, and signed download", () => {
  const head = git(path.resolve("."), "rev-parse", "HEAD");
  const occurrences = deriveOccurrences(
    readGitSources(path.resolve("."), head),
  );
  const transports = new Map<string, number>();
  for (const occurrence of occurrences) {
    transports.set(
      occurrence.transport,
      (transports.get(occurrence.transport) ?? 0) + 1,
    );
  }
  assert.deepEqual(Object.fromEntries(transports), {
    "supabase-functions-gateway": 2,
    "tiangong-lca-cli": 13,
    "signed-storage-url": 1,
  });
  assert.equal(
    occurrences.some(
      (occurrence) =>
        occurrence.operation === "dispatch" &&
        occurrence.signature.includes("artifact-download") &&
        occurrence.signature.includes("upload"),
    ),
    true,
  );
});

for (const [name, mutate, message] of [
  [
    "missing occurrence",
    (manifest: Record<string, any>) => manifest.occurrences.pop(),
    /sets differ/u,
  ],
  [
    "duplicate occurrence",
    (manifest: Record<string, any>) =>
      manifest.occurrences.push(structuredClone(manifest.occurrences[0])),
    /duplicate occurrences/u,
  ],
  [
    "forged path",
    (manifest: Record<string, any>) =>
      (manifest.occurrences[0].file = "src/fake.ts"),
    /sets differ/u,
  ],
  [
    "forged line",
    (manifest: Record<string, any>) => (manifest.occurrences[0].line = 999),
    /sets differ/u,
  ],
  [
    "forged operation",
    (manifest: Record<string, any>) =>
      (manifest.occurrences[0].operation = "download"),
    /sets differ/u,
  ],
  [
    "authority escalation",
    (manifest: Record<string, any>) =>
      (manifest.authority.authorizesDatabaseMigration = true),
    /schema validation/u,
  ],
  [
    "embedded delivery SHA self-reference",
    (manifest: Record<string, any>) =>
      (manifest.delivery.deliveryCommit = "0".repeat(40)),
    /schema validation/u,
  ],
] as const) {
  test(`rejects ${name}`, () => {
    const item = fixture();
    try {
      mutateManifest(item, mutate);
      assert.throws(
        () => verifyManifest({ root: item.root, requireOrigin: false }),
        message,
      );
    } finally {
      item.cleanup();
    }
  });
}

test("rejects schema-byte drift", () => {
  const item = fixture();
  try {
    writeFileSync(
      path.join(
        item.root,
        "contracts/supabase-consumer-manifest.v3.schema.json",
      ),
      `${readFileSync(schemaSource, "utf8")} `,
      "utf8",
    );
    assert.throws(
      () => verifyManifest({ root: item.root, requireOrigin: false }),
      /schema SHA-256 drift/u,
    );
  } finally {
    item.cleanup();
  }
});

test("rejects consumer-governed source drift at actual HEAD", () => {
  const item = fixture();
  try {
    writeFileSync(
      path.join(item.root, "src/publication/remote-stages.ts"),
      `async function invokeReleaseCli(input: { action: string }): Promise<void> { void input; }\n` +
        `void invokeReleaseCli({ action: "publish" });\n`,
      "utf8",
    );
    git(item.root, "add", ".");
    git(item.root, "commit", "-qm", "drift consumer source");
    assert.throws(
      () => verifyManifest({ root: item.root, requireOrigin: false }),
      /consumer-governed source bytes drifted/u,
    );
  } finally {
    item.cleanup();
  }
});

test("rejects dynamic SQL and direct PostgREST bypasses", () => {
  const item = fixture();
  try {
    const source = path.join(item.root, "src/direct.ts");
    writeFileSync(source, 'client.from("lca_release_runs");\n', "utf8");
    git(item.root, "add", ".");
    git(item.root, "commit", "-qm", "direct bypass");
    const head = git(item.root, "rev-parse", "HEAD");
    assert.throws(
      () =>
        buildManifest({
          root: item.root,
          sourceCommit: head,
          baseCommit: item.commit,
        }),
      /direct PostgREST/u,
    );
    writeFileSync(source, "database.query(dynamicSql);\n", "utf8");
    git(item.root, "add", ".");
    git(item.root, "commit", "-qm", "dynamic bypass");
    const dynamicHead = git(item.root, "rev-parse", "HEAD");
    assert.throws(
      () =>
        buildManifest({
          root: item.root,
          sourceCommit: dynamicHead,
          baseCommit: item.commit,
        }),
      /dynamic SQL bypass/u,
    );
  } finally {
    item.cleanup();
  }
});

test("rejects symlink and non-regular artifacts without following them", () => {
  const item = fixture();
  try {
    const target = path.join(item.root, "manifest-target.json");
    copyFileSync(item.manifestPath, target);
    unlinkSync(item.manifestPath);
    symlinkSync(target, item.manifestPath);
    assert.throws(
      () => verifyManifest({ root: item.root, requireOrigin: false }),
      /no-follow regular file/u,
    );
    unlinkSync(item.manifestPath);
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [item.manifestPath]);
      assert.throws(
        () => verifyManifest({ root: item.root, requireOrigin: false }),
        /no-follow regular file/u,
      );
    }
  } finally {
    item.cleanup();
  }
});

test("rejects a governed source symlink committed in Git", () => {
  const item = fixture();
  try {
    const link = path.join(item.root, "src/linked.ts");
    symlinkSync("publication/remote-stages.ts", link);
    git(item.root, "add", "src/linked.ts");
    git(item.root, "commit", "-qm", "source symlink");
    const head = git(item.root, "rev-parse", "HEAD");
    assert.throws(
      () => readGitSources(item.root, head),
      /symlink\/non-regular/u,
    );
  } finally {
    item.cleanup();
  }
});

test("rejects non-ancestor commit and canonical-origin drift", () => {
  const item = fixture();
  try {
    mutateManifest(item, (manifest) => {
      manifest.delivery.baseCommit = "0".repeat(40);
    });
    assert.throws(
      () => verifyManifest({ root: item.root, requireOrigin: false }),
      /baseCommit is not an ancestor/u,
    );
  } finally {
    item.cleanup();
  }
});

test("rejects canonical origin URL and origin-main provenance drift", () => {
  const item = fixture();
  try {
    git(
      item.root,
      "remote",
      "add",
      "origin",
      "git@github.com:wrong/repository.git",
    );
    git(item.root, "update-ref", "refs/remotes/origin/main", item.commit);
    assert.throws(
      () => verifyManifest({ root: item.root, requireOrigin: true }),
      /canonical origin URL drift/u,
    );
    git(
      item.root,
      "remote",
      "set-url",
      "origin",
      "git@github.com:chukeaa/tiangong-lca-release.git",
    );
    git(item.root, "checkout", "--orphan", "unrelated");
    writeFileSync(path.join(item.root, "unrelated.txt"), "unrelated\n", "utf8");
    git(item.root, "add", "unrelated.txt");
    git(item.root, "commit", "-qm", "unrelated origin main");
    const unrelated = git(item.root, "rev-parse", "HEAD");
    git(item.root, "update-ref", "refs/remotes/origin/main", unrelated);
    git(item.root, "checkout", "main");
    assert.throws(
      () => verifyManifest({ root: item.root, requireOrigin: true }),
      /sourceTreeCommit is not reachable/u,
    );
  } finally {
    item.cleanup();
  }
});
