#!/usr/bin/env python3
"""Resume Reviewer Anna Executa.

The tool returns a stable JSON shape for the app UI:
ats_score, summary, missing_keywords, problems, perspectives, suggestions,
and improved_resume. Anna sampling is used when available; deterministic
analysis keeps the app functional in no-LLM local preview.
"""

from __future__ import annotations

import asyncio
import base64
import html
import json
import re
import sys
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

try:
    import executa_sdk  # noqa: F401
except ModuleNotFoundError:
    _SDK_PATH = Path(__file__).resolve().parents[4] / "sdk" / "python"
    if _SDK_PATH.is_dir():
        sys.path.insert(0, str(_SDK_PATH))

from executa_sdk import PROTOCOL_VERSION_V2, SamplingClient, SamplingError  # noqa: E402


MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_RESUME_CHARS = 28000

MANIFEST = {
    "display_name": "Resume Reviewer",
    "version": "0.1.0",
    "description": "Structured resume review for ATS match, recruiter screen, and senior technical evidence.",
    "author": "Anna Developer",
    "host_capabilities": ["llm.sample"],
    "tools": [
        {
            "name": "analyze_resume",
            "description": "Analyze a resume and return ATS score, missing keywords, problems, suggestions, reviewer perspectives, and an improved draft.",
            "parameters": [
                {
                    "name": "resume_text",
                    "type": "string",
                    "description": "Plain resume text pasted by the user.",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "file_b64",
                    "type": "string",
                    "description": "Optional base64-encoded uploaded resume file, max 2 MB.",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "filename",
                    "type": "string",
                    "description": "Original uploaded file name.",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "mime_type",
                    "type": "string",
                    "description": "Uploaded file MIME type.",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "target_role",
                    "type": "string",
                    "description": "Target role or title.",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "job_description",
                    "type": "string",
                    "description": "Target job description or keyword list.",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "perspectives",
                    "type": "array",
                    "items_type": "string",
                    "description": "Reviewer perspectives to include: recruiter, ats, engineer.",
                    "required": False,
                    "default": ["recruiter", "ats", "engineer"],
                },
                {
                    "name": "max_tokens",
                    "type": "integer",
                    "description": "Maximum sampling output tokens.",
                    "required": False,
                    "default": 2600,
                },
            ],
        }
    ],
    "runtime": {"type": "uv", "min_version": "0.1.0"},
}


_stdout_lock = threading.Lock()


def _write_frame(msg: dict[str, Any]) -> None:
    payload = json.dumps(msg, ensure_ascii=False)
    with _stdout_lock:
        sys.stdout.write(payload + "\n")
        sys.stdout.flush()


sampling = SamplingClient(write_frame=_write_frame)


def _make_response(req_id: Any, *, result: Any = None, error: dict[str, Any] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id}
    if error is None:
        out["result"] = result
    else:
        out["error"] = error
    return out


def _handle_initialize(req_id: Any, params: dict[str, Any]) -> dict[str, Any]:
    proto = (params or {}).get("protocolVersion") or "1.1"
    if proto != PROTOCOL_VERSION_V2:
        sampling.disable(
            f"host did not negotiate v2 (offered protocolVersion={proto!r}); sampling/createMessage unavailable"
        )
    return _make_response(
        req_id,
        result={
            "protocolVersion": proto if proto in ("1.1", "2.0") else "2.0",
            "serverInfo": {"name": MANIFEST["display_name"], "version": MANIFEST["version"]},
            "client_capabilities": {"sampling": {}} if proto == PROTOCOL_VERSION_V2 else {},
            "capabilities": {},
        },
    )


def _handle_describe(req_id: Any) -> dict[str, Any]:
    return _make_response(req_id, result=MANIFEST)


def _handle_health(req_id: Any) -> dict[str, Any]:
    return _make_response(
        req_id,
        result={
            "status": "healthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "version": MANIFEST["version"],
        },
    )


