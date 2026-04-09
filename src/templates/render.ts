/**
 * Template renderer — interpolates {{variable}} placeholders.
 * Loads HTML templates from the templates/email/ directory.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEMPLATE_CACHE = new Map<string, string>();

/**
 * Load and cache an email template by name.
 * @param name - Template name (e.g. "operator-rfq", "client-quote").
 * @returns Raw HTML string with {{placeholders}}.
 */
function loadTemplate(name: string): string {
  const cached = TEMPLATE_CACHE.get(name);
  if (cached) return cached;

  const path = resolve(__dirname, "email", `${name}.html`);
  const content = readFileSync(path, "utf-8");
  TEMPLATE_CACHE.set(name, content);
  return content;
}

/**
 * Render a template with data interpolation.
 * Replaces all {{key}} placeholders with values from the data object.
 * Missing keys are replaced with empty string.
 *
 * @param templateName - Template to render (e.g. "operator-rfq").
 * @param data - Key-value pairs for interpolation.
 * @returns Rendered HTML string.
 */
export function renderTemplate(templateName: string, data: Record<string, string | number>): string {
  let html = loadTemplate(templateName);
  for (const [key, value] of Object.entries(data)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, "g"), String(value));
  }
  // Remove any remaining unreplaced placeholders
  html = html.replace(/\{\{[^}]+\}\}/g, "");
  return html;
}

/** Clear the template cache (for testing). */
export function _clearTemplateCache(): void {
  TEMPLATE_CACHE.clear();
}
