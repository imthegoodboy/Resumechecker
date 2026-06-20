import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const STORAGE_KEY = "resume-reviewer:v2";
const LEGACY_STORAGE_KEY = "resume-reviewer:v1";
const VERSION_STORAGE_PREFIX = "resume-reviewer:version:";
const MAX_STORED_VERSIONS = 12;
const STORAGE_VALUE_SOFT_LIMIT = 220 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TEXT_CHARS = 24000;
const LLM_REVIEW_TIMEOUT_MS = 30000;

const $ = (id) => document.getElementById(id);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  shell: $("app-shell"),
  pageTabs: $$(".page-tab"),
  pages: $$(".app-page"),
  form: $("review-form"),
  file: $("resume-file"),
  fileLabel: $("file-label"),
  fileMeta: $("file-meta"),
  resumeText: $("resume-text"),
  resumeHelp: $("resume-help"),
  targetRole: $("target-role"),
  jobDescription: $("job-description"),
  reviewBtn: $("review-btn"),
  runtimeStatus: $("runtime-status"),
  connDot: $("conn-dot"),
  empty: $("empty-state"),
  results: $("review-results"),
  scoreRing: $("score-ring"),
  scoreValue: $("score-value"),
  summary: $("analysis-summary"),
  meta: $("analysis-meta"),
  perspectiveView: $("perspective-view"),
  tabs: $$(".tab"),
  keywordList: $("keyword-list"),
  keywordCount: $("keyword-count"),
  problemList: $("problem-list"),
  problemCount: $("problem-count"),
  suggestionList: $("suggestion-list"),
  selectAllBtn: $("select-all-btn"),
  draftText: $("draft-text"),
  copyDraftBtn: $("copy-draft-btn"),
  saveVersionBtn: $("save-version-btn"),
  versionList: $("version-list"),
  versionCount: $("version-count"),
  feedbackNotes: $("feedback-notes"),
  feedbackButtons: $$(".icon-choice"),
  saveFeedbackBtn: $("save-feedback-btn"),
  toast: $("toast"),
};

const app = {
  anna: null,
  uploadedFile: null,
  uploadExtraction: null,
  analysis: null,
  selectedPerspective: "recruiter",
  currentPage: "review",
  selectedSuggestionIds: new Set(),
  versions: [],
  activeVersionId: null,
  feedback: { rating: "", notes: "" },
  busy: false,
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindUi();
  renderEmpty();
  try {
    app.anna = await withTimeout(AnnaAppRuntime.connect(), 5000, "Anna runtime connection timed out");
    setRuntime(canUseAnnaLlm() ? "Anna LLM ready" : "Inline review ready", true);
    await app.anna.window?.set_title?.({ title: "AI Resume Reviewer" });
  } catch (error) {
    app.anna = createLocalAnna();
    setRuntime("Inline preview", false);
    console.warn("[resume-reviewer] Anna runtime unavailable:", error?.message || error);
  }
  await loadState();
  renderAll();
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || "Operation timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function bindUi() {
  els.pageTabs.forEach((tab) => {
    tab.addEventListener("click", () => selectPage(tab.dataset.page));
  });
  els.file.addEventListener("change", onFileChange);
  els.form.addEventListener("submit", onReviewSubmit);
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => selectPerspective(tab.dataset.perspective));
  });
  els.selectAllBtn.addEventListener("click", toggleAllSuggestions);
  els.copyDraftBtn.addEventListener("click", copyDraft);
  els.saveVersionBtn.addEventListener("click", () => saveVersion("manual"));
  els.saveFeedbackBtn.addEventListener("click", saveFeedback);
  els.feedbackButtons.forEach((button) => {
    button.addEventListener("click", () => {
      app.feedback.rating = button.dataset.feedback || "";
      renderFeedback();
      void persistState();
    });
  });
  els.draftText.addEventListener("input", () => {
    els.saveVersionBtn.disabled = !els.draftText.value.trim();
  });
}

async function onFileChange() {
  const file = els.file.files?.[0] || null;
  app.uploadedFile = null;
  app.uploadExtraction = null;
  if (!file) {
    els.fileLabel.textContent = "Choose PDF, DOCX, TXT, or MD";
    els.fileMeta.textContent = "2 MB max";
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    els.file.value = "";
    toast("That file is over 2 MB. Paste the resume text or upload a smaller export.", "error");
    return;
  }
  app.uploadedFile = file;
  els.fileLabel.textContent = file.name;
  els.fileMeta.textContent = `${formatBytes(file.size)} - ${file.type || "file"}`;

  try {
    const extraction = await extractUploadedFileText(file);
    app.uploadExtraction = extraction;
    if (extraction.text && !els.resumeText.value.trim()) {
      els.resumeText.value = extraction.text.slice(0, MAX_INLINE_TEXT_CHARS);
    }
    els.resumeHelp.textContent = extraction.note
      ? `File text extracted inline: ${extraction.note}.`
      : "File text extracted inline.";
  } catch (error) {
    if (isDocx(file)) {
      els.resumeHelp.textContent = "DOCX could not be read in this browser. Paste the resume text to review inline.";
    } else if (isPdf(file)) {
      els.resumeHelp.textContent = "This PDF has no selectable text. Paste the resume text or export a selectable PDF.";
    } else {
      els.resumeHelp.textContent = "Could not read that file inline. Paste the resume text to continue.";
    }
    console.warn("[resume-reviewer] inline extraction failed:", error?.message || error);
  }
}

