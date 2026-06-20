import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";

const PORT = Number(process.env.RESUME_REVIEWER_E2E_PORT || 5194);
const BASE_URL = `http://127.0.0.1:${PORT}/`;

let server;
let browser;
let sidecarPath;
let sidecarSnapshot;

async function main() {
  sidecarPath = join(process.cwd(), "bundle", "anna-tool-ids.js");
  sidecarSnapshot = existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : null;
  server = startDevHarness();
  await waitForServer(BASE_URL, 40_000);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  const frame = await waitForAppFrame(page);

  const pdfPath = writeResumePdf();
  await frame.locator("#resume-file").setInputFiles(pdfPath);
  await frame.locator("#target-role").fill("Frontend engineer intern");
  await frame.locator("#job-description").fill(
    "React internship using JavaScript, TypeScript, testing, accessibility, APIs, and measurable product work.",
  );
  await frame.locator("#review-btn").click();

  await waitForReviewResult(frame);
  await expectText(frame, "#analysis-meta", (text) => text.includes("pdf text extraction"));
  await expectText(frame, "#analysis-summary", (text) => /Frontend engineer intern/i.test(text));

  const saveButton = frame.locator("#save-version-btn");
  await saveButton.waitFor({ state: "visible" });
  if (!(await saveButton.isEnabled())) {
    throw new Error("save-version button did not become enabled after review");
  }
  await saveButton.click();

  await frame.locator('button[data-page="versions"]').click();
  await expectText(frame, "#version-count", (text) => text.trim() === "1");

  await frame.locator('button[data-page="feedback"]').click();
  await frame.locator('[data-feedback="useful"]').click();
  await frame.locator("#feedback-notes").fill("E2E verified PDF upload and review output.");
  await frame.locator("#save-feedback-btn").click();
  await expectText(frame, "#toast", (text) => text.includes("Feedback saved"));

  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: width === 768 ? 900 : 820 });
    const mobileFrame = await waitForAppFrame(page);
    const overflow = await mobileFrame.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      body: document.body.scrollWidth,
    }));
    if (overflow.document > overflow.viewport || overflow.body > overflow.viewport) {
      throw new Error(`horizontal overflow at ${width}px: ${JSON.stringify(overflow)}`);
    }
  }

  if (pageErrors.length) {
    throw new Error(`page errors: ${pageErrors.join(" | ")}`);
  }
}

function startDevHarness() {
  const cli = join(process.cwd(), "node_modules", "@anna-ai", "cli", "dist", "cli.js");
  const child = spawn(process.execPath, [cli, "dev", "--port", String(PORT), "--no-llm"], {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.on("exit", (code, signal) => {
    if (!child.expectedStop && code && code !== 0 && !signal) {
      console.error(logs);
    }
  });
  return child;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Retry until the dev harness is ready.
    }
    await delay(500);
  }
  throw new Error(`dev harness did not start at ${url}`);
}

async function waitForAppFrame(page) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator("#review-form").count()) > 0) {
          return frame;
        }
      } catch {
        // Frame may detach while the Anna harness initializes.
      }
    }
    await delay(250);
  }
  throw new Error("Anna app frame with #review-form was not found");
}

async function expectText(frame, selector, predicate) {
  const locator = frame.locator(selector);
  await locator.waitFor({ state: "visible" });
  const deadline = Date.now() + 90_000;
  let text = "";
  while (Date.now() < deadline) {
    text = (await locator.textContent()) || "";
    if (predicate(text)) return text;
    await delay(250);
  }
  throw new Error(`condition failed for ${selector}; last text: ${JSON.stringify(text)}`);
}

async function waitForReviewResult(frame) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const score = ((await frame.locator("#score-value").textContent().catch(() => "")) || "").trim();
    const resultsHidden = await frame.locator("#review-results").evaluate((el) => el.hasAttribute("hidden")).catch(() => true);
    if (score && score !== "--" && !resultsHidden) {
      return;
    }
    await delay(500);
  }

  const toast = await frame.locator("#toast").textContent().catch(() => "");
  const reviewButton = await frame.locator("#review-btn").textContent().catch(() => "");
  const help = await frame.locator("#resume-help").textContent().catch(() => "");
  throw new Error(
    `review did not render results; toast=${JSON.stringify(toast)} reviewButton=${JSON.stringify(reviewButton)} help=${JSON.stringify(help)}`,
  );
}

function writeResumePdf() {
  const dir = mkdtempSync(join(tmpdir(), "resume-reviewer-e2e-"));
  const file = join(dir, "resume-reviewer-e2e.pdf");
  writeFileSync(file, makePdf([
    "Parth Candidate",
    "Frontend engineer intern",
    "Built React dashboard with JavaScript, TypeScript, testing, accessibility, and API integration.",
    "Improved page performance by 28 percent and wrote Vitest coverage.",
  ]));
  return file;
}

function makePdf(lines) {
  const text = lines
    .map((line, index) => `${index === 0 ? "72 720 Td" : "0 -18 Td"} (${escapePdfText(line)}) Tj`)
    .join("\n");
  const stream = deflateSync(Buffer.from(`BT\n/F1 12 Tf\n${text}\nET\n`, "utf8"));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "ascii"),
      stream,
      Buffer.from("\nendstream", "ascii"),
    ]),
  ];

  const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`, "ascii"));
    chunks.push(Buffer.isBuffer(objects[i]) ? objects[i] : Buffer.from(objects[i], "ascii"));
    chunks.push(Buffer.from("\nendobj\n", "ascii"));
  }

  const xrefOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

function escapePdfText(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopDevHarness(child) {
  if (!child || child.killed) return;
  child.expectedStop = true;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

try {
  await main();
} finally {
  if (browser) {
    await browser.close();
  }
  stopDevHarness(server);
  if (sidecarPath) {
    if (sidecarSnapshot != null) writeFileSync(sidecarPath, sidecarSnapshot);
    else if (existsSync(sidecarPath)) rmSync(sidecarPath);
  }
}
