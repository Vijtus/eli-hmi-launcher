import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ALLOWED_COLOR_LITERALS = new Set(["#000000", "#ffffff"]);

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function assertStrictMonochromeCss(cssSource: string, sourceName: string): void {
  const css = stripCssComments(cssSource);
  const hexColors = css.match(/#[0-9a-f]{3,8}(?![0-9a-f])/gi) ?? [];

  for (const color of hexColors) {
    assert.ok(
      ALLOWED_COLOR_LITERALS.has(color.toLowerCase()),
      `${sourceName} contains disallowed color literal ${color}`,
    );
  }

  const functionalColors =
    css.match(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|device-cmyk)\s*\(/gi) ?? [];
  assert.deepEqual(
    functionalColors,
    [],
    `${sourceName} contains functional color syntax: ${functionalColors.join(", ")}`,
  );

  const gradients =
    css.match(/\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/gi) ?? [];
  assert.deepEqual(
    gradients,
    [],
    `${sourceName} contains a gradient: ${gradients.join(", ")}`,
  );
}

test("renderer-authored CSS uses only the strict black-and-white palette", async () => {
  const rendererCss = await readFile(
    new URL("../src/renderer/styles.css", import.meta.url),
    "utf8",
  );

  assertStrictMonochromeCss(rendererCss, "src/renderer/styles.css");
});

test("startup configuration error CSS uses only the strict black-and-white palette", async () => {
  const mainSource = await readFile(
    new URL("../src/main/index.ts", import.meta.url),
    "utf8",
  );
  const styleBlocks = [...mainSource.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1]);

  assert.ok(styleBlocks.length > 0, "src/main/index.ts must retain visible startup error styling");
  assertStrictMonochromeCss(styleBlocks.join("\n"), "inline startup error CSS");
});