async function runInlineReview(args) {
  return {
    analysis: localAnalysis(args),
    used_llm: false,
  };
}

async function runReview(args) {
  const llmPayload = await runAnnaLlmReview(args).catch((error) => {
    console.warn("[resume-reviewer] Anna LLM review unavailable:", error?.message || error);
    return null;
  });
  return llmPayload || runInlineReview(args);
}

function canUseAnnaLlm() {
  return typeof app.anna?.llm?.complete === "function";
}

async function runAnnaLlmReview(args) {
  if (!canUseAnnaLlm()) return null;
  const reply = await withTimeout(
    app.anna.llm.complete({
      systemPrompt: [
        "You are a strict resume reviewer for students, freshers, and job seekers.",
        "Return only valid JSON. Do not include markdown fences.",
        "Use only evidence in the resume and job description. Do not invent employers, degrees, metrics, links, or tools.",
        "Keep suggestions concrete, concise, and safe for the candidate to edit before applying.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildLlmReviewPrompt(args),
          },
        },
      ],
      maxTokens: Math.min(Number(args.max_tokens) || 2200, 2600),
      temperature: 0.2,
    }),
    LLM_REVIEW_TIMEOUT_MS,
    "Anna LLM completion timed out; inline fallback used",
  );
  const text = extractCompletionText(reply);
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error("Anna LLM returned a non-JSON review");
  const analysis = parsed.analysis && typeof parsed.analysis === "object" ? parsed.analysis : parsed;
  analysis.used_llm = true;
  analysis.model = analysis.model || reply?.model || "Anna LLM";
  analysis.source_note = analysis.source_note || args.source_note || "Anna LLM review";
  return { analysis, used_llm: true, model: analysis.model };
}

function buildLlmReviewPrompt(args) {
  const schema = {
    ats_score: "0-100 integer",
    summary: "one sentence",
    missing_keywords: ["keyword"],
    problems: [{ title: "issue", detail: "evidence-based detail", severity: "high|medium|low" }],
    perspectives: {
      recruiter: { verdict: "sentence", findings: ["finding"], priorities: ["priority"] },
      ats: { verdict: "sentence", findings: ["finding"], priorities: ["priority"] },
      engineer: { verdict: "sentence", findings: ["finding"], priorities: ["priority"] },
    },
    suggestions: [{ id: "s1", section: "section", title: "change", reason: "why", rewrite: "candidate-editable text", impact: "recruiter|ats|engineer" }],
    improved_resume: "edited resume draft or targeted update notes",
  };
  return [
    "Review this resume for the target role.",
    `Target role: ${args.target_role || "Not provided"}`,
    `Perspectives requested: ${(args.perspectives || []).join(", ") || "recruiter, ats, engineer"}`,
    `Job description or keywords:\n${limitString(args.job_description || "", 6000) || "Not provided"}`,
    `Resume:\n${limitString(args.resume_text || "", 18000)}`,
    `Return JSON matching this schema:\n${JSON.stringify(schema)}`,
  ].join("\n\n");
}

function extractCompletionText(reply) {
  const content = reply?.content;
  if (typeof content === "string") return content;
  if (typeof content?.text === "string") return content.text;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof reply?.text === "string") return reply.text;
  return "";
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  for (const candidate of jsonCandidates(raw)) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function jsonCandidates(raw) {
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  return candidates;
}

function finishReview(payload, fallbackText) {
  app.analysis = normalizeAnalysis(payload.analysis || payload);
  app.selectedSuggestionIds = new Set(app.analysis.suggestions.map((s) => s.id));
  app.selectedPerspective = pickAvailablePerspective(app.selectedPerspective);
  app.activeVersionId = null;
  els.draftText.value = app.analysis.improved_resume || fallbackText;
  els.saveVersionBtn.disabled = !els.draftText.value.trim();
}

async function getUploadExtraction(file) {
  if (!file) return null;
  if (app.uploadExtraction?.fileName === file.name && app.uploadExtraction?.fileSize === file.size) {
    return app.uploadExtraction;
  }
  app.uploadExtraction = await extractUploadedFileText(file);
  return app.uploadExtraction;
}

async function extractUploadedFileText(file) {
  let text = "";
  let note = "";
  if (isLikelyText(file)) {
    text = await file.text();
    note = "local text extraction";
  } else if (isPdf(file)) {
    text = await extractPdfText(await file.arrayBuffer());
    note = "pdf text extraction";
  } else if (isDocx(file)) {
    text = await extractDocxText(await file.arrayBuffer());
    note = "docx text extraction";
  } else {
    throw new Error("Unsupported inline file type");
  }

  text = normalizeWhitespace(text).slice(0, MAX_INLINE_TEXT_CHARS);
  if (!text) throw new Error("No readable text found");
  return {
    fileName: file.name,
    fileSize: file.size,
    text,
    note,
  };
}

