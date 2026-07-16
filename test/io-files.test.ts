import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  relativeContainedPath,
  resolveContainedPath,
} from "../src/io/files.js";

test(
  "artifact paths remain relative when the workspace root uses a symlink alias",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "release-path-root-"));
    const aliasParent = mkdtempSync(path.join(tmpdir(), "release-path-alias-"));
    const alias = path.join(aliasParent, "workspace");
    try {
      const artifactDirectory = path.join(root, "outputs", "packages");
      const artifact = path.join(artifactDirectory, "release.zip");
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(artifact, "release-bytes");
      symlinkSync(root, alias, "dir");

      const relative = relativeContainedPath(alias, realpathSync(artifact));
      assert.equal(relative, "outputs/packages/release.zip");
      assert.equal(
        resolveContainedPath(alias, relative),
        realpathSync(artifact),
      );
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "artifact containment rejects a symlink that escapes the workspace",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "release-contained-root-"));
    const outside = mkdtempSync(
      path.join(tmpdir(), "release-contained-outside-"),
    );
    try {
      const outsideArtifact = path.join(outside, "release.zip");
      writeFileSync(outsideArtifact, "outside-release-bytes");
      symlinkSync(outsideArtifact, path.join(root, "release.zip"), "file");

      assert.throws(
        () => resolveContainedPath(root, "release.zip"),
        /artifact_path_outside_bundle/u,
      );
      assert.throws(
        () => relativeContainedPath(root, outsideArtifact),
        /artifact_path_outside_bundle/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);
