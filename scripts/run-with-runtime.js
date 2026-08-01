#!/usr/bin/env node
"use strict";

require("dotenv").config();

const path = require("node:path");
const { spawn } = require("node:child_process");
const { loadAwsSecrets } = require("../config/load-aws-secrets");

function resolveTarget(argument) {
  const target = String(argument || "").trim();
  if (!target) {
    throw new Error(
      "Usage: node scripts/run-with-runtime.js <script-path> [arguments...]",
    );
  }

  const root = path.resolve(__dirname, "..");
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Runtime script must be inside the provider portal project");
  }

  return resolved;
}

async function run({
  argv = process.argv.slice(2),
  loadSecrets = loadAwsSecrets,
  spawnImpl = spawn,
} = {}) {
  const [targetArgument, ...scriptArguments] = argv;
  const target = resolveTarget(targetArgument);
  const secretResult = await loadSecrets();

  if (!secretResult.skipped) {
    console.log(
      `Provider configuration loaded from AWS Secrets Manager (${secretResult.loaded} values)`,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [target, ...scriptArguments], {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Runtime script terminated by signal ${signal}`));
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

if (require.main === module) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = { resolveTarget, run };