async function extractPdfText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const parts = [];
  const rawText = decodeBytes(bytes);
  parts.push(rawText);

  const streamBytes = findPdfStreams(bytes);
  for (const item of streamBytes) {
    try {
      const content = item.flate ? await inflateBytes(item.bytes, "deflate") : item.bytes;
      parts.push(decodeBytes(content));
    } catch (error) {
      console.warn("[resume-reviewer] PDF stream skipped:", error?.message || error);
    }
  }

  return normalizeWhitespace(
    parts
      .flatMap((part) => extractPdfLiteralStrings(part))
      .join(" "),
  );
}

function findPdfStreams(bytes) {
  const streams = [];
  const streamMarker = asciiBytes("stream");
  const endMarker = asciiBytes("endstream");
  let pos = 0;
  while (pos < bytes.length) {
    const startMarker = indexOfBytes(bytes, streamMarker, pos);
    if (startMarker < 0) break;
    let start = startMarker + streamMarker.length;
    if (bytes[start] === 13 && bytes[start + 1] === 10) start += 2;
    else if (bytes[start] === 10 || bytes[start] === 13) start += 1;

    const end = indexOfBytes(bytes, endMarker, start);
    if (end < 0) break;
    let streamEnd = end;
    while (streamEnd > start && (bytes[streamEnd - 1] === 10 || bytes[streamEnd - 1] === 13)) streamEnd -= 1;

    const dictStart = Math.max(0, startMarker - 800);
    const dictText = decodeBytes(bytes.slice(dictStart, startMarker));
    streams.push({
      bytes: bytes.slice(start, streamEnd),
      flate: /\/FlateDecode\b/.test(dictText),
    });
    pos = end + endMarker.length;
  }
  return streams;
}

async function extractDocxText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const entries = await readZipEntries(bytes);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) throw new Error("word/document.xml not found");
  return xmlText(documentXml);
}

async function readZipEntries(bytes) {
  const entries = new Map();
  let pos = 0;
  while (pos + 30 < bytes.length) {
    if (readU32(bytes, pos) !== 0x04034b50) {
      pos += 1;
      continue;
    }
    const method = readU16(bytes, pos + 8);
    const compressedSize = readU32(bytes, pos + 18);
    const nameLength = readU16(bytes, pos + 26);
    const extraLength = readU16(bytes, pos + 28);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) break;

    const name = decodeBytes(bytes.slice(nameStart, nameStart + nameLength));
    const compressed = bytes.slice(dataStart, dataEnd);
    let content = null;
    if (method === 0) content = compressed;
    else if (method === 8) content = await inflateBytes(compressed, "deflate-raw");
    if (content) entries.set(name, decodeBytes(content));
    pos = dataEnd;
  }
  return entries;
}

async function onReviewSubmit(event) {
  event.preventDefault();
  if (app.busy) return;
  const resumeText = els.resumeText.value.trim();
  if (!resumeText && !app.uploadedFile) {
    toast("Add a resume file or paste resume text before running a review.", "error");
    els.resumeText.focus();
    return;
  }

  setBusy(true);
  try {
    const args = await buildReviewArgs();
    const payload = await runReview(args);
    finishReview(payload, args.resume_text || resumeText);
    await persistState();
    renderAll();
    selectPage("results");
    toast(app.analysis.used_llm ? "Review complete with Anna LLM." : "Review complete inline.");
  } catch (error) {
    toast(formatError(error), "error");
  } finally {
    setBusy(false);
  }
}

async function buildReviewArgs() {
  const perspectives = $$('input[name="perspective"]:checked').map((el) => el.value);
  const typedText = els.resumeText.value.trim();
  let extraction = app.uploadExtraction;
  if (!typedText && app.uploadedFile) {
    extraction = await getUploadExtraction(app.uploadedFile);
  }
  const resumeText = typedText || extraction?.text || "";
  const typedFromExtraction = Boolean(typedText && extraction?.text && typedText === extraction.text);
  if (!resumeText) {
    throw new Error("Could not read resume text inline. Paste selectable text and try again.");
  }
  const args = {
    resume_text: resumeText,
    target_role: els.targetRole.value.trim(),
    job_description: els.jobDescription.value.trim(),
    perspectives: perspectives.length ? perspectives : ["recruiter", "ats", "engineer"],
    max_tokens: 2600,
    source_note: typedFromExtraction || !typedText ? extraction?.note || "inline text review" : "inline text review",
  };
  if (app.uploadedFile) args.filename = app.uploadedFile.name;
  return args;
}

