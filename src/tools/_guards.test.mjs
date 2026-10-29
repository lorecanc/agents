import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// @opencode-ai/plugin is not installed in this repo. Register sync module hooks
// BEFORE the dynamic imports below so every tool module resolves against a stub
// whose `tool(def)` returns `def` and whose `tool.schema` is a self-returning
// Proxy (covers .string/.enum/.array/.record/.int/.min/.max/.optional/.describe).
const STUB_SOURCE = `
const selfReturning = () => new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === "then") return undefined
    return selfReturning()
  },
  apply() {
    return selfReturning()
  },
})
export const tool = Object.assign((def) => def, { schema: selfReturning() })
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin") {
      return { url: "opencode-plugin-stub://plugin", shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith("opencode-plugin-stub:")) {
      return { format: "module", source: STUB_SOURCE, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const loadTool = async (name) => (await import(`./${name}.ts`)).default
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

test("stub hooks expose execute on guarded tool modules", async () => {
  const docList = await loadTool("doc_list")
  assert.equal(typeof docList.execute, "function")
})

test("doc_list rejects projectName traversal before spawning python", async () => {
  const docList = await loadTool("doc_list")
  const result = await docList.execute({ projectName: "../escape" }, {})
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("projectName"), result)
})

test("doc_create rejects projectName traversal before any tmp write", async () => {
  const docCreate = await loadTool("doc_create")
  // Guards are the first statements of execute(), so this returns before the
  // tmpFile write and no filesystem access happens.
  const result = await docCreate.execute({ projectName: "../escape" }, {})
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("projectName"), result)
})

test("slide_generate_image rejects projectName traversal", async () => {
  const generateImage = await loadTool("slide_generate_image")
  const result = await generateImage.execute(
    { projectName: "../escape", assetName: "hero.jpg", prompt: "x", imageType: "diagram" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("projectName"), result)
})

test("slide_generate_image rejects assetName path separators", async () => {
  const generateImage = await loadTool("slide_generate_image")
  const result = await generateImage.execute(
    { projectName: "proj", assetName: "a/b.png", prompt: "x", imageType: "diagram" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("assetName"), result)
})

test("slide_screenshot rejects slideName traversal", async () => {
  const screenshot = await loadTool("slide_screenshot")
  const result = await screenshot.execute(
    { projectName: "proj", slideName: "../evil" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("slideName"), result)
})

test("slide_assemble_pptx reports the offending slideNames index", async () => {
  const assemble = await loadTool("slide_assemble_pptx")
  const result = await assemble.execute(
    {
      projectName: "proj",
      templatePath: "/tmp/template.pptx",
      slideNames: ["ok", "../bad"],
      layoutMap: {},
      outputFilename: "deck",
    },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("slideNames[1]"), result)
})

test("slide_build_pptx reports the offending slideNames index", async () => {
  const buildPptx = await loadTool("slide_build_pptx")
  const result = await buildPptx.execute(
    {
      projectName: "proj",
      slideNames: ["ok", "../bad"],
      outputFilename: "deck",
    },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("slideNames[1]"), result)
})

test("slide_compile_theme rejects designSystem traversal", async () => {
  const compileTheme = await loadTool("slide_compile_theme")
  const result = await compileTheme.execute(
    { projectName: "proj", designSystem: "../evil" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("designSystem"), result)
})

test("slide_compile_composition rejects preset traversal", async () => {
  const compileComposition = await loadTool("slide_compile_composition")
  const result = await compileComposition.execute(
    { projectName: "proj", preset: "../x" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("preset"), result)
})

test("slide_analyze_template rejects designName traversal", async () => {
  const analyzeTemplate = await loadTool("slide_analyze_template")
  const result = await analyzeTemplate.execute(
    { templatePath: "/tmp/template.pptx", designName: "../evil" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("designName"), result)
})

test("slide_create_thumbnails rejects outputPrefix traversal", async () => {
  const thumbnails = await loadTool("slide_create_thumbnails")
  const result = await thumbnails.execute(
    { pptxPath: "missing.pptx", outputPrefix: "../x" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("outputPrefix"), result)
})

test("slide_create_thumbnails accepts an undefined outputPrefix", async () => {
  const thumbnails = await loadTool("slide_create_thumbnails")
  const result = await thumbnails.execute({ pptxPath: "missing.pptx" }, {})
  assert.ok(!result.startsWith("Error: Invalid"), result)
  assert.ok(result.startsWith("Error: PPTX file not found"), result)
})

test("slide_build_pptx passes guards and reaches the project lookup", async () => {
  const buildPptx = await loadTool("slide_build_pptx")
  const result = await buildPptx.execute(
    {
      projectName: "no_such_project",
      slideNames: ["slide_01"],
      outputFilename: "deck",
    },
    {},
  )
  assert.ok(result.startsWith("Error: Project directory not found"), result)
})

test("slide_generate_image passes guards and reaches the API key check", async () => {
  const generateImage = await loadTool("slide_generate_image")
  const gemini = process.env.GEMINI_API_KEY
  const google = process.env.GOOGLE_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  try {
    const result = await generateImage.execute(
      { prompt: "x", imageType: "diagram", projectName: "proj", assetName: "hero.jpg" },
      {},
    )
    assert.ok(result.startsWith("Error: No Gemini API key"), result)
  } finally {
    if (gemini !== undefined) process.env.GEMINI_API_KEY = gemini
    if (google !== undefined) process.env.GOOGLE_API_KEY = google
  }
})

test("slide_download_image verifies SHA-256 and MD5 before writing", async () => {
  const downloadImage = await loadTool("slide_download_image")
  const originalFetch = globalThis.fetch
  const originalCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), "slide-image-checksum-"))
  const image = Buffer.from("test image bytes")
  const sha256 = createHash("sha256").update(image).digest("hex")
  const md5 = createHash("md5").update(image).digest("hex")
  let fetchCalls = 0

  try {
    process.chdir(tempDir)
    globalThis.fetch = async () => {
      fetchCalls += 1
      return {
        ok: true,
        arrayBuffer: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
      }
    }

    const success = await downloadImage.execute(
      { projectName: "checks", imageName: "matching.png", url: "https://example.test/image.png", sha256: sha256.toUpperCase(), md5 },
      {},
    )
    assert.ok(success.includes(`SHA-256: ${sha256}`), success)
    assert.ok(success.includes(`MD5: ${md5}`), success)
    const outputPath = join(tempDir, "projects", "checks", "presentations", "assets")
    assert.deepEqual(readFileSync(join(outputPath, "matching.png")), image)

    const rejected = [
      ["sha-mismatch.png", { sha256: "0".repeat(64) }, "SHA-256 checksum mismatch"],
      ["md5-mismatch.png", { md5: "0".repeat(32) }, "MD5 checksum mismatch"],
      ["sha-malformed.png", { sha256: "not-a-digest" }, "Invalid sha256"],
      ["md5-malformed.png", { md5: "not-a-digest" }, "Invalid md5"],
    ]
    for (const [imageName, checksums, expectedError] of rejected) {
      const result = await downloadImage.execute(
        { projectName: "checks", imageName, url: "https://example.test/image.png", ...checksums },
        {},
      )
      assert.ok(result.includes(expectedError), result)
      assert.equal(existsSync(join(outputPath, imageName)), false)
    }
    assert.equal(fetchCalls, 3, "malformed digests must be rejected before downloading")
  } finally {
    globalThis.fetch = originalFetch
    process.chdir(originalCwd)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("html_docx_images embeds only images with matching SHA-256 and MD5", () => {
  const python = String.raw`
