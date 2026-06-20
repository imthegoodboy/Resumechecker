# Deploy AI Resume Reviewer

Use production Anna unless you are intentionally testing staging.

```powershell
$ANNA_HOST = "https://anna.partners"
cd examples\anna-app-resume-reviewer
```

## Preflight

```powershell
anna-app whoami --json
npm test
npm run validate
npm run fixture:verify
npm run test:e2e
npm audit --json
python -m py_compile executas\resume-reviewer-python\resume_reviewer_plugin.py
```

## Preview

```powershell
anna-app dev --port 5184 --llm-account $ANNA_HOST
```

Manual checks:

- App loads in the Anna dev harness.
- Upload, paste, and target-role fields work.
- `tools.invoke` returns analysis.
- ATS score, missing keywords, problems, suggestions, and reviewer tabs render.
- Approving and saving creates a version.
- Restoring a version updates the draft editor.
- Feedback saves through storage.
- Mobile widths have no horizontal overflow.

## Publish Draft

```powershell
anna-app apps push --account $ANNA_HOST --json
```

## Cut And Submit

```powershell
anna-app apps cut 0.1.1 --account $ANNA_HOST --json
anna-app apps submit-review resume-reviewer --account $ANNA_HOST --json
anna-app apps status resume-reviewer --account $ANNA_HOST --json
```

Release only after Anna marks the app approved:

```powershell
anna-app apps release 0.1.1 --account $ANNA_HOST --json
```

Do not commit `.anna`, `.venv`, `node_modules`, `dist-anna`, PATs, or provider keys.
