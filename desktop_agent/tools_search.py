"""
Search commands: open a search results page for a query on a given engine.

These launch in the user's default browser.

searchYouTube / searchGoogle / searchGitHub were removed (2026-08-19) —
they were thin wrappers that searchWeb(engine=...) already covers, so they
were pure schema bulk with no distinct capability.
"""

from __future__ import annotations

from typing import Any, Dict

from .registry import ToolError, register
from .tools_websites import _build_search_url, open_url


@register("searchWeb")
def search_web(args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q")
    engine = (args.get("engine") or "google").strip().lower()
    if not query:
        raise ToolError("Parameter 'query' is required.")
    url = _build_search_url(engine, str(query))
    resolved = open_url(url)
    return {"result": f"Searching {engine} for '{query}': opened {resolved}."}


__all__ = ["search_web"]