import hashlib
import sys
import tempfile
import types
from pathlib import Path
sys.path.insert(0, sys.argv[1])

# Isolate checksum logic from the optional document-generation dependencies.
bs4 = types.ModuleType("bs4")
bs4.__path__ = []
bs4_element = types.ModuleType("bs4.element")
bs4_element.Tag = type("Tag", (), {})
sys.modules["bs4"] = bs4
sys.modules["bs4.element"] = bs4_element
cairosvg = types.ModuleType("cairosvg")
cairosvg.svg2png = lambda **_kwargs: b""
sys.modules["cairosvg"] = cairosvg
docx = types.ModuleType("docx")
docx.__path__ = []
docx_shared = types.ModuleType("docx.shared")
docx_shared.Pt = lambda value: value
sys.modules["docx"] = docx
sys.modules["docx.shared"] = docx_shared
css = types.ModuleType("html_docx_css")
css._parse_length_to_pt = lambda _value: None
sys.modules["html_docx_css"] = css
selectors = types.ModuleType("html_docx_selectors")
selectors._compute_style_map = lambda *_args: {}
sys.modules["html_docx_selectors"] = selectors

import html_docx_images as images

data = b"test image bytes"
sha256 = hashlib.sha256(data).hexdigest()
md5 = hashlib.md5(data).hexdigest()