async def _analyze_resume(
    resume_text: str = "",
    file_b64: str = "",
    filename: str = "",
    mime_type: str = "",
    target_role: str = "",
    job_description: str = "",
    perspectives: list[str] | None = None,
    max_tokens: int = 2600,
    *,
    invoke_id: str,
) -> dict[str, Any]:
    extracted_text, source_note = _collect_resume_text(resume_text, file_b64, filename, mime_type)
    if not extracted_text.strip():
        raise ValueError("No readable resume text was provided.")

    fallback = _deterministic_analysis(
        resume_text=extracted_text,
        target_role=target_role,
        job_description=job_description,
        source_note=source_note,
    )

    try:
        llm_analysis = await _sample_analysis(
            resume_text=extracted_text,
            target_role=target_role,
            job_description=job_description,
            perspectives=perspectives or ["recruiter", "ats", "engineer"],
            max_tokens=max_tokens,
            invoke_id=invoke_id,
            fallback=fallback,
        )
        analysis = _merge_analysis(llm_analysis, fallback)
        analysis["used_llm"] = True
    except (SamplingError, asyncio.TimeoutError, ValueError, json.JSONDecodeError) as exc:
        analysis = fallback
        analysis["used_llm"] = False
        analysis["source_note"] = _friendly_fallback_note(source_note, exc)

    analysis["source"] = {
        "filename": filename or "",
        "mime_type": mime_type or "",
        "chars": len(extracted_text),
    }
    return {"analysis": analysis}


def _friendly_fallback_note(source_note: str, exc: Exception) -> str:
    message = str(exc).lower()
    if "llm.complete" in message or "not grant" in message or "not negotiated" in message:
        return source_note
    if isinstance(exc, asyncio.TimeoutError):
        return f"{source_note}; fallback after timeout"
    return f"{source_note}; fallback analysis"


def _collect_resume_text(resume_text: str, file_b64: str, filename: str, mime_type: str) -> tuple[str, str]:
    pieces: list[str] = []
    notes: list[str] = []
    if resume_text and resume_text.strip():
        pieces.append(resume_text.strip())
        notes.append("pasted text")
    if file_b64:
        raw = base64.b64decode(file_b64, validate=False)
        if len(raw) > MAX_FILE_BYTES:
            raise ValueError("Uploaded file exceeds 2 MB.")
        text, note = _extract_file_text(raw, filename, mime_type)
        if text.strip():
            pieces.append(text.strip())
        notes.append(note)
    combined = "\n\n".join(pieces)
    combined = _clean_text(combined)
    return combined[:MAX_RESUME_CHARS], "; ".join(notes) or "text"


def _extract_file_text(raw: bytes, filename: str, mime_type: str) -> tuple[str, str]:
    lower = filename.lower()
    if lower.endswith(".docx") or "wordprocessingml" in mime_type:
        return _extract_docx(raw), "docx extraction"
    if lower.endswith(".pdf") or mime_type == "application/pdf":
        return _extract_pdf_basic(raw), "pdf text scan"
    try:
        return raw.decode("utf-8"), "utf-8 text"
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="ignore"), "latin-1 text"


def _extract_docx(raw: bytes) -> str:
    with zipfile.ZipFile(BytesIO(raw)) as zf:
        names = [n for n in zf.namelist() if n.startswith("word/") and n.endswith(".xml")]
        parts: list[str] = []
        for name in ["word/document.xml", *names]:
            if name not in zf.namelist():
                continue
            xml = zf.read(name).decode("utf-8", errors="ignore")
            text_nodes = re.findall(r"<w:t[^>]*>(.*?)</w:t>", xml, flags=re.S)
            parts.extend(html.unescape(t) for t in text_nodes)
            if parts:
                break
    return _clean_text(" ".join(parts))


def _extract_pdf_basic(raw: bytes) -> str:
    blob = raw.decode("latin-1", errors="ignore")
    strings = re.findall(r"\((?:\\.|[^\\)]){2,}\)\s*Tj", blob)
    parts: list[str] = []
    for item in strings:
        token = item.rsplit(")", 1)[0][1:]
        token = token.replace(r"\(", "(").replace(r"\)", ")").replace(r"\n", " ")
        parts.append(token)
    if len(" ".join(parts)) < 200:
        readable = re.sub(r"[^A-Za-z0-9@:/.,+#()_\-\s]", " ", blob)
        parts.append(readable)
    return _clean_text(" ".join(parts))


