"""
End-to-End Verification Suite for Jobby Starter Package:
1. Validates SQL schema structure & required tables/RLS
2. Validates Chrome Extension Manifest V3 & Indian portal permissions
3. Tests Python scraper bot (hashing dedup, fit scoring, mocked ATS JSON feed parsing)
4. Tests local static web server serving web/index.html and web/admin.html
"""

import hashlib
import http.server
import json
import os
import sys
import threading
import urllib.request
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scraper"))

import bot  # noqa: E402


def test_sql_schema():
    sql = (ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8")
    for table in ["profiles", "loops", "email_templates", "job_matches", "upi_payment_requests"]:
        assert f"public.{table}" in sql, f"Missing table {table}"
    assert "enable row level security" in sql
    assert "is_owner()" in sql
    assert "unique (user_id, job_url_hash)" in sql
    print("SQL SCHEMA CHECKS PASSED")


def test_extension_manifest():
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["manifest_version"] == 3
    hosts = " ".join(manifest["host_permissions"])
    for portal in ["naukri.com", "linkedin.com", "indeed.com", "instahyre.com", "hirist.tech", "cutshort.io", "wellfound.com", "internshala.com", "foundit.in", "shine.com"]:
        assert portal in hosts, f"Missing Indian portal {portal} in manifest"
    for f in ["popup.html", "popup.js", "background.js", "content.js"]:
        assert (ROOT / "extension" / f).exists(), f"Missing extension/{f}"
    print("CHROME EXTENSION MANIFEST CHECKS PASSED")


def test_scraper_bot():
    # Dedup hash ignores query params and case
    h1 = bot.hash_job_url("u1", "https://boards.greenhouse.io/razorpay/jobs/123?utm_source=test")
    h2 = bot.hash_job_url("u1", "HTTPS://boards.greenhouse.io/razorpay/jobs/123")
    assert h1 == h2 and len(h1) == 64

    # Fit score ranking
    high = bot.compute_fit_score("Python FastAPI SQL AWS", "Senior Python Backend", "FastAPI SQL AWS", "python, fastapi")
    low = bot.compute_fit_score("Python FastAPI", "Sales Executive", "B2B cold calling", "python, fastapi")
    assert high > low, f"Expected {high} > {low}"

    # Mock Greenhouse JSON response
    class MockResp:
        status_code = 200
        def json(self):
            return {
                "jobs": [
                    {
                        "title": "Backend Engineer (Python)",
                        "content": "<p>Build scalable APIs in Bengaluru</p>",
                        "location": {"name": "Bengaluru, India"},
                        "absolute_url": "https://boards.greenhouse.io/razorpay/jobs/999",
                    }
                ]
            }

    with patch.object(bot.requests, "get", return_value=MockResp()):
        jobs = bot.fetch_greenhouse_jobs("razorpay", "python")
        assert len(jobs) == 1
        assert jobs[0]["portal"] == "greenhouse"
        assert jobs[0]["location"] == "Bengaluru, India"
    print("SCRAPER BOT CHECKS PASSED")


def test_web_server():
    web_dir = str(ROOT / "web")

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=web_dir, **kwargs)
        def log_message(self, format, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        for page, expected in [("index.html", "Jobby"), ("admin.html", "Jobby Owner Admin Console")]:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/{page}") as r:
                assert r.status == 200
                body = r.read().decode("utf-8")
                assert expected in body
    finally:
        server.shutdown()
    print("WEB SERVER SMOKE TESTS PASSED")


if __name__ == "__main__":
    test_sql_schema()
    test_extension_manifest()
    test_scraper_bot()
    test_web_server()
    print("ALL PYTHON TESTS PASSED")
