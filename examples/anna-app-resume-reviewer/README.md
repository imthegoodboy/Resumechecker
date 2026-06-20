# AI Resume Reviewer

An Anna App that reviews resumes from three perspectives: recruiter, ATS system, and senior engineer. It is built as a static Anna UI bundle plus one Python Executa.

## Features

- Upload or paste a resume.
- Parse TXT, MD, JSON, DOCX, and selectable-text PDF exports.
- Add a target role or job description.
- Generate an ATS score, missing keywords, priority problems, and section-level suggestions.
- Switch between recruiter, ATS, and senior-engineer review perspectives.
- Approve selected suggestions and save edited resume versions.
- Persist version history and feedback in Anna storage.
- Attach saved-version handoff notes to Anna chat when the grant is available.
- Work in no-LLM preview through deterministic fallback analysis.

## Run

```powershell
cd examples\anna-app-resume-reviewer
npm install
npm test
npm run validate
npm run fixture:verify
npm run test:e2e
anna-app dev --port 5184 --llm-account https://anna.partners
```

Offline preview:

```powershell
anna-app dev --port 5184 --no-llm
```

## How It Works

The UI calls:

```js
anna.tools.invoke({
  tool_id: "<resolved resume-reviewer tool id>",
  method: "analyze_resume",
  args: { resume_text, file_b64, target_role, job_description, perspectives },
  timeoutMs: 150000
});
```

The Executa extracts text, runs a deterministic baseline analysis, then asks Anna host sampling for a stricter JSON review when `llm.sample` is granted. If sampling is unavailable, the fallback result still fills the same UI contract.

Version history and feedback use a compact storage index plus per-version draft
records so saved resumes stay below Anna's per-value storage limit:

```js
anna.storage.get({ key: "resume-reviewer:v2" });
anna.storage.set({ key: "resume-reviewer:v2", value: compactIndex });
anna.storage.set({ key: "resume-reviewer:version:<id>", value: draftRecord });
```

## Privacy

Resume content is sent only to the bundled Anna Executa and, when granted, to Anna's host LLM sampling path. The app does not require OpenAI keys or third-party credentials. Local version history is stored through Anna app storage for the current app/user scope.

## Production Checklist

- `npm test`
- `npm run validate`
- `npm run fixture:verify`
- `npm run test:e2e`
- `npm audit --json`
- `python -m py_compile executas\resume-reviewer-python\resume_reviewer_plugin.py`
- `anna-app dev --port 5184 --llm-account https://anna.partners`
- Check desktop and mobile widths.
- Confirm upload, review, approve, save version, restore version, and feedback flows.
- Confirm the installed Agent shows the bundled tool as `Binary` and `Running`.
- Use OCR or a selectable-text export for scanned/image-only PDFs.
