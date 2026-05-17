#!/usr/bin/env python3
"""
Pipeline Digest — sends the bug-pipeline status email to OWNER_EMAIL.

Faithful Python port of the HTML email from .github/workflows/daily-analysis-digest.yml
(the design Ra'uf approved in screenshots from Feb-Apr 2026, documented in
docs/audits/pipeline-failure-progression-20260517.md and locked in
docs/stories/PIPE-EMAIL-RESTORE-001.story.md).

Invocation:
    python3 Scripts/pipeline_digest.py

Required env:
    RESEND_API_KEY  - Resend API key (Sending access sufficient)
    AUTH_TOKEN      - bug-webhook Worker /api/pipeline/* token
    OWNER_EMAIL     - destination address

Reads from .env.pipeline-ops at the repo root when running locally.

Story: PIPE-EMAIL-RESTORE-001 Phase 1
"""

import html as html_lib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

# ----------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------

GAME_REPO = "RaufGlasgow/Sorting-History"
BUGS_REPO = "RaufGlasgow/sortinghistory-bugs"
WORKER_BASE = "https://bug-webhook.emptycupmedia.workers.dev"
# (Direct Workers URL. The original template used https://sortinghistory.com
# which proxies through Cloudflare, but that route currently returns
# Cloudflare 1101/500. Direct URL works. Route binding to investigate
# separately — not blocking Phase 1.)
RESEND_FROM = "SortingHistory Pipeline <bugs@sortinghistory.com>"
RESEND_API = "https://api.resend.com/emails"
USER_AGENT = "PipelineOps/1.0 (resend-client)"

# Brand palette
GOLD = "#8B6914"
LIGHT_GOLD = "#DAA520"
CREAM = "#fffdf8"
PAGE_BG = "#f5f0e8"
FOOTER_BG = "#faf8f4"
AMBER = "#d97706"
AMBER_BG = "#fffbeb"
RED = "#dc2626"
RED_BG = "#fef2f2"

# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


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


