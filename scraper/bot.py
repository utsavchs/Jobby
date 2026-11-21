"""
Jobby Loop Scraper Bot (Free-tier GitHub Actions Worker)
Polls active user loops from Supabase, fetches Indian job portals (Naukri, LinkedIn, Indeed,
Glassdoor via JobSpy) + public ATS JSON feeds (Greenhouse, Lever, Ashby), deduplicates via
SHA-256(user_id + job_url), scores CV fit, and queues matches for the Jobby Chrome Extension.
"""

import hashlib
import os
import re
from typing import Any, Dict, List, Optional
import requests


def hash_job_url(user_id: str, job_url: str) -> str:
    normalized = job_url.strip().split("?")[0].lower()
    return hashlib.sha256(f"{user_id}:{normalized}".encode("utf-8")).hexdigest()


def compute_fit_score(cv_text: str, title: str, description: str, keywords: str) -> int:
    text = f"{title} {description}".lower()
    kw_list = [k.strip().lower() for k in re.split(r"[,;/]+", keywords or "") if k.strip()]
    kw_hits = sum(1 for k in kw_list if k in text)
    kw_score = (kw_hits / max(1, len(kw_list))) * 50

    cv_words = set(w for w in re.findall(r"[a-z0-9+#.]{3,}", (cv_text or "").lower()))
    job_words = set(w for w in re.findall(r"[a-z0-9+#.]{3,}", text))
    overlap = len(cv_words & job_words) / max(1, min(len(job_words), 40))
    return max(30, min(99, int(round(30 + kw_score + overlap * 35))))


def fetch_greenhouse_jobs(token: str, keywords: str) -> List[Dict[str, Any]]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true"
    resp = requests.get(url, timeout=15)
    if resp.status_code != 200:
        return []
    jobs = resp.json().get("jobs", [])
    kw_tokens = [k.strip().lower() for k in keywords.split(",") if k.strip()]
    results = []
    for j in jobs:
        title = j.get("title", "")
        content = j.get("content", "")
        hay = f"{title} {content}".lower()
        if not kw_tokens or any(k in hay for k in kw_tokens):
            results.append({
                "title": title,
                "company": token,
                "portal": "greenhouse",
                "location": (j.get("location") or {}).get("name", "India"),
                "job_url": j.get("absolute_url", ""),
                "description": re.sub(r"<[^>]+>", " ", content)[:3000],
            })
    return results


def fetch_lever_jobs(token: str, keywords: str) -> List[Dict[str, Any]]:
    url = f"https://api.lever.co/v0/postings/{token}?mode=json"
    resp = requests.get(url, timeout=15)
    if resp.status_code != 200:
        return []
    jobs = resp.json() if isinstance(resp.json(), list) else []
    kw_tokens = [k.strip().lower() for k in keywords.split(",") if k.strip()]
    results = []
    for j in jobs:
        title = j.get("text", "")
        desc = j.get("descriptionPlain", "")
        hay = f"{title} {desc}".lower()
        if not kw_tokens or any(k in hay for k in kw_tokens):
            results.append({
                "title": title,
                "company": token,
                "portal": "lever",
                "location": (j.get("categories") or {}).get("location", "India"),
                "job_url": j.get("hostedUrl", ""),
                "description": desc[:3000],
            })
    return results


def fetch_ashby_jobs(token: str, keywords: str) -> List[Dict[str, Any]]:
    url = f"https://api.ashbyhq.com/posting-api/job-board/{token}"
    resp = requests.get(url, timeout=15)
    if resp.status_code != 200:
        return []
    jobs = resp.json().get("jobs", [])
    kw_tokens = [k.strip().lower() for k in keywords.split(",") if k.strip()]
    results = []
    for j in jobs:
        title = j.get("title", "")
        desc = j.get("descriptionPlain", "")
        hay = f"{title} {desc}".lower()
        if not kw_tokens or any(k in hay for k in kw_tokens):
            results.append({
                "title": title,
                "company": token,
                "portal": "ashby",
                "location": j.get("location", "India"),
                "job_url": j.get("jobUrl", ""),
                "description": desc[:3000],
            })
    return results


def fetch_jobspy_india(keywords: str, location: str, portals: List[str]) -> List[Dict[str, Any]]:
    try:
        from jobspy import scrape_jobs
    except ImportError:
        return []

    supported = [p for p in portals if p in {"naukri", "linkedin", "indeed", "glassdoor"}]
    if not supported:
        return []

    try:
        df = scrape_jobs(
            site_name=supported,
            search_term=keywords,
            location=location or "India",
            results_wanted=15,
            hours_old=48,
            country_indeed="India",
        )
        rows = []
        for _, r in df.iterrows():
            job_url = str(r.get("job_url") or "")
            if not job_url:
                continue
            rows.append({
                "title": str(r.get("title") or ""),
                "company": str(r.get("company") or ""),
                "portal": str(r.get("site") or "jobspy"),
                "location": str(r.get("location") or location),
                "job_url": job_url,
                "description": str(r.get("description") or "")[:3000],
            })
        return rows
    except Exception as exc:
        print(f"JobSpy warning for '{keywords}': {exc}")
        return []


def run_loops() -> None:
    supabase_url = os.environ["SUPABASE_URL"]
    supabase_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    from supabase import create_client
    sb = create_client(supabase_url, supabase_key)

    # Fetch active loops joined with active user profiles
    loops = (
        sb.table("loops")
        .select("*, profiles!inner(id, is_active, cv_text, candidate_profile)")
        .eq("is_active", True)
        .eq("profiles.is_active", True)
        .execute()
        .data
    )

    for loop in loops:
        user_id = loop["user_id"]
        cv_text = loop["profiles"].get("cv_text", "")
        portals = loop.get("portals") or ["naukri", "linkedin", "indeed"]
        collected: List[Dict[str, Any]] = []

        collected.extend(fetch_jobspy_india(loop["keywords"], loop["location"], portals))

        for ats_entry in loop.get("ats_tokens") or []:
            if ":" not in ats_entry:
                continue
            provider, token = ats_entry.split(":", 1)
            if provider == "greenhouse":
                collected.extend(fetch_greenhouse_jobs(token, loop["keywords"]))
            elif provider == "lever":
                collected.extend(fetch_lever_jobs(token, loop["keywords"]))
            elif provider == "ashby":
                collected.extend(fetch_ashby_jobs(token, loop["keywords"]))

        for job in collected:
            if not job.get("job_url"):
                continue
            fit = compute_fit_score(cv_text, job["title"], job["description"], loop["keywords"])
            if fit < 45:
                continue
            row = {
                "loop_id": loop["id"],
                "user_id": user_id,
                "job_url": job["job_url"],
                "job_url_hash": hash_job_url(user_id, job["job_url"]),
                "title": job["title"][:200],
                "company": job["company"][:120],
                "portal": job["portal"],
                "location": job["location"][:120],
                "description": job["description"],
                "fit_score": fit,
            }
            sb.table("job_matches").upsert(row, on_conflict="user_id,job_url_hash").execute()


if __name__ == "__main__":
    run_loops()
