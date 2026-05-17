#!/usr/bin/env python3
"""
Per-bug triage finisher — PIPE-EMAIL-RESTORE-001 Phase 2.

Posts the structured triage comment to a GitHub issue, applies triage labels,
and sends the "Bug #N triaged: X — Action needed" email. Called by the
scheduled Claude Code triage task after that task has produced the analysis.

Faithful port of the per-bug triage email design from
.github/workflows/agent-pipeline.yml lines 100-198 (the version that died
when the SDK was retired 2026-05-02).

Invocation:
    python3 Scripts/triage_bug.py <issue_number> --analysis <path-to-json>

Analysis JSON shape (validated):
    {
      "classification": "gameplay_bug" | "content_error" | "ui" | "translation_error" | "performance" | "duplicate" | ...,
      "severity":       "P0" | "P1" | "P2" | "P3",
      "confidence":     0-100 (integer),
      "description":    "1-2 sentence plain-English summary",
      "affected_files": ["Views/X.swift", "Data/Events/Y.json", ...],
      "recommended_fix":"1-3 sentence next-step suggestion",
      "analysis":       "longer paragraph explaining root cause hypothesis"
    }

Reads RESEND_API_KEY, AUTH_TOKEN from .env.pipeline-ops (game repo or local repo root).

Story: PIPE-EMAIL-RESTORE-001 Phase 2
"""

import argparse
import html as html_lib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

GAME_REPO = "RaufGlasgow/Sorting-History"
WORKER_BASE = "https://bug-webhook.emptycupmedia.workers.dev"  # direct Workers URL (sortinghistory.com proxy currently 1101s)
RESEND_FROM = "SortingHistory Pipeline <bugs@sortinghistory.com>"
RESEND_API = "https://api.resend.com/emails"
USER_AGENT = "PipelineOps/1.0 (resend-client)"

GOLD = "#8B6914"
GOLD_DARK = "#6b5010"

VALID_SEVERITIES = {"P0", "P1", "P2", "P3"}
VALID_CLASSIFICATIONS = {
    "gameplay_bug",
    "content_error",
    "ui",
    "translation_error",
    "performance",
    "duplicate",
    "needs_human_review",
    "feature_request",
    "rejected",
}


def load_env_file(path: str) -> None:
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def gh_api(method: str, path: str, body: dict | None = None) -> dict | list:
    args = ["gh", "api", "-X", method, path]
    if body is not None:
        for k, v in body.items():
            args += ["-f", f"{k}={v}"] if isinstance(v, str) else ["--raw-field", f"{k}={v}"]
    out = subprocess.run(args, capture_output=True, text=True, check=False)
    if out.returncode != 0:
        print(f"gh api {method} {path} failed: {out.stderr}", file=sys.stderr)
        return {}
    try:
        return json.loads(out.stdout) if out.stdout.strip() else {}
    except json.JSONDecodeError:
        return {}


def gh(args: list[str]) -> tuple[int, str]:
    out = subprocess.run(["gh"] + args, capture_output=True, text=True, check=False)
    return out.returncode, (out.stdout + out.stderr).strip()


def esc(s: str | None) -> str:
    return html_lib.escape(s or "", quote=False)


def validate_analysis(a: dict) -> list[str]:
    errors = []
    if not isinstance(a.get("classification"), str):
        errors.append("classification must be a string")
    elif a["classification"] not in VALID_CLASSIFICATIONS:
        errors.append(
            f"classification must be one of {sorted(VALID_CLASSIFICATIONS)}, got {a['classification']!r}"
        )
    if a.get("severity") not in VALID_SEVERITIES:
        errors.append(f"severity must be one of {sorted(VALID_SEVERITIES)}, got {a.get('severity')!r}")
    if not isinstance(a.get("confidence"), int) or not (0 <= a["confidence"] <= 100):
        errors.append("confidence must be int 0-100")
    for k in ("description", "recommended_fix", "analysis"):
        if not isinstance(a.get(k), str) or not a[k].strip():
            errors.append(f"{k} must be a non-empty string")
    if not isinstance(a.get("affected_files"), list):
        errors.append("affected_files must be a list of strings")
    return errors


def build_analysis_comment(issue_num: int, a: dict) -> str:
    files_md = (
        "\n".join(f"- `{f}`" for f in a["affected_files"])
        if a["affected_files"]
        else "_None identified_"
    )
    return (
        f"## AI Bug Analysis\n\n"
        f"**Severity:** {a['severity']}\n"
        f"**Type:** {a['classification']}\n"
        f"**Confidence:** {a['confidence']}%\n\n"
        f"### Analysis\n\n{a['analysis']}\n\n"
        f"### Recommended Fix\n\n{a['recommended_fix']}\n\n"
        f"### Affected Files\n\n{files_md}\n\n"
        f"---\n"
        f"_Triaged by scheduled Claude Code task (PIPE-EMAIL-RESTORE-001 Phase 2)._"
    )


