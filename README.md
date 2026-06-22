# AI Resume Reviewer

AI Resume Reviewer is a production-ready Anna App for students, freshers, and job seekers who want concrete resume feedback before applying. It reviews a resume against a target role from three angles: recruiter screening, ATS keyword matching, and senior-engineer evidence quality.

The app is designed to be judge-safe: it uses Anna runtime services when available, but the core review flow still works without a local Anna Agent or bundled Executa install.

Demo video link : https://youtu.be/g87CTlOptKQ

## What It Does

- Upload or paste a resume.
- Read TXT, MD, JSON, selectable-text PDF exports, and supported DOCX files inline.
- Add a target role plus job-description keywords.
- Use `anna.llm.complete` for richer review when the Anna host grant is available.
- Fall back to deterministic inline analysis when LLM, Agent, or network services are unavailable.
- Produce an ATS score, missing keywords, priority issues, reviewer perspectives, and suggested rewrites.
- Let users approve changes, edit the improved draft, and save version history.
- Persist versions and feedback through Anna app storage.
- Attach saved-version handoff notes to Anna chat when the chat grant is available.

## Production Architecture

The production manifest does not require `tools.invoke` or any bundled Executa:

```json
{
  "required_executas": [],
  "ui": {
    "host_api": {
      "llm": ["complete"],
      "storage": ["get", "set", "delete", "list"],
      "chat": ["write_message", "append_artifact"],
      "window": ["set_title"]
    }
  }
}
```

Review flow:

```text
resume upload / paste
  -> inline text extraction
  -> optional Anna LLM structured review
  -> deterministic inline fallback if LLM is unavailable
  -> editable draft + versions in Anna storage
```

The legacy `executas/resume-reviewer-python` tool remains in the repo as a tested Executa implementation and binary-distribution reference, but the live app no longer depends on a local Agent being online.

## UI Flow

1. **Review**: upload or paste the resume, add target role details, and choose review perspectives.
2. **Results**: inspect ATS score, missing keywords, problems, perspective tabs, and suggested rewrites.
3. **Versions**: save approved drafts and restore prior versions.
4. **Feedback**: store a quick quality signal and notes for the next pass.

## Run Locally

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

## Privacy

Resume text is processed inside the Anna app iframe for extraction and fallback review. When Anna LLM is available, the app sends the pasted or extracted resume text and target-role context to Anna's hosted LLM interface. The app does not ask for OpenAI keys, provider keys, or third-party credentials. Saved drafts and feedback use Anna app storage scoped to the current app/user.

## Limitations

- Scanned or image-only PDFs do not contain selectable text. Use OCR first or paste the resume text.
- DOCX support covers standard zipped Word documents with `word/document.xml`; unusual encrypted or corrupted files should be pasted as text.
- LLM output is advisory. Users should review every suggested rewrite before applying.

## Production Checklist

- `npm run validate`
- `npm test`
- `npm run fixture:verify`
- `npm run test:e2e`
- `npm audit --json`
- `python -m py_compile executas\resume-reviewer-python\resume_reviewer_plugin.py`
- Desktop plus 320, 375, 414, and 768 px responsive checks.
- Confirm upload, bad-PDF pasted-text fallback, review, approve, save version, restore version, feedback, and Anna storage flows.