def _clean_text(text: str) -> str:
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


async def _sample_analysis(
    *,
    resume_text: str,
    target_role: str,
    job_description: str,
    perspectives: list[str],
    max_tokens: int,
    invoke_id: str,
    fallback: dict[str, Any],
) -> dict[str, Any]:
    max_tokens = max(900, min(4096, int(max_tokens or 2600)))
    schema = {
        "ats_score": "integer 0-100",
        "summary": "one sentence",
        "missing_keywords": ["keyword"],
        "problems": [{"title": "string", "detail": "string", "severity": "high|medium|low"}],
        "perspectives": {
            "recruiter": {"verdict": "string", "findings": ["string"], "priorities": ["string"]},
            "ats": {"verdict": "string", "findings": ["string"], "priorities": ["string"]},
            "engineer": {"verdict": "string", "findings": ["string"], "priorities": ["string"]},
        },
        "suggestions": [
            {
                "id": "s1",
                "section": "Summary|Skills|Experience|Projects|Education",
                "title": "string",
                "reason": "string",
                "rewrite": "specific replacement text",
                "impact": "ats|recruiter|engineer",
            }
        ],
        "improved_resume": "edited resume text, not just notes",
    }
    prompt = f"""
Return strict JSON only. Review this resume for a job seeker.

Target role:
{target_role or "Not provided"}

Job description or keywords:
{job_description or "Not provided"}

Requested perspectives:
{", ".join(perspectives)}

Fallback keyword findings to respect unless the resume proves otherwise:
{json.dumps({"ats_score": fallback["ats_score"], "missing_keywords": fallback["missing_keywords"][:12]}, ensure_ascii=False)}

JSON schema:
{json.dumps(schema, ensure_ascii=False)}

Rules:
- Do not invent degrees, employers, dates, certifications, or metrics.
- If rewriting, preserve facts from the resume and mark unknown values with brackets.
- Keep the improved resume concise and editable.
- Suggestions must be actionable and section-specific.
- Missing keywords must be truthful candidates from the target role or job description.

Resume:
{resume_text[:MAX_RESUME_CHARS]}
""".strip()

    result = await sampling.create_message(
        messages=[{"role": "user", "content": {"type": "text", "text": prompt}}],
        max_tokens=max_tokens,
        system_prompt=(
            "You are a rigorous resume reviewer. Output only valid JSON. "
            "Separate ATS matching, recruiter screening, and senior-engineer evidence."
        ),
        temperature=0.2,
        metadata={"executa_invoke_id": invoke_id, "tool": "analyze_resume"},
        timeout=90.0,
    )
    text = _extract_text(result)
    parsed = _parse_json_object(text)
    parsed["model"] = result.get("model") or ""
    return parsed


def _extract_text(result: dict[str, Any]) -> str:
    content = result.get("content") or {}
    if isinstance(content, dict) and content.get("type") == "text":
        return str(content.get("text") or "")
    if isinstance(content, list):
        return "\n".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def _parse_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise json.JSONDecodeError("No JSON object found", text, 0)
    return json.loads(text[start : end + 1])


