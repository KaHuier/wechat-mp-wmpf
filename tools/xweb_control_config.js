"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {runtimeVersionFromPath, sha256File} = require("./search_detach_config");

const DEFAULT_CONFIG_ROOT = path.join(__dirname, "offsets", "xweb_control");

function loadXwebControlConfig(fluePath, configRoot = DEFAULT_CONFIG_ROOT) {
  const version = runtimeVersionFromPath(fluePath);
  const sha256 = sha256File(fluePath);
  const configPath = path.join(configRoot, String(version), `${sha256}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `XWeb control offsets not found for WMPF ${version}, flue.dll SHA256 ${sha256}: ${configPath}`,
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.schemaVersion !== 1 || config.version !== version
      || String(config.flueSha256).toUpperCase() !== sha256) {
    throw new Error(`XWeb control config identity mismatch: ${configPath}`);
  }
  for (const field of ["getManager", "getDebugSetting", "setDebugSetting", "dispatchPoint"]) {
    if (typeof config.offsets?.[field] !== "string"
        || !/^0x[0-9a-f]+$/i.test(config.offsets[field])) {
      throw new Error(`invalid offsets.${field} in XWeb control config`);
    }
  }
  return {config, configPath, version, sha256};
}

module.exports = {DEFAULT_CONFIG_ROOT, loadXwebControlConfig};