def apply_labels(issue_num: int, a: dict) -> None:
    labels = ["triaged", f"severity/{a['severity']}", a["classification"]]
    rc, out = gh(
        [
            "issue",
            "edit",
            str(issue_num),
            "--repo",
            GAME_REPO,
            "--add-label",
            ",".join(labels),
        ]
    )
    if rc != 0:
        # Some labels may not exist yet — create them
        for lbl in labels:
            gh(
                [
                    "label",
                    "create",
                    lbl,
                    "--repo",
                    GAME_REPO,
                    "--description",
                    "Auto-created by triage_bug.py",
                    "--color",
                    "ededed",
                    "--force",
                ]
            )
        gh(
            [
                "issue",
                "edit",
                str(issue_num),
                "--repo",
                GAME_REPO,
                "--add-label",
                ",".join(labels),
            ]
        )


def post_analysis_comment(issue_num: int, body: str) -> None:
    import tempfile

    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write(body)
        path = f.name
    rc, out = gh(
        [
            "issue",
            "comment",
            str(issue_num),
            "--repo",
            GAME_REPO,
            "--body-file",
            path,
        ]
    )
    os.unlink(path)
    if rc != 0:
        print(f"WARNING: failed to post analysis comment: {out}", file=sys.stderr)


def build_email_html(issue_num: int, a: dict, auth_token: str) -> str:
    issue_url = f"https://github.com/{GAME_REPO}/issues/{issue_num}"
    approve_url = f"{WORKER_BASE}/api/pipeline/approve?issue={issue_num}&token={auth_token}"
    local_url = f"{WORKER_BASE}/api/pipeline/fix-locally?issue={issue_num}&token={auth_token}"
    reject_url = f"{WORKER_BASE}/api/pipeline/reject?issue={issue_num}&token={auth_token}"
    files_html = (
        "<br/>".join(f"&bull; <code>{esc(f)}</code>" for f in a["affected_files"])
        if a["affected_files"]
        else "None identified"
    )
    return (
        '<div style="font-family:-apple-system,BlinkMacSystemFont,&#39;Segoe UI&#39;,Roboto,sans-serif;'
        'max-width:600px;margin:0 auto;padding:0;background:#fffdf8;">'
        f'<div style="background:{GOLD};padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">'
        '<img src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History" '
        'style="width:80px;height:80px;border-radius:18px;margin-bottom:12px;" />'
        f'<div style="display:inline-block;padding:4px 14px;background:{GOLD_DARK};border-radius:20px;margin-bottom:8px;">'
        '<span style="color:#fff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Bug Triaged</span>'
        "</div>"
        f'<h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Issue #{issue_num} Triaged</h1>'
        "</div>"
        '<div style="padding:28px 24px;background:#fff;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">'
        '<div style="margin:0 0 20px 0;padding:14px 16px;background:#f0f7ff;border-left:4px solid #3b82f6;border-radius:4px;">'
        '<p style="margin:0 0 4px 0;font-size:12px;color:#1e40af;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Classification</p>'
        f'<p style="margin:0;font-size:16px;color:#333;font-weight:700;">{esc(a["classification"])}</p>'
        "</div>"
        '<table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;">'
        '<tr><td style="padding:8px 0;font-size:13px;color:#666;">Severity</td>'
        f'<td style="padding:8px 0;font-size:13px;color:#333;font-weight:600;text-align:right;">{esc(a["severity"])}</td></tr>'
        '<tr><td style="padding:8px 0;font-size:13px;color:#666;border-top:1px solid #eee;">Confidence</td>'
        f'<td style="padding:8px 0;font-size:13px;color:#333;font-weight:600;text-align:right;border-top:1px solid #eee;">{a["confidence"]}%</td></tr>'
        "</table>"
        '<div style="margin:0 0 20px 0;padding:14px 16px;background:#fafaf8;border:1px solid #e5e1d8;border-radius:8px;">'
        f'<p style="margin:0 0 4px 0;font-size:12px;color:{GOLD};font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Summary</p>'
        f'<p style="margin:0;font-size:14px;color:#333;line-height:1.5;">{esc(a["description"])}</p>'
        "</div>"
        '<div style="margin:0 0 20px 0;padding:14px 16px;background:#fafaf8;border:1px solid #e5e1d8;border-radius:8px;">'
        f'<p style="margin:0 0 4px 0;font-size:12px;color:{GOLD};font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Analysis</p>'
        f'<p style="margin:0;font-size:14px;color:#333;line-height:1.5;">{esc(a["analysis"])}</p>'
        "</div>"
        '<div style="margin:0 0 20px 0;padding:14px 16px;background:#fafaf8;border:1px solid #e5e1d8;border-radius:8px;">'
        f'<p style="margin:0 0 4px 0;font-size:12px;color:{GOLD};font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Recommended Fix</p>'
        f'<p style="margin:0;font-size:14px;color:#333;line-height:1.5;">{esc(a["recommended_fix"])}</p>'
        "</div>"
        '<div style="margin:0 0 24px 0;padding:14px 16px;background:#fafaf8;border:1px solid #e5e1d8;border-radius:8px;">'
        f'<p style="margin:0 0 4px 0;font-size:12px;color:{GOLD};font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Affected Files</p>'
        f'<p style="margin:0;font-size:13px;color:#333;line-height:1.8;">{files_html}</p>'
        "</div>"
        '<div style="text-align:center;">'
        f'<a href="{approve_url}" style="display:inline-block;padding:14px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Approve Fix</a>'
        f'<a href="{local_url}" style="display:inline-block;padding:14px 24px;background:{GOLD};color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Fix Locally</a>'
        f'<a href="{reject_url}" style="display:inline-block;padding:14px 24px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Reject</a>'
        "</div>"
        f'<p style="text-align:center;margin-top:12px;"><a href="{issue_url}" style="color:{GOLD};font-size:13px;text-decoration:none;">View issue on GitHub &rarr;</a></p>'
        "</div>"
        '<div style="padding:16px 24px;background:#f5f0e8;border:1px solid #e5e1d8;border-top:none;border-radius:0 0 12px 12px;text-align:center;">'
        f'<p style="margin:0 0 4px 0;font-size:12px;color:{GOLD};font-weight:600;">Sorting History &mdash; Learn history by playing it</p>'
        '<p style="margin:0;font-size:10px;color:#aaa;">SortingHistory Pipeline &bull; Agent triage notification</p>'
        "</div></div>"
    )


