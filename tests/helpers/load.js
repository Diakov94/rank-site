"use strict";
/* Loads the site's classic scripts into one vm context, the way the pages load them:
 * separate scripts that share a single global scope. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_FILES = ["js/common.js", "js/sheets.js", "js/engine.js"];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * loadSite({ fetch, console, files }) -> proxy of the scripts' globals.
 * Top-level const/let are not properties of the context's global object, so each name is
 * evaluated inside the context. Extras on the returned object:
 *   site.$context    the vm context
 *   site.$setFetch   replaces the global fetch the scripts call
 *   site.$eval(code) runs code in the context
 */
function loadSite(options = {}) {
  const context = vm.createContext({
    console: options.console ?? console,
    URL,
    setTimeout,
    clearTimeout,
    fetch: options.fetch ?? (() => Promise.reject(new Error("fetch is not stubbed"))),
  });
  for (const file of options.files ?? DEFAULT_FILES) {
    const code = fs.readFileSync(path.join(ROOT, file), "utf8");
    vm.runInContext(code, context, { filename: file });
  }

  const extras = {
    $context: context,
    $setFetch: (fn) => { context.fetch = fn; },
    $eval: (code) => vm.runInContext(code, context),
  };
  return new Proxy(extras, {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name !== "string" || !IDENTIFIER.test(name)) return undefined;
      return vm.runInContext(`typeof ${name} === "undefined" ? undefined : ${name}`, context);
    },
  });
}

/* A console for loadSite that drops everything the scripts print. */
const silentConsole = { log() {}, warn() {}, error() {} };

/* Values created inside the context have that realm's prototypes, which
 * assert.deepStrictEqual treats as different. Copy them into plain local values. */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = { loadSite, plain, silentConsole, ROOT };