function normalizeAnalysis(input) {
  const analysis = input && typeof input === "object" ? input : {};
  const rawSuggestions = Array.isArray(analysis.suggestions) ? analysis.suggestions : [];
  const suggestions = rawSuggestions.map((item, index) => ({
    id: String(item.id || `s${index + 1}`),
    title: String(item.title || item.action || "Improve this section"),
    section: String(item.section || "Resume"),
    reason: String(item.reason || item.detail || ""),
    rewrite: String(item.rewrite || item.replacement || ""),
    impact: String(item.impact || ""),
  }));
  return {
    ats_score: clampScore(analysis.ats_score ?? analysis.score),
    summary: String(analysis.summary || "Review generated."),
    source_note: String(analysis.source_note || analysis.extraction_note || ""),
    missing_keywords: toStringArray(analysis.missing_keywords).slice(0, 20),
    problems: normalizeProblems(analysis.problems),
    perspectives: normalizePerspectives(analysis.perspectives),
    suggestions,
    improved_resume: String(analysis.improved_resume || analysis.rewritten_resume || ""),
    used_llm: Boolean(analysis.used_llm || input.used_llm),
    model: String(analysis.model || input.model || ""),
  };
}

function normalizeProblems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 12).map((item, index) => ({
    title: String(item.title || item.issue || `Problem ${index + 1}`),
    detail: String(item.detail || item.reason || item.description || ""),
    severity: String(item.severity || "medium"),
  }));
}

function normalizePerspectives(input) {
  const defaults = {
    recruiter: {
      title: "Recruiter",
      verdict: "Ready for a first-pass screen after the marked changes.",
      findings: [],
      priorities: [],
    },
    ats: {
      title: "ATS system",
      verdict: "Keyword and section match need review.",
      findings: [],
      priorities: [],
    },
    engineer: {
      title: "Senior engineer",
      verdict: "Technical evidence should be more concrete.",
      findings: [],
      priorities: [],
    },
  };
  const source = input && typeof input === "object" ? input : {};
  for (const key of Object.keys(defaults)) {
    const raw = source[key] || source[defaults[key].title] || {};
    defaults[key] = {
      title: defaults[key].title,
      verdict: String(raw.verdict || raw.summary || defaults[key].verdict),
      findings: toStringArray(raw.findings || raw.notes || raw.concerns).slice(0, 6),
      priorities: toStringArray(raw.priorities || raw.next_steps || raw.actions).slice(0, 5),
    };
  }
  return defaults;
}

function renderAll() {
  renderInputsFromState();
  if (!app.analysis) renderEmpty();
  else renderAnalysis();
  renderVersions();
  renderFeedback();
  renderPageTabs();
}

function selectPage(page) {
  const next = ["review", "results", "versions", "feedback"].includes(page) ? page : "review";
  app.currentPage = next;
  for (const view of els.pages) {
    view.hidden = view.dataset.page !== next;
  }
  renderPageTabs();
}

function renderPageTabs() {
  for (const tab of els.pageTabs) {
    const active = tab.dataset.page === app.currentPage;
    tab.classList.toggle("is-active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
}

function renderInputsFromState() {
  if (app.feedback.notes && !els.feedbackNotes.value) {
    els.feedbackNotes.value = app.feedback.notes;
  }
}

function renderEmpty() {
  els.empty.hidden = false;
  els.results.hidden = true;
  els.saveVersionBtn.disabled = !els.draftText.value.trim();
  renderVersions();
  renderFeedback();
}

function renderAnalysis() {
  const analysis = app.analysis;
  els.empty.hidden = true;
  els.results.hidden = false;
  const score = clampScore(analysis.ats_score);
  els.scoreRing.style.setProperty("--score", String(score));
  els.scoreValue.textContent = String(score);
  els.summary.textContent = analysis.summary;
  const meta = [];
  if (analysis.used_llm) meta.push("Anna LLM");
  else meta.push("inline fallback");
  if (analysis.model) meta.push(analysis.model);
  if (analysis.source_note) meta.push(analysis.source_note);
  els.meta.textContent = meta.join(" - ");

  renderTabs();
  renderPerspective();
  renderKeywords();
  renderProblems();
  renderSuggestions();
}

function renderTabs() {
  els.tabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.perspective === app.selectedPerspective);
  });
}

function selectPerspective(key) {
  app.selectedPerspective = key;
  renderTabs();
  renderPerspective();
}

function pickAvailablePerspective(key) {
  const allowed = ["recruiter", "ats", "engineer"];
  return allowed.includes(key) ? key : "recruiter";
}

function renderPerspective() {
  const data = app.analysis?.perspectives?.[app.selectedPerspective];
  els.perspectiveView.replaceChildren();
  if (!data) return;
  const title = document.createElement("h3");
  title.textContent = data.title;
  const verdict = document.createElement("p");
  verdict.textContent = data.verdict;
  els.perspectiveView.append(title, verdict);
  const findings = data.findings?.length ? data.findings : data.priorities || [];
  if (findings.length) {
    const list = document.createElement("ul");
    for (const finding of findings) {
      const item = document.createElement("li");
      item.textContent = finding;
      list.appendChild(item);
    }
    els.perspectiveView.appendChild(list);
  }
}

