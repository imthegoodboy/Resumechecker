# Resume Reviewer Executa

This bundled tool powers the Resume Reviewer Anna App.

- `analyze_resume` accepts pasted resume text or a small uploaded file payload.
- It extracts text from TXT/MD/JSON, DOCX, and simple PDFs.
- It asks Anna host sampling for structured feedback when granted.
- It falls back to deterministic analysis in `--no-llm` or offline preview.

Run from the app root:

```powershell
python -m py_compile executas\resume-reviewer-python\resume_reviewer_plugin.py
anna-app validate --strict
anna-app dev --port 5184 --llm-account https://anna.partners
```
