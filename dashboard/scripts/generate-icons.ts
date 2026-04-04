/**
 * Generate PWA icons for Mission Control.
 * Run: cd dashboard && npx tsx scripts/generate-icons.ts
 *
 * Creates 3 PNGs:
 * - icon-192.png (192x192)
 * - icon-512.png (512x512)
 * - icon-maskable-512.png (512x512 with safe zone padding)
 *
 * Design: Near-black background, OSA Orange geometric "D" + plane accent.
 */

import { createCanvas } from "canvas";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = resolve(__dirname, "..", "public", "icons");

const BG = "#1A1A1A";
const ORANGE = "#E74B1D";

function drawIcon(size: number, maskable: boolean): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = maskable ? BG : "transparent";
  if (maskable) {
    ctx.fillRect(0, 0, size, size);
  } else {
    // Rounded rect background
    const r = size * 0.18;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r);
    ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size);
    ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = BG;
    ctx.fill();
  }

  const cx = size / 2;
  const cy = size / 2;
  const scale = size / 512;

  // Safe zone for maskable: only use inner 80%
  const offset = maskable ? size * 0.1 : 0;
  const innerSize = size - offset * 2;
  const iScale = innerSize / 512;
  const ix = offset + innerSize / 2;
  const iy = offset + innerSize / 2;

  const s = maskable ? iScale : scale;
  const ox = maskable ? ix : cx;
  const oy = maskable ? iy : cy;

  // Draw "D" letterform
  ctx.fillStyle = ORANGE;
  ctx.font = `bold ${280 * s}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("D", ox, oy + 8 * s);

  // Small plane accent (top-right of D)
  ctx.save();
  ctx.translate(ox + 80 * s, oy - 100 * s);
  ctx.rotate(-0.3);
  ctx.fillStyle = ORANGE;
  ctx.beginPath();
  // Simple triangle plane silhouette
  ctx.moveTo(0, -20 * s);
  ctx.lineTo(30 * s, 10 * s);
  ctx.lineTo(-30 * s, 10 * s);
  ctx.closePath();
  ctx.fill();
  // Wing
  ctx.fillRect(-25 * s, 0, 50 * s, 6 * s);
  ctx.restore();

  return canvas.toBuffer("image/png");
}

// Generate all three icons
writeFileSync(resolve(ICONS_DIR, "icon-192.png"), drawIcon(192, false));
writeFileSync(resolve(ICONS_DIR, "icon-512.png"), drawIcon(512, false));
writeFileSync(resolve(ICONS_DIR, "icon-maskable-512.png"), drawIcon(512, true));

console.log("Icons generated in public/icons/:");
console.log("  icon-192.png (192x192)");
console.log("  icon-512.png (512x512)");
console.log("  icon-maskable-512.png (512x512, maskable)");