function renderKeywords() {
  const keywords = app.analysis.missing_keywords || [];
  els.keywordCount.textContent = String(keywords.length);
  els.keywordList.replaceChildren();
  if (!keywords.length) {
    els.keywordList.appendChild(emptyCopy("No obvious missing keywords found."));
    return;
  }
  for (const keyword of keywords) {
    const chip = document.createElement("span");
    chip.className = "keyword";
    chip.textContent = keyword;
    els.keywordList.appendChild(chip);
  }
}

function renderProblems() {
  const problems = app.analysis.problems || [];
  els.problemCount.textContent = String(problems.length);
  els.problemList.replaceChildren();
  if (!problems.length) {
    const item = document.createElement("li");
    item.textContent = "No major problems found.";
    els.problemList.appendChild(item);
    return;
  }
  for (const problem of problems) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    title.textContent = problem.title;
    detail.textContent = problem.detail || problem.severity;
    item.append(title, detail);
    els.problemList.appendChild(item);
  }
}

function renderSuggestions() {
  const suggestions = app.analysis.suggestions || [];
  els.suggestionList.replaceChildren();
  if (!suggestions.length) {
    els.suggestionList.appendChild(emptyCopy("No changes are waiting for approval."));
    els.selectAllBtn.disabled = true;
    return;
  }
  els.selectAllBtn.disabled = false;
  const allSelected = suggestions.every((s) => app.selectedSuggestionIds.has(s.id));
  els.selectAllBtn.textContent = allSelected ? "Clear all" : "Select all";
  for (const suggestion of suggestions) {
    const row = document.createElement("label");
    row.className = "suggestion";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = app.selectedSuggestionIds.has(suggestion.id);
    check.addEventListener("change", () => {
      if (check.checked) app.selectedSuggestionIds.add(suggestion.id);
      else app.selectedSuggestionIds.delete(suggestion.id);
      renderSuggestions();
    });
    const body = document.createElement("span");
    const title = document.createElement("h4");
    const reason = document.createElement("p");
    title.textContent = `${suggestion.section}: ${suggestion.title}`;
    reason.textContent = suggestion.reason || suggestion.impact || "Suggested improvement.";
    body.append(title, reason);
    if (suggestion.rewrite) {
      const rewrite = document.createElement("code");
      rewrite.textContent = suggestion.rewrite;
      body.appendChild(rewrite);
    }
    row.append(check, body);
    els.suggestionList.appendChild(row);
  }
}

function toggleAllSuggestions() {
  if (!app.analysis) return;
  const suggestions = app.analysis.suggestions || [];
  const allSelected = suggestions.every((s) => app.selectedSuggestionIds.has(s.id));
  app.selectedSuggestionIds = new Set(allSelected ? [] : suggestions.map((s) => s.id));
  renderSuggestions();
}

async function saveVersion(reason) {
  const draft = els.draftText.value.trim();
  if (!draft) {
    toast("There is no draft to save.", "error");
    return;
  }
  const version = {
    id: `v-${Date.now()}`,
    created_at: new Date().toISOString(),
    title: els.targetRole.value.trim() || app.uploadedFile?.name || "Resume draft",
    score: app.analysis ? clampScore(app.analysis.ats_score) : null,
    text: draft,
    reason,
    accepted_suggestions: app.analysis
      ? app.analysis.suggestions.filter((s) => app.selectedSuggestionIds.has(s.id))
      : [],
    feedback: {
      rating: app.feedback.rating || "",
      notes: limitString(els.feedbackNotes.value.trim(), 8000),
    },
  };
  app.versions.unshift(version);
  const droppedVersions = app.versions.slice(MAX_STORED_VERSIONS);
  app.versions = app.versions.slice(0, MAX_STORED_VERSIONS);
  app.activeVersionId = version.id;
  const versionPersisted = await saveVersionRecord(version);
  const indexPersisted = await persistState();
  droppedVersions.forEach((item) => void deleteVersionRecord(item.id));
  renderVersions();
  toast(
    versionPersisted && indexPersisted
      ? "Version saved."
      : "Version saved for this session. Anna storage did not persist it.",
    versionPersisted && indexPersisted ? "ok" : "error",
  );
  void appendHandoffArtifact(version);
}

function renderVersions() {
  els.versionCount.textContent = String(app.versions.length);
  els.versionList.replaceChildren();
  if (!app.versions.length) {
    els.versionList.appendChild(emptyCopy("Saved drafts will appear here."));
    return;
  }
  for (const version of app.versions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "version-item";
    button.classList.toggle("is-active", version.id === app.activeVersionId);
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    title.textContent = version.title;
    meta.textContent = `${formatDate(version.created_at)}${version.score == null ? "" : ` - ATS ${version.score}`}`;
    button.append(title, meta);
    button.addEventListener("click", () => restoreVersion(version.id));
    els.versionList.appendChild(button);
  }
}