def send_email(subject: str, html: str, to: str, api_key: str) -> str:
    data = json.dumps(
        {"from": RESEND_FROM, "to": [to], "subject": subject, "html": html}
    ).encode()
    req = urllib.request.Request(
        RESEND_API,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        resp = urllib.request.urlopen(req)
        body = json.loads(resp.read())
        return body.get("id", "(no id)")
    except urllib.error.HTTPError as e:
        print(f"Resend send failed: HTTP {e.code} body={e.read().decode()}", file=sys.stderr)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Finalize triage for a single bug")
    parser.add_argument("issue", type=int, help="GitHub issue number in RaufGlasgow/Sorting-History")
    parser.add_argument("--analysis", required=True, help="Path to analysis JSON file")
    parser.add_argument(
        "--skip-email", action="store_true", help="Apply labels + post comment but don't send email"
    )
    args = parser.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(here, ".."))
    parent_repo = os.path.abspath(os.path.join(repo_root, "..", "SortingHistory"))
    for env_path in [
        os.path.join(repo_root, ".env.pipeline-ops"),
        os.path.join(parent_repo, ".env.pipeline-ops"),
    ]:
        load_env_file(env_path)

    for key in ("RESEND_API_KEY", "AUTH_TOKEN"):
        if not os.environ.get(key):
            print(f"Missing required env: {key}", file=sys.stderr)
            return 1

    if not os.path.exists(args.analysis):
        print(f"Analysis file not found: {args.analysis}", file=sys.stderr)
        return 1
    with open(args.analysis) as f:
        a = json.load(f)

    errors = validate_analysis(a)
    if errors:
        for e in errors:
            print(f"Analysis validation: {e}", file=sys.stderr)
        return 1

    # 1) Post structured comment (digest's ANALYZED card reads this later)
    post_analysis_comment(args.issue, build_analysis_comment(args.issue, a))

    # 2) Apply labels
    apply_labels(args.issue, a)

    # 3) Send email (unless --skip-email for dry-run)
    if not args.skip_email:
        to = os.environ.get("OWNER_EMAIL", "emptycupmedianv@gmail.com")
        html = build_email_html(args.issue, a, os.environ["AUTH_TOKEN"])
        subject = f"Bug #{args.issue} triaged: {a['classification']} -- Action needed"
        rid = send_email(subject, html, to, os.environ["RESEND_API_KEY"])
        print(f"Triage email sent. id={rid} issue={args.issue} classification={a['classification']} severity={a['severity']}")
    else:
        print(f"Triage finalized (no email). issue={args.issue} classification={a['classification']} severity={a['severity']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