def gh_api(path: str) -> list | dict:
    out = subprocess.run(
        ["gh", "api", path], capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        print(f"gh api {path} failed: {out.stderr}", file=sys.stderr)
        return []
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return []


def esc(s: str | None) -> str:
    return html_lib.escape(s or "", quote=False)


def fmt_date(iso: str | None) -> str:
    if not iso:
        return "Unknown"
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%b %d")
    except Exception:
        return iso[:10]


def extract_screenshot_url(body: str) -> str | None:
    import re

    m = re.search(r"https://[^)]+/screenshots/BUG-[A-Z0-9-]+\.png", body or "")
    return m.group(0) if m else None


def extract_actual_behavior(body: str) -> str:
    if not body:
        return ""
    lines = body.splitlines()
    out, capture = [], False
    for ln in lines:
        if ln.startswith("**Actual behavior:**"):
            capture = True
            continue
        if capture and ln.startswith("**"):
            break
        if capture and ln.strip():
            out.append(ln.strip())
    return " ".join(out)[:400]


# ----------------------------------------------------------------------
# Card builders
# ----------------------------------------------------------------------


def button(href: str, label: str, bg: str) -> str:
    return (
        f'<a href="{href}" style="display:inline-block;padding:12px 24px;'
        f"min-height:44px;min-width:44px;background:{bg};color:#fff;"
        f"text-decoration:none;border-radius:6px;font-size:14px;"
        f'font-weight:bold;text-align:center;line-height:20px;">{label}</a>'
    )


def card_untriaged(issue: dict, auth_token: str) -> tuple[str, bool]:
    """Render an AWAITING TRIAGE or TRIAGE FAILED card. Returns (html, was_failed)."""
    num = issue["number"]
    title = esc(issue["title"])
    body = issue.get("body") or ""
    labels = [lbl["name"] for lbl in issue.get("labels", [])]
    is_failed = "triage-failed" in labels
    filed = fmt_date(issue.get("created_at"))
    issue_url = issue.get("html_url", f"https://github.com/{GAME_REPO}/issues/{num}")
    actual = esc(extract_actual_behavior(body))
    shot = extract_screenshot_url(body)
    labels_str = esc(", ".join(labels))

    border = RED if is_failed else AMBER
    bg = RED_BG if is_failed else AMBER_BG
    pill_bg = RED if is_failed else AMBER
    pill_text = "TRIAGE FAILED" if is_failed else "AWAITING TRIAGE"
    explainer_color = "#991b1b" if is_failed else "#92400e"
    explainer = (
        "The AI triage pipeline crashed while classifying this bug. "
        "You can retry triage or fix it locally in Claude Code."
        if is_failed
        else "This bug has not been triaged yet. If it stays here for more "
        "than one digest cycle, something may be stuck."
    )

    retry_url = (
        f"{WORKER_BASE}/api/pipeline/retry-triage?issue={num}&token={auth_token}"
    )
    fix_local_url = (
        f"{WORKER_BASE}/api/pipeline/fix-locally?issue={num}&token={auth_token}"
    )
    reject_url = f"{WORKER_BASE}/api/pipeline/reject?issue={num}&token={auth_token}"

    h = []
    h.append(
        f'<div style="border:2px solid {border};border-radius:8px;padding:16px;'
        f'margin-bottom:16px;background:{bg};">'
    )
    h.append(
        f'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">'
        f'<span style="background:{pill_bg};color:#fff;padding:3px 8px;'
        f"border-radius:4px;font-size:11px;font-weight:bold;text-transform:uppercase;"
        f'letter-spacing:1px;">{pill_text}</span></div>'
    )
    h.append(
        f'<h3 style="margin:0 0 8px 0;font-size:16px;color:#1a1a1a;'
        f'white-space:normal;overflow-wrap:break-word;word-wrap:break-word;">'
        f"BUG #{num} &mdash; {title}</h3>"
    )
    if actual:
        h.append(
            f'<p style="margin:0 0 10px 0;font-size:14px;color:#333;line-height:1.4;'
            f'font-style:italic;">&ldquo;{actual}&rdquo;</p>'
        )
    if shot:
        h.append(
            f'<div style="margin:0 0 12px 0;"><img src="{shot}" alt="Bug screenshot" '
            f'style="max-width:300px;border-radius:8px;border:1px solid #ddd;"></div>'
        )
    h.append(
        f'<p style="margin:0 0 12px 0;font-size:13px;color:#666;">'
        f"Filed: {esc(filed)} | Labels: {labels_str}</p>"
    )
    h.append(
        f'<p style="margin:0 0 16px 0;font-size:14px;color:{explainer_color};'
        f'line-height:1.4;">{explainer}</p>'
    )
    h.append(f'<div style="display:flex;gap:8px;flex-wrap:wrap;">')
    if is_failed:
        h.append(button(retry_url, "Retry Triage", "#22863a"))
    h.append(button(fix_local_url, "Fix Locally", "#7c3aed"))
    h.append(button(reject_url, "Reject", "#cb2431"))
    h.append(button(issue_url, "View on GitHub", "#0366d6"))
    h.append("</div></div>")
    return "".join(h), is_failed


def card_pr(pr: dict) -> str:
    num = pr["number"]
    title = esc(pr["title"])
    url = pr.get("html_url", f"https://github.com/{GAME_REPO}/pull/{num}")
    head = esc(pr.get("head", {}).get("ref", "?"))
    opened = fmt_date(pr.get("created_at"))
    return (
        f'<div style="border:1px solid #d0d7de;border-radius:8px;padding:16px;'
        f'margin-bottom:12px;background:#f0fdf4;">'
        f'<div style="margin-bottom:6px;"><span style="background:#16a34a;'
        f"color:#fff;padding:3px 8px;border-radius:4px;font-size:11px;"
        f'font-weight:bold;letter-spacing:1px;">OPEN PR (FIX)</span></div>'
        f'<h3 style="margin:0 0 6px 0;font-size:15px;color:#1a1a1a;">PR #{num} &mdash; {title}</h3>'
        f'<p style="margin:0 0 10px 0;font-size:12px;color:#6b7280;">'
        f"Opened: {esc(opened)} | Branch: <code>{head}</code></p>"
        f'{button(url, "Review PR", "#7c3aed")}'
        f"</div>"
    )


# ----------------------------------------------------------------------
# Email shell
# ----------------------------------------------------------------------


def render_email(bugs: list[dict], prs: list[dict], auth_token: str) -> tuple[str, str]:
    bug_count = len(bugs)
    pr_count = len(prs)
    total = bug_count + pr_count

    bug_cards = []
    failed_count = 0
    for b in bugs:
        html, was_failed = card_untriaged(b, auth_token)
        bug_cards.append(html)
        if was_failed:
            failed_count += 1
    pr_cards = [card_pr(p) for p in prs]

    if total == 0:
        header_bg, badge, title = "#22863a", "All Clear", "Pipeline Healthy"
        subject = "SortingHistory: All clear -- pipeline healthy"
    elif bug_count and pr_count:
        header_bg, badge = GOLD, "Action Needed"
        title = f"{bug_count} Bug(s) + {pr_count} PR(s) for Review"
        subject = f"SortingHistory: {bug_count} bug(s) + {pr_count} PR(s) -- review needed"
    elif bug_count:
        header_bg, badge = GOLD, "Action Needed"
        title = f"{bug_count} Bug(s) for Review"
        subject = f"SortingHistory: {bug_count} bug(s) analyzed -- review needed"
    else:
        header_bg, badge = GOLD, "Action Needed"
        title = f"{pr_count} PR(s) for Review"
        subject = f"SortingHistory: {pr_count} PR(s) ready -- review needed"

    scan_ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    parts = []
    parts.append('<!DOCTYPE html><html><head><meta charset="utf-8">')
    parts.append('<meta name="viewport" content="width=device-width,initial-scale=1">')
    parts.append("</head>")
    parts.append(
        '<body style="margin:0;padding:0;font-family:-apple-system,'
        "BlinkMacSystemFont,&#39;Segoe UI&#39;,Roboto,sans-serif;"
        f'background:{PAGE_BG};">'
    )
    parts.append(
        f'<div style="max-width:600px;margin:0 auto;padding:0;background:{CREAM};">'
    )
    # Header
    parts.append(
        f'<div style="background:{header_bg};padding:32px 24px;text-align:center;'
        f'border-radius:12px 12px 0 0;">'
    )
    parts.append(
        f'<img src="https://sortinghistory.com/images/app-icon.png" '
        f'alt="Sorting History" style="width:80px;height:80px;border-radius:18px;'
        f'margin-bottom:12px;">'
    )
    parts.append(
        f'<div style="display:inline-block;padding:4px 14px;'
        f'background:rgba(0,0,0,0.2);border-radius:20px;margin-bottom:8px;">'
        f'<span style="color:#fff;font-size:12px;font-weight:700;'
        f'text-transform:uppercase;letter-spacing:1px;">{badge}</span></div>'
    )
    parts.append(
        f'<h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">{title}</h1>'
    )
    parts.append("</div>")
    # Main content
    parts.append(
        f'<div style="padding:28px 24px;background:#fff;'
        f'border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">'
    )
    if total == 0:
        parts.append(
            f'<p style="margin:0 0 20px 0;font-size:15px;color:#444;line-height:1.6;">'
            f"No bugs awaiting review and no PRs pending. The pipeline is running "
            f"smoothly. Scan ran at {scan_ts}.</p>"
        )
    else:
        if bug_count:
            parts.append(
                f'<h3 style="margin:20px 0 12px 0;font-size:17px;color:{GOLD};'
                f"border-bottom:2px solid {LIGHT_GOLD};padding-bottom:6px;\">"
                f"Bugs Awaiting Review</h3>"
            )
            parts.extend(bug_cards)
        if pr_count:
            parts.append(
                f'<h3 style="margin:20px 0 12px 0;font-size:17px;color:{GOLD};'
                f"border-bottom:2px solid {LIGHT_GOLD};padding-bottom:6px;\">"
                f"PRs Ready for Review</h3>"
            )
            parts.extend(pr_cards)
    # System health note (Phase 1: placeholder until per-bug triage runs)
    parts.append(
        f'<h3 style="margin:24px 0 12px 0;font-size:17px;color:{GOLD};'
        f'border-bottom:2px solid {LIGHT_GOLD};padding-bottom:6px;">System Health</h3>'
    )
    parts.append(
        f'<p style="margin:0 0 12px 0;font-size:14px;color:#555;font-style:italic;'
        f'line-height:1.5;">Phase 1 digest — per-bug triage analysis arrives in '
        f"Phase 2 (PIPE-EMAIL-RESTORE-001). Cards above show queue state only. "
        f"Scan ran at {scan_ts}.</p>"
    )
    if failed_count:
        parts.append(
            f'<div style="margin:16px 0;padding:12px 16px;border-radius:8px;'
            f'background:{RED_BG};border:1px solid #fca5a5;">'
            f'<p style="margin:0;font-size:13px;color:#991b1b;line-height:1.5;">'
            f"<strong>Triage failed:</strong> {failed_count} issue(s) need attention."
            f"</p></div>"
        )
    parts.append("</div>")
    # Footer
    parts.append(
        f'<div style="padding:20px 24px;background:{FOOTER_BG};'
        f'border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">'
    )
    parts.append(
        f'<p style="margin:0 0 4px 0;font-size:14px;color:{GOLD};font-weight:600;'
        f'text-align:center;">Sorting History</p>'
    )
    parts.append(
        f'<p style="margin:0 0 12px 0;font-size:13px;color:#777;text-align:center;">'
        f"Sort history's greatest moments into the correct order</p>"
    )
    parts.append(f'<p style="margin:0;font-size:13px;color:#888;text-align:center;">')
    social_links = [
        ("Website", "https://sortinghistory.com"),
        ("X/Twitter", "https://x.com/SortingHistory"),
        ("Instagram", "https://instagram.com/sortinghistory"),
        ("YouTube", "https://youtube.com/@sortinghistory"),
        ("Bluesky", "https://bsky.app/profile/sortinghistory.bsky.social"),
    ]
    parts.append(
        "&nbsp;&middot;&nbsp;".join(
            f'<a href="{u}" style="color:{GOLD};text-decoration:none;">{l}</a>'
            for l, u in social_links
        )
    )
    parts.append("</p></div>")
    # Bottom bar
    parts.append(
        f'<div style="padding:16px 24px;background:{PAGE_BG};'
        f"border:1px solid #e5e1d8;border-top:none;border-radius:0 0 12px 12px;"
        f'text-align:center;">'
    )
    parts.append(
        f'<p style="margin:0 0 4px 0;font-size:12px;color:{GOLD};font-weight:600;">'
        f"Sorting History &mdash; Learn history by playing it</p>"
    )
    parts.append(
        f'<p style="margin:0 0 4px 0;font-size:11px;"><a href="https://sortinghistory.com" '
        f'style="color:#999;text-decoration:none;">sortinghistory.com</a></p>'
    )
    parts.append(
        f'<p style="margin:0;font-size:10px;color:#aaa;">SortingHistory Pipeline &bull; '
        f'<a href="https://github.com/{GAME_REPO}/issues" '
        f'style="color:#aaa;text-decoration:none;">View all issues</a></p>'
    )
    parts.append("</div></div></body></html>")

    return subject, "".join(parts)


# ----------------------------------------------------------------------
# Send
# ----------------------------------------------------------------------


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


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------


def main() -> int:
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

    to = os.environ.get("OWNER_EMAIL", "emptycupmedianv@gmail.com")
    auth_token = os.environ["AUTH_TOKEN"]
    api_key = os.environ["RESEND_API_KEY"]

    # Pull data
    bugs = gh_api(f"repos/{GAME_REPO}/issues?labels=from-app&state=open&per_page=100")
    bugs = [b for b in bugs if "pull_request" not in b]
    all_prs = gh_api(f"repos/{GAME_REPO}/pulls?state=open&per_page=100")
    fix_prs = [
        p
        for p in all_prs
        if (p.get("head", {}).get("ref") or "").startswith(("fix/bug-", "fix/sdk-bug-"))
        and not p.get("draft")
    ]

    subject, html = render_email(bugs, fix_prs, auth_token)
    rid = send_email(subject, html, to, api_key)
    print(f"Sent. id={rid}")
    print(f"To: {to}")
    print(f"Subject: {subject}")
    print(f"Items: {len(bugs)} bugs, {len(fix_prs)} PRs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