function restoreVersion(id) {
  const version = app.versions.find((item) => item.id === id);
  if (!version) return;
  app.activeVersionId = id;
  els.draftText.value = version.text || "";
  els.saveVersionBtn.disabled = !els.draftText.value.trim();
  renderVersions();
  toast("Version restored into the draft editor.");
}

async function saveFeedback() {
  app.feedback.notes = els.feedbackNotes.value.trim();
  await persistState();
  toast("Feedback saved.");
}

function renderFeedback() {
  els.feedbackButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.feedback === app.feedback.rating);
  });
  if (app.feedback.notes && els.feedbackNotes.value !== app.feedback.notes) {
    els.feedbackNotes.value = app.feedback.notes;
  }
}

async function copyDraft() {
  const text = els.draftText.value;
  if (!text.trim()) {
    toast("There is no draft to copy.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    els.copyDraftBtn.textContent = "Copied";
    setTimeout(() => {
      els.copyDraftBtn.textContent = "Copy draft";
    }, 1800);
  } catch {
    els.draftText.focus();
    els.draftText.select();
    toast("Select the draft text, then copy it.", "error");
  }
}

async function appendHandoffArtifact(version) {
  if (!app.anna?.chat) return;
  const markdown = [
    `# Resume Reviewer version`,
    ``,
    `Target: ${version.title}`,
    version.score == null ? `` : `ATS score: ${version.score}`,
    `Accepted changes: ${version.accepted_suggestions.length}`,
  ].filter(Boolean).join("\n");
  try {
    await app.anna.chat.append_artifact({
      title: "AI Resume Reviewer version",
      mime_type: "text/markdown",
      content: markdown,
    });
  } catch {
    try {
      await app.anna.chat.write_message({
        role: "user",
        content: `Saved a Resume Reviewer version for ${version.title}.`,
      });
    } catch {
      /* chat may be denied */
    }
  }
}

async function loadState() {
  try {
    let value = await readStorageValue(STORAGE_KEY);
    if (!value) value = await readStorageValue(LEGACY_STORAGE_KEY);
    if (!value || typeof value !== "object") return;
    app.versions = await hydrateVersions(value.versions);
    app.feedback = value.feedback && typeof value.feedback === "object"
      ? { rating: value.feedback.rating || "", notes: value.feedback.notes || "" }
      : app.feedback;
    app.analysis = value.last_analysis ? normalizeAnalysis(value.last_analysis) : null;
    app.selectedSuggestionIds = new Set(toStringArray(value.selected_suggestion_ids));
    app.selectedPerspective = value.selected_perspective || app.selectedPerspective;
    if (typeof value.last_draft === "string") els.draftText.value = value.last_draft;
    if (typeof value.target_role === "string") els.targetRole.value = value.target_role;
    if (typeof value.job_description === "string") els.jobDescription.value = value.job_description;
  } catch {
    /* storage may be empty or denied */
  }
}

async function persistState() {
  if (!app.anna?.storage) return false;
  const value = {
    schema: 2,
    versions: app.versions.map(compactVersionSummary),
    feedback: { ...app.feedback, notes: els.feedbackNotes.value.trim() },
    last_analysis: compactAnalysisForStorage(app.analysis),
    last_draft: limitString(els.draftText.value, 32000),
    target_role: els.targetRole.value.trim(),
    job_description: limitString(els.jobDescription.value.trim(), 12000),
    selected_perspective: app.selectedPerspective,
    selected_suggestion_ids: Array.from(app.selectedSuggestionIds),
  };
  try {
    await app.anna.storage.set({ key: STORAGE_KEY, value: fitStorageValue(value) });
    return true;
  } catch {
    /* non-fatal */
    return false;
  }
}

async function readStorageValue(key) {
  if (!app.anna?.storage) return null;
  const res = await app.anna.storage.get({ key });
  return res?.exists ? res.value : res?.value;
}

async function hydrateVersions(items) {
  if (!Array.isArray(items)) return [];
  const versions = [];
  for (const item of items.slice(0, MAX_STORED_VERSIONS)) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") {
      versions.push(item);
      continue;
    }
    const detail = await readStorageValue(`${VERSION_STORAGE_PREFIX}${item.id}`);
    versions.push(detail && typeof detail === "object" ? { ...item, ...detail } : { ...item, text: "" });
  }
  return versions;
}

