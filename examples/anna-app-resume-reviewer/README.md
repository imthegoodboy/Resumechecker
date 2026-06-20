# AI Resume Reviewer

An Anna App that reviews resumes from three perspectives: recruiter, ATS system, and senior engineer. The production app runs the core review flow inline in the browser, so it does not require an online local Executa Agent.

## Features

- Upload or paste a resume.
- Parse TXT, MD, JSON, selectable-text PDF exports, and supported DOCX files inline.
- Add a target role or job description.
- Generate an ATS score, missing keywords, priority problems, and section-level suggestions.
- Switch between recruiter, ATS, and senior-engineer review perspectives.
- Approve selected suggestions and save edited resume versions.
- Persist version history and feedback in Anna storage.
- Attach saved-version handoff notes to Anna chat when the grant is available.
- Work in production without a local Agent through deterministic inline analysis.

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

The UI extracts supported uploads inside the iframe, then runs deterministic analysis against the pasted or extracted resume text. This avoids the Anna production failure mode where app execution is blocked because no local Executa Agent is online for the user.

Version history and feedback use a compact storage index plus per-version draft
records so saved resumes stay below Anna's per-value storage limit:

```js
anna.storage.get({ key: "resume-reviewer:v2" });
anna.storage.set({ key: "resume-reviewer:v2", value: compactIndex });
anna.storage.set({ key: "resume-reviewer:version:<id>", value: draftRecord });
```

## Privacy

Resume content is processed inside the app iframe for the core review flow. The app does not require OpenAI keys, third-party credentials, or a local Executa Agent. Local version history is stored through Anna app storage for the current app/user scope.

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
- Use OCR or a selectable-text export for scanned/image-only PDFs.
