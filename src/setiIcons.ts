import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Resolves file icons from the active (default) Seti file-icon theme so the
 * custom SCM webview shows the SAME glyphs as the Explorer. Seti is font-based:
 * the theme JSON maps files → icon definitions ({fontCharacter, fontColor}),
 * resolved by file name, then extension, then LANGUAGE ID. We rebuild the
 * extension→language map from every installed extension's `contributes.languages`
 * (that's how VS Code picks the language), then look the glyph up. The .woff is
 * embedded as a base64 data URI so the webview is self-contained (no cross-bundle
 * resource URIs). Best-effort: returns null when the theme can't be loaded.
 */

interface IconDef {
  fontCharacter: string;
  fontColor?: string;
}
interface Resolved {
  char: string;
  color: string;
}

let theme: any | undefined;
let woffBase64Cache: string | undefined;
const extToLang = new Map<string, string>();
const nameToLang = new Map<string, string>();
let loaded = false;

export function initSetiIcons(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const dir = path.join(vscode.env.appRoot, "extensions", "theme-seti", "icons");
    theme = JSON.parse(fs.readFileSync(path.join(dir, "vs-seti-icon-theme.json"), "utf8"));
    woffBase64Cache = fs.readFileSync(path.join(dir, "seti.woff")).toString("base64");
  } catch {
    theme = undefined;
  }
  // Language associations from all extensions (same source VS Code uses).
  for (const e of vscode.extensions.all) {
    const langs = e.packageJSON?.contributes?.languages;
    if (!Array.isArray(langs)) {
      continue;
    }
    for (const l of langs) {
      for (const x of l.extensions ?? []) {
        extToLang.set(String(x).toLowerCase(), l.id);
      }
      for (const n of l.filenames ?? []) {
        nameToLang.set(String(n).toLowerCase(), l.id);
      }
    }
  }
}

export function setiWoffBase64(): string | undefined {
  return woffBase64Cache;
}

let codiconCache: string | undefined;
/** Cursor's codicon.ttf as base64, so the webview can use real codicon glyphs
 *  (chevrons etc.). Empty string cached on failure → returns undefined. */
export function codiconBase64(): string | undefined {
  if (codiconCache === undefined) {
    try {
      codiconCache = fs
        .readFileSync(path.join(vscode.env.appRoot, "out", "media", "codicon.ttf"))
        .toString("base64");
    } catch {
      codiconCache = "";
    }
  }
  return codiconCache || undefined;
}

/** Maps for the light theme variant merge over the base when the theme is light. */
function maps(light: boolean): { file: string; fileNames: any; fileExtensions: any; languageIds: any } {
  const base = theme;
  const lt = light ? theme.light ?? {} : {};
  return {
    file: lt.file ?? base.file,
    fileNames: { ...base.fileNames, ...(lt.fileNames ?? {}) },
    fileExtensions: { ...base.fileExtensions, ...(lt.fileExtensions ?? {}) },
    languageIds: { ...base.languageIds, ...(lt.languageIds ?? {}) },
  };
}

function defIdFor(name: string, m: ReturnType<typeof maps>): string {
  if (m.fileNames[name]) {
    return m.fileNames[name];
  }
  const parts = name.split(".");
  // Longest extension first: "a.test.ts" → "test.ts", then "ts".
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    if (m.fileExtensions[ext]) {
      return m.fileExtensions[ext];
    }
  }
  let lang = nameToLang.get(name);
  if (!lang) {
    for (let i = 1; i < parts.length; i++) {
      const dotExt = "." + parts.slice(i).join(".");
      const found = extToLang.get(dotExt);
      if (found) {
        lang = found;
        break;
      }
    }
  }
  if (lang && m.languageIds[lang]) {
    return m.languageIds[lang];
  }
  return m.file;
}

function toChar(fontCharacter: string): string {
  const hex = fontCharacter.replace(/\\/g, "");
  const code = Number.parseInt(hex, 16);
  return Number.isFinite(code) ? String.fromCharCode(code) : "";
}

/** The Seti glyph + color for a file basename, or null if the theme is missing. */
export function resolveFileIcon(basename: string, light: boolean): Resolved | null {
  if (!theme) {
    return null;
  }
  const m = maps(light);
  const def: IconDef | undefined =
    theme.iconDefinitions[defIdFor(basename.toLowerCase(), m)] ?? theme.iconDefinitions[m.file];
  if (!def) {
    return null;
  }
  return { char: toChar(def.fontCharacter), color: def.fontColor ?? "inherit" };
}
