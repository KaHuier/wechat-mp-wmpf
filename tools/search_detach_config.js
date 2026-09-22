"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_ROOT = path.join(__dirname, "offsets", "search_detach");

function runtimeVersionFromPath(fluePath) {
  const normalized = String(fluePath || "");
  const match = normalized.match(/[\\/]RadiumWMPF[\\/](\d+)[\\/]/i)
    || normalized.match(/[\\/](\d+)[\\/]extracted[\\/]runtime[\\/]flue\.dll$/i);
  if (!match) throw new Error(`cannot determine WMPF version from flue path: ${normalized}`);
  return Number(match[1]);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex").toUpperCase();
}

function assertHexOffset(value, field) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`invalid ${field} in Search detach config`);
  }
}

function loadSearchDetachConfig(fluePath, configRoot = DEFAULT_CONFIG_ROOT) {
  const version = runtimeVersionFromPath(fluePath);
  const sha256 = sha256File(fluePath);
  const configPath = path.join(configRoot, String(version), `${sha256}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Search detach offsets not found for WMPF ${version}, flue.dll SHA256 ${sha256}: ${configPath}`,
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.schemaVersion !== 1 || config.version !== version
      || String(config.flueSha256).toUpperCase() !== sha256) {
    throw new Error(`Search detach config identity mismatch: ${configPath}`);
  }
  const required = [
    "valueInit", "dictSet", "invokeNative", "valueDestroy", "manager",
    "dispatchPoint", "bizKey",
  ];
  for (const field of required) assertHexOffset(config.offsets?.[field], `offsets.${field}`);
  return {config, configPath, version, sha256};
}

module.exports = {
  DEFAULT_CONFIG_ROOT,
  loadSearchDetachConfig,
  runtimeVersionFromPath,
  sha256File,
};