class Response:
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return None
    def read(self):
        return data

images.urlopen = lambda *_args, **_kwargs: Response()
source = "https://example.test/image.png"
def markup(sha=None, md5_value=None):
    attrs = (f' data-sha256="{sha}"' if sha is not None else "")
    attrs += (f' data-md5="{md5_value}"' if md5_value is not None else "")
    return f'<img src="{source}"{attrs}>'

valid = images.embed_local_images(markup(sha256, md5), Path("."))
assert "data:image/png;base64," in valid and source not in valid, valid
assert images.embed_local_images(markup("0" * 64, md5), Path(".")) == markup("0" * 64, md5)
assert images.embed_local_images(markup(sha256, "0" * 32), Path(".")) == markup(sha256, "0" * 32)
assert images.embed_local_images(markup("bad", md5), Path(".")) == markup("bad", md5)
assert images.embed_local_images(markup(sha256, "bad"), Path(".")) == markup(sha256, "bad")

assert images.verify_image_digest(data, sha256.upper(), md5.upper())
assert not images.verify_image_digest(data, "bad", md5)
assert not images.verify_image_digest(data, sha256, "bad")
data_stream = images._load_image_stream(f"data:image/png,{data.decode()}", sha256, md5)
assert data_stream is not None and data_stream.read() == data
assert images._load_image_stream(f"data:image/png,{data.decode()}", "0" * 64) is None
stream = images._load_image_stream(f"{source}?sha256={sha256}#md5={md5}")
assert stream is not None and stream.read() == data
assert images._load_image_stream(f"{source}?sha256={'0' * 64}") is None
with tempfile.TemporaryDirectory() as directory:
    local_path = Path(directory) / "local.png"
    local_path.write_bytes(data)
    local_stream = images._load_image_stream(str(local_path), sha256, md5)
    assert local_stream is not None and local_stream.read() == data
    file_uri_stream = images._load_image_stream(f"{local_path.as_uri()}?sha256={sha256}#md5={md5}")
    assert file_uri_stream is not None and file_uri_stream.read() == data
    windows_path = r"C:\Users\runneradmin\AppData\Local\Temp\local.png"
    windows_src = f"{windows_path}?sha256={sha256}#md5={md5}"
    original_path = images.Path
    images.Path = lambda value: local_path if str(value) == windows_path else original_path(value)
    class WindowsBaseDir:
        def __truediv__(self, other):
            assert other == windows_path, other
            return local_path
    try:
        win_stream = images._load_image_stream(windows_src)
        assert win_stream is not None and win_stream.read() == data
        win_html = images.embed_local_images(f'<img src="{windows_src}">', WindowsBaseDir())
        assert "data:image/png;base64," in win_html and windows_src not in win_html, win_html
    finally:
        images.Path = original_path
    assert images._load_image_stream(str(local_path), "bad", md5) is None
`
  const result = spawnSync(
    "python3",
    ["-B", "-c", python, join(REPO_ROOT, "src/tools/docx/scripts")],
    { encoding: "utf8" },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