async function saveVersionRecord(version) {
  if (!app.anna?.storage) return false;
  try {
    await app.anna.storage.set({
      key: `${VERSION_STORAGE_PREFIX}${version.id}`,
      value: compactVersionRecord(version),
    });
    return true;
  } catch {
    try {
      await app.anna.storage.set({
        key: `${VERSION_STORAGE_PREFIX}${version.id}`,
        value: { ...compactVersionRecord(version), text: limitString(version.text, 16000) },
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function deleteVersionRecord(id) {
  if (!app.anna?.storage || !id) return;
  try {
    await app.anna.storage.delete({ key: `${VERSION_STORAGE_PREFIX}${id}` });
  } catch {
    /* best-effort cleanup */
  }
}

function compactVersionSummary(version) {
  return {
    id: version.id,
    created_at: version.created_at,
    title: limitString(version.title, 140),
    score: version.score,
    reason: version.reason,
    accepted_count: Array.isArray(version.accepted_suggestions) ? version.accepted_suggestions.length : 0,
    feedback: {
      rating: version.feedback?.rating || "",
      notes: limitString(version.feedback?.notes || "", 1000),
    },
  };
}

function compactVersionRecord(version) {
  return {
    text: limitString(version.text, 36000),
    accepted_suggestions: (version.accepted_suggestions || []).slice(0, 10).map(compactSuggestionForStorage),
    feedback: {
      rating: version.feedback?.rating || "",
      notes: limitString(version.feedback?.notes || "", 4000),
    },
  };
}

function compactAnalysisForStorage(analysis) {
  if (!analysis) return null;
  return {
    ats_score: clampScore(analysis.ats_score),
    summary: limitString(analysis.summary, 700),
    source_note: limitString(analysis.source_note, 300),
    missing_keywords: toStringArray(analysis.missing_keywords).slice(0, 20),
    problems: (analysis.problems || []).slice(0, 12).map((item) => ({
      title: limitString(item.title, 180),
      detail: limitString(item.detail, 700),
      severity: limitString(item.severity, 40),
    })),
    perspectives: compactPerspectivesForStorage(analysis.perspectives),
    suggestions: (analysis.suggestions || []).slice(0, 10).map(compactSuggestionForStorage),
    improved_resume: "",
    used_llm: Boolean(analysis.used_llm),
    model: limitString(analysis.model, 120),
  };
}

function compactPerspectivesForStorage(perspectives) {
  const out = {};
  for (const key of ["recruiter", "ats", "engineer"]) {
    const raw = perspectives?.[key] || {};
    out[key] = {
      verdict: limitString(raw.verdict, 700),
      findings: toStringArray(raw.findings).slice(0, 6).map((item) => limitString(item, 500)),
      priorities: toStringArray(raw.priorities).slice(0, 5).map((item) => limitString(item, 300)),
    };
  }
  return out;
}

function compactSuggestionForStorage(item) {
  return {
    id: limitString(item.id, 80),
    section: limitString(item.section, 80),
    title: limitString(item.title, 180),
    reason: limitString(item.reason, 700),
    rewrite: limitString(item.rewrite, 1800),
    impact: limitString(item.impact, 80),
  };
}

function fitStorageValue(value) {
  let candidate = value;
  if (storageBytes(candidate) <= STORAGE_VALUE_SOFT_LIMIT) return candidate;
  candidate = {
    ...candidate,
    last_analysis: candidate.last_analysis ? { ...candidate.last_analysis, suggestions: [], problems: [] } : null,
  };
  if (storageBytes(candidate) <= STORAGE_VALUE_SOFT_LIMIT) return candidate;
  candidate = { ...candidate, last_draft: limitString(candidate.last_draft, 16000), job_description: limitString(candidate.job_description, 6000) };
  if (storageBytes(candidate) <= STORAGE_VALUE_SOFT_LIMIT) return candidate;
  return { ...candidate, last_analysis: null, versions: candidate.versions.slice(0, 6) };
}

function storageBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function createLocalAnna() {
  const store = new Map();
  return {
    storage: {
      async get({ key }) {
        return { exists: store.has(key), value: store.get(key) };
      },
      async set({ key, value }) {
        store.set(key, value);
        return { ok: true };
      },
    },
    chat: {
      async append_artifact() { return { ok: true }; },
      async write_message() { return { ok: true }; },
    },
    window: {
      async set_title() { return { ok: true }; },
    },
  };
}

function localAnalysis(args) {
  const text = `${args?.resume_text || ""}`.trim();
  const role = `${args?.target_role || "target role"}`.trim();
  const jd = `${args?.job_description || ""}`.trim();
  const words = new Set(text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []);
  const wanted = extractTerms(`${role} ${jd}`);
  const missing = wanted.filter((term) => !words.has(term.toLowerCase())).slice(0, 12);
  const hasMetrics = /\d+%|\$?\d+[kKmM]?|\b\d+\s*(users|requests|projects|clients|seconds|minutes|hours)\b/i.test(text);
  const hasLinks = /(linkedin|github|portfolio|https?:\/\/)/i.test(text);
  const score = Math.max(38, Math.min(92, 86 - missing.length * 3 - (hasMetrics ? 0 : 9) - (hasLinks ? 0 : 4)));
  return {
    ats_score: score,
    used_llm: false,
    summary: `${role || "This role"} match is ${score >= 75 ? "close" : "not ready"} after keyword and evidence checks.`,
    source_note: args?.source_note || "inline browser analysis",
    missing_keywords: missing,
    problems: [
      !hasMetrics && {
        title: "Impact is not quantified",
        detail: "Several bullets describe responsibilities without measurable outcomes.",
        severity: "high",
      },
      missing.length && {
        title: "Target terms are missing",
        detail: "The resume does not mirror important language from the role.",
        severity: "high",
      },
      !hasLinks && {
        title: "Proof links are thin",
        detail: "Add a portfolio, GitHub, LinkedIn, or project link if relevant.",
        severity: "medium",
      },
    ].filter(Boolean),
    perspectives: {
      recruiter: {
        verdict: "The resume needs sharper first-pass evidence before a recruiter screen.",
        findings: ["Lead with role fit, strongest projects, and measurable outcomes."],
        priorities: ["Tighten summary", "Move target skills into top third"],
      },
      ats: {
        verdict: "The ATS match is limited by missing role-specific terms.",
        findings: missing.length ? missing.map((k) => `Missing keyword: ${k}`) : ["Keyword match looks acceptable."],
        priorities: ["Use exact job-posting language where true", "Keep standard section headings"],
      },
      engineer: {
        verdict: "Technical bullets should show scope, tradeoffs, and impact.",
        findings: ["Name stack, complexity, ownership, and measured result in project bullets."],
        priorities: ["Rewrite project bullets", "Add production or teamwork evidence"],
      },
    },
    suggestions: [
      {
        id: "s1",
        section: "Summary",
        title: "State role fit in one line",
        reason: "Recruiters scan the top third first.",
        rewrite: `Aspiring ${role || "professional"} with project evidence in ${missing.slice(0, 3).join(", ") || "the target stack"}.`,
        impact: "recruiter",
      },
      {
        id: "s2",
        section: "Experience",
        title: "Rewrite bullets with outcome",
        reason: "Impact bullets score better than responsibility bullets.",
        rewrite: "Built [feature] using [stack], improving [metric] for [users/team].",
        impact: "ats",
      },
      {
        id: "s3",
        section: "Skills",
        title: "Add truthful missing keywords",
        reason: "ATS systems match exact wording.",
        rewrite: missing.slice(0, 8).join(", "),
        impact: "ats",
      },
    ],
    improved_resume: text
      ? `${text}\n\nTargeted update notes:\n- Add missing truthful keywords: ${missing.slice(0, 8).join(", ") || "none found"}.\n- Rewrite top project bullets with action, stack, and measured result.\n- Keep standard headings: Summary, Skills, Experience, Projects, Education.`
      : "",
  };
}

function extractTerms(text) {
  const stop = new Set(["and", "the", "with", "for", "from", "this", "that", "your", "you", "are", "will", "work", "team", "role", "job"]);
  const base = (text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [])
    .filter((word) => !stop.has(word) && word.length <= 24);
  const common = ["javascript", "typescript", "react", "node", "python", "sql", "api", "testing", "aws", "docker", "git", "analytics", "communication"];
  return Array.from(new Set([...base, ...common])).slice(0, 24);
}

function isLikelyText(file) {
  return /text|markdown|json/.test(file.type) || /\.(txt|md|json)$/i.test(file.name);
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function isDocx(file) {
  return file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(file.name);
}

async function inflateBytes(bytes, format) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Browser decompression is unavailable");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function extractPdfLiteralStrings(content) {
  const values = [];
  const re = /\((?:\\.|[^\\)])*\)/g;
  for (const match of content.matchAll(re)) {
    const text = decodePdfString(match[0].slice(1, -1));
    if (/[a-z0-9]/i.test(text)) values.push(text);
  }
  return values;
}

function decodePdfString(value) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_, ch) => {
      const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      return map[ch] || ch;
    })
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function xmlText(xml) {
  return normalizeWhitespace(
    xml
      .replace(/<w:tab\s*\/>/g, " ")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'"),
  );
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function asciiBytes(value) {
  return Uint8Array.from(value, (ch) => ch.charCodeAt(0));
}

function indexOfBytes(bytes, needle, from) {
  outer:
  for (let i = from; i <= bytes.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function decodeBytes(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function setBusy(on) {
  app.busy = Boolean(on);
  els.shell.classList.toggle("is-busy", app.busy);
  els.reviewBtn.disabled = app.busy;
  els.reviewBtn.querySelector(".btn__label").textContent = app.busy ? "Reviewing" : "Review resume";
}

function setRuntime(text, connected) {
  els.runtimeStatus.textContent = text;
  els.connDot.classList.toggle("is-on", connected);
}

function toast(message, tone = "ok") {
  els.toast.textContent = message;
  els.toast.dataset.tone = tone;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, tone === "error" ? 5600 : 3200);
}

function emptyCopy(text) {
  const node = document.createElement("p");
  node.className = "empty-copy";
  node.textContent = text;
  return node;
}

function toStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function limitString(value, maxLength) {
  const text = value == null ? "" : String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Saved draft";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatError(error) {
  const code = error?.code || error?.error?.code || "";
  const message = error?.message || error?.error?.message || String(error);
  if (code) return `${message} [${code}]`;
  return message;
}