def _merge_analysis(llm: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    out = dict(fallback)
    for key in [
        "ats_score",
        "summary",
        "missing_keywords",
        "problems",
        "perspectives",
        "suggestions",
        "improved_resume",
        "model",
    ]:
        if key in llm and llm[key]:
            out[key] = llm[key]
    out["ats_score"] = _clamp_score(out.get("ats_score"))
    out["missing_keywords"] = _string_list(out.get("missing_keywords"))[:20]
    out["problems"] = _normalize_problem_list(out.get("problems"))[:12]
    out["suggestions"] = _normalize_suggestions(out.get("suggestions"))[:10]
    out["perspectives"] = _normalize_perspectives(out.get("perspectives"))
    out["summary"] = str(out.get("summary") or fallback["summary"])
    out["improved_resume"] = str(out.get("improved_resume") or fallback["improved_resume"])
    out["source_note"] = fallback.get("source_note", "")
    return out


def _deterministic_analysis(*, resume_text: str, target_role: str, job_description: str, source_note: str) -> dict[str, Any]:
    lower = resume_text.lower()
    role = target_role.strip() or "target role"
    desired = _desired_keywords(target_role, job_description)
    resume_terms = set(_terms(resume_text))
    missing = [kw for kw in desired if kw.lower() not in resume_terms][:18]
    sections = {
        "summary": bool(re.search(r"\b(summary|profile|objective)\b", lower)),
        "skills": bool(re.search(r"\b(skills|technical skills|tools)\b", lower)),
        "experience": bool(re.search(r"\b(experience|work history|employment)\b", lower)),
        "projects": bool(re.search(r"\b(projects|portfolio)\b", lower)),
        "education": bool(re.search(r"\b(education|degree|university|college)\b", lower)),
    }
    has_metric = bool(re.search(r"\d+%|\$?\d+[kKmM]?|\b\d+\s*(users|requests|projects|clients|seconds|minutes|hours|ms)\b", lower))
    has_contact = bool(re.search(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d\s().-]{8,}", lower))
    has_links = bool(re.search(r"linkedin|github|portfolio|https?://", lower))
    action_verbs = ["built", "launched", "improved", "reduced", "automated", "designed", "implemented", "optimized", "led", "shipped"]
    verb_hits = sum(1 for verb in action_verbs if re.search(rf"\b{verb}\b", lower))

    penalties = len(missing) * 2
    penalties += 10 if not has_metric else 0
    penalties += 8 if not sections["skills"] else 0
    penalties += 8 if not (sections["experience"] or sections["projects"]) else 0
    penalties += 5 if not has_contact else 0
    penalties += 4 if not has_links else 0
    penalties += 5 if verb_hits < 3 else 0
    ats_score = max(35, min(94, 92 - penalties))

    problems: list[dict[str, str]] = []
    if missing:
        problems.append({
            "title": "Role keywords are missing",
            "detail": "The resume does not mirror important terms from the target role or job description.",
            "severity": "high",
        })
    if not has_metric:
        problems.append({
            "title": "Impact is not quantified",
            "detail": "Several bullets describe duties without numbers, scope, or outcomes.",
            "severity": "high",
        })
    if not sections["skills"]:
        problems.append({
            "title": "Skills section is hard to scan",
            "detail": "ATS systems and recruiters expect a clear skills section with exact terms.",
            "severity": "medium",
        })
    if not (sections["experience"] or sections["projects"]):
        problems.append({
            "title": "Evidence section is missing",
            "detail": "Add experience or projects that prove the target skills in context.",
            "severity": "high",
        })
    if not has_links:
        problems.append({
            "title": "External proof links are thin",
            "detail": "Add LinkedIn, GitHub, portfolio, or project links when they support the role.",
            "severity": "medium",
        })
    if not problems:
        problems.append({
            "title": "Final polish pass",
            "detail": "The structure is workable; focus on tighter bullets and exact target language.",
            "severity": "low",
        })

    suggestions = _fallback_suggestions(role, missing, has_metric, sections)
    improved = _fallback_improved_resume(resume_text, role, missing, suggestions)
    summary = f"{role} match is {ats_score}/100; strongest next step is {suggestions[0]['title'].lower()}."
    return {
        "ats_score": ats_score,
        "summary": summary,
        "source_note": source_note,
        "missing_keywords": missing,
        "problems": problems,
        "perspectives": {
            "recruiter": {
                "verdict": "The resume can pass a human first screen after the top-third story is tightened.",
                "findings": [
                    "Lead with the target role, strongest project, and proof of ownership.",
                    "Move the most relevant skills into the first half of the document.",
                    "Keep bullets short enough to scan in under ten seconds.",
                ],
                "priorities": ["Rewrite the summary", "Quantify recent work", "Move proof links near contact details"],
            },
            "ats": {
                "verdict": "The ATS score is held back by missing exact terms and section clarity.",
                "findings": [f"Missing keyword: {kw}" for kw in missing[:6]] or ["Keyword coverage is acceptable."],
                "priorities": ["Use exact truthful keywords", "Keep standard headings", "Avoid graphics-only information"],
            },
            "engineer": {
                "verdict": "The technical story needs more evidence of scope, tradeoffs, and impact.",
                "findings": [
                    "Project bullets should name stack, responsibility, and measured result.",
                    "Replace generic claims with implementation details.",
                    "Show debugging, testing, performance, or collaboration evidence where true.",
                ],
                "priorities": ["Rewrite project bullets", "Add stack and metrics", "Name technical constraints"],
            },
        },
        "suggestions": suggestions,
        "improved_resume": improved,
        "used_llm": False,
    }


def _desired_keywords(target_role: str, job_description: str) -> list[str]:
    role_text = f"{target_role} {job_description}"
    base = _terms(role_text)
    role_lower = target_role.lower()
    role_map = {
        "frontend": ["javascript", "typescript", "react", "html", "css", "accessibility", "testing"],
        "backend": ["api", "database", "sql", "python", "node", "testing", "scalability"],
        "data": ["sql", "python", "analytics", "dashboard", "statistics", "etl", "modeling"],
        "engineer": ["testing", "debugging", "git", "api", "performance", "documentation"],
        "intern": ["projects", "coursework", "teamwork", "learning", "github"],
        "product": ["roadmap", "analytics", "user research", "experiments", "stakeholders"],
    }
    extras: list[str] = []
    for key, values in role_map.items():
        if key in role_lower:
            extras.extend(values)
    ordered = list(dict.fromkeys([*base, *extras]))
    return ordered[:26]


def _terms(text: str) -> list[str]:
    stop = {
        "and", "the", "for", "with", "from", "that", "this", "your", "you", "our",
        "are", "will", "can", "all", "any", "have", "has", "job", "role", "work",
        "team", "using", "use", "across", "their", "they", "into", "about",
    }
    found = re.findall(r"[a-zA-Z][a-zA-Z0-9+#.-]{2,}", text.lower())
    return [w for w in dict.fromkeys(found) if w not in stop and len(w) <= 28]


def _fallback_suggestions(role: str, missing: list[str], has_metric: bool, sections: dict[str, bool]) -> list[dict[str, str]]:
    out = [
        {
            "id": "s1",
            "section": "Summary",
            "title": "State target fit in one line",
            "reason": "Recruiters scan the top third first.",
            "rewrite": f"{role.title()} candidate with hands-on project evidence in {', '.join(missing[:3]) or 'the target stack'}.",
            "impact": "recruiter",
        }
    ]
    if missing:
        out.append({
            "id": "s2",
            "section": "Skills",
            "title": "Add truthful missing keywords",
            "reason": "ATS systems match exact wording from the job description.",
            "rewrite": ", ".join(missing[:10]),
            "impact": "ats",
        })
    if not has_metric:
        out.append({
            "id": "s3",
            "section": "Experience",
            "title": "Quantify at least three bullets",
            "reason": "Numbers make responsibilities credible and easier to rank.",
            "rewrite": "Built [feature] with [stack], improving [metric] for [users/team].",
            "impact": "engineer",
        })
    if not sections.get("projects"):
        out.append({
            "id": "s4",
            "section": "Projects",
            "title": "Add one role-matched project",
            "reason": "Freshers need project evidence when work experience is light.",
            "rewrite": "Project Name - [stack]. Implemented [feature], handled [constraint], and measured [result].",
            "impact": "engineer",
        })
    return out[:8]


def _fallback_improved_resume(resume_text: str, role: str, missing: list[str], suggestions: list[dict[str, str]]) -> str:
    notes = [
        "",
        "Targeted improvement notes:",
        f"- Target role: {role}",
        f"- Add truthful keywords where they match your experience: {', '.join(missing[:10]) or 'no obvious gaps found'}",
    ]
    for item in suggestions:
        notes.append(f"- {item['section']}: {item['rewrite']}")
    return _clean_text(resume_text) + "\n\n" + "\n".join(notes)


def _clamp_score(value: Any) -> int:
    try:
        return max(0, min(100, int(round(float(value)))))
    except (TypeError, ValueError):
        return 0


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return []


def _normalize_problem_list(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    out = []
    for i, item in enumerate(value):
        if not isinstance(item, dict):
            item = {"title": f"Problem {i + 1}", "detail": str(item)}
        out.append({
            "title": str(item.get("title") or item.get("issue") or f"Problem {i + 1}"),
            "detail": str(item.get("detail") or item.get("reason") or item.get("description") or ""),
            "severity": str(item.get("severity") or "medium"),
        })
    return out


def _normalize_suggestions(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    out = []
    for i, item in enumerate(value):
        if not isinstance(item, dict):
            item = {"title": str(item)}
        out.append({
            "id": str(item.get("id") or f"s{i + 1}"),
            "section": str(item.get("section") or "Resume"),
            "title": str(item.get("title") or item.get("action") or "Improve this section"),
            "reason": str(item.get("reason") or item.get("detail") or ""),
            "rewrite": str(item.get("rewrite") or item.get("replacement") or ""),
            "impact": str(item.get("impact") or ""),
        })
    return out


def _normalize_perspectives(value: Any) -> dict[str, dict[str, Any]]:
    defaults = {
        "recruiter": {"verdict": "", "findings": [], "priorities": []},
        "ats": {"verdict": "", "findings": [], "priorities": []},
        "engineer": {"verdict": "", "findings": [], "priorities": []},
    }
    if not isinstance(value, dict):
        return defaults
    for key in defaults:
        raw = value.get(key) or {}
        if not isinstance(raw, dict):
            raw = {"verdict": str(raw)}
        defaults[key] = {
            "verdict": str(raw.get("verdict") or raw.get("summary") or ""),
            "findings": _string_list(raw.get("findings") or raw.get("notes") or raw.get("concerns")),
            "priorities": _string_list(raw.get("priorities") or raw.get("actions") or raw.get("next_steps")),
        }
    return defaults


_loop = asyncio.new_event_loop()
_loop_thread = threading.Thread(target=_loop.run_forever, daemon=True)
_loop_thread.start()


def _handle_invoke(req_id: Any, params: dict[str, Any]) -> dict[str, Any]:
    tool = params.get("tool")
    args = params.get("arguments") or {}
    invoke_id = params.get("invoke_id") or ""
    if tool != "analyze_resume":
        return _make_response(req_id, error={"code": -32601, "message": f"Unknown tool: {tool}"})
    fut = asyncio.run_coroutine_threadsafe(_analyze_resume(invoke_id=invoke_id, **args), _loop)
    try:
        data = fut.result(timeout=180.0)
    except SamplingError as exc:
        return _make_response(req_id, error={"code": exc.code, "message": exc.message, "data": exc.data})
    except (TypeError, ValueError) as exc:
        return _make_response(req_id, error={"code": -32602, "message": f"Invalid params: {exc}"})
    except Exception as exc:  # noqa: BLE001
        return _make_response(req_id, error={"code": -32603, "message": f"Tool execution failed: {exc}"})
    return _make_response(req_id, result={"success": True, "tool": tool, "data": data})


def _handle_message(line: str) -> None:
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        _write_frame(_make_response(None, error={"code": -32700, "message": "Parse error"}))
        return

    if "method" not in msg:
        if sampling.dispatch_response(msg):
            return
        print(f"unmatched response id={msg.get('id')!r}", file=sys.stderr)
        return

    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}
    if method == "initialize":
        response = _handle_initialize(req_id, params)
    elif method == "describe":
        response = _handle_describe(req_id)
    elif method == "health":
        response = _handle_health(req_id)
    elif method == "invoke":
        response = _handle_invoke(req_id, params)
    elif method == "shutdown":
        response = _make_response(req_id, result={"ok": True})
    else:
        response = _make_response(req_id, error={"code": -32601, "message": f"Method not found: {method}"})
    if req_id is not None:
        _write_frame(response)


def main() -> None:
    print("resume-reviewer plugin started", file=sys.stderr)
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="resume-reviewer")
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if line:
                pool.submit(_handle_message, line)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        _loop.call_soon_threadsafe(_loop.stop)


if __name__ == "__main__":
    main()
