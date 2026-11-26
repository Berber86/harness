import asyncio
import fnmatch
import html
import json
import re
import sys
import urllib.request
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any


MAX_OUTPUT_CHARS = 20_000
IGNORE_DIRS = {".git", ".venv", "venv", "__pycache__", "node_modules", ".chainlit"}

OnAskUser = Callable[[str, list[str] | None], Awaitable[str]]


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return (
        text[:half]
        + f"\n\n... [truncated {len(text) - limit} chars] ...\n\n"
        + text[-half:]
    )


def _resolve_path(workdir: Path, raw_path: str) -> Path:
    p = Path(raw_path).expanduser()
    if not p.is_absolute():
        p = workdir / p
    return p.resolve()


def read_file(workdir: Path, path: str, offset: int = 1, limit: int = 2000) -> str:
    target = _resolve_path(workdir, path)
    if not target.exists():
        return f"Error: File not found: {target}"
    if target.is_dir():
        return f"Error: Path is a directory, not a file: {target}"

    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return f"Error reading file {target}: {exc}"

    lines = text.splitlines()
    start = max(0, offset - 1)
    end = start + max(1, limit)
    sliced = lines[start:end]
    numbered = [f"{i + start + 1}: {line}" for i, line in enumerate(sliced)]
    result = "\n".join(numbered)
    if end < len(lines):
        result += f"\n\n... ({len(lines) - end} more lines)"
    return _truncate(result)


def write_file(workdir: Path, path: str, content: str) -> str:
    target = _resolve_path(workdir, path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"Successfully wrote {len(content)} chars to {target}"
    except Exception as exc:
        return f"Error writing file {target}: {exc}"


def edit_file(workdir: Path, path: str, old_text: str, new_text: str) -> str:
    target = _resolve_path(workdir, path)
    if not target.exists():
        return f"Error: File not found: {target}"

    try:
        content = target.read_text(encoding="utf-8")
    except Exception as exc:
        return f"Error reading file {target}: {exc}"

    count = content.count(old_text)
    if count == 0:
        return "Error: old_text not found in file. Make sure it matches exactly."
    if count > 1:
        return (
            f"Error: old_text matched {count} times. "
            "Provide more surrounding context so it matches exactly once."
        )

    updated = content.replace(old_text, new_text, 1)
    try:
        target.write_text(updated, encoding="utf-8")
        return f"Successfully edited {target}"
    except Exception as exc:
        return f"Error writing file {target}: {exc}"


async def bash(workdir: Path, command: str, timeout: int = 30) -> str:
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return f"Error: Command timed out after {timeout}s"

        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        parts = [f"exit_code: {proc.returncode}"]
        if stdout:
            parts.append(f"stdout:\n{_truncate(stdout)}")
        if stderr:
            parts.append(f"stderr:\n{_truncate(stderr)}")
        return "\n".join(parts)
    except Exception as exc:
        return f"Error executing command: {exc}"


async def _run_python_proc(workdir: Path, args: list[str], timeout: int = 30) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            *args,
            cwd=str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return f"Error: Python process timed out after {timeout}s"

        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        parts = [f"exit_code: {proc.returncode}"]
        if stdout:
            parts.append(f"stdout:\n{_truncate(stdout)}")
        if stderr:
            parts.append(f"stderr:\n{_truncate(stderr)}")
        return "\n".join(parts)
    except Exception as exc:
        return f"Error running Python: {exc}"


async def run_python(workdir: Path, code: str, timeout: int = 30) -> str:
    return await _run_python_proc(workdir, ["-c", code], timeout=timeout)


async def install_package(workdir: Path, package: str) -> str:
    return await _run_python_proc(
        workdir, ["-m", "pip", "install", package], timeout=120
    )


async def check_python(workdir: Path, path: str) -> str:
    target = _resolve_path(workdir, path)
    if not target.exists():
        return f"Error: File not found: {target}"
    return await _run_python_proc(workdir, ["-m", "py_compile", str(target)], timeout=15)


def list_dir(workdir: Path, path: str = ".") -> str:
    target = _resolve_path(workdir, path)
    if not target.exists():
        return f"Error: Directory not found: {target}"
    if not target.is_dir():
        return f"Error: Not a directory: {target}"

    entries = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    lines = []
    for entry in entries:
        if entry.name in IGNORE_DIRS:
            continue
        if entry.is_dir():
            lines.append(f"[DIR]  {entry.name}/")
        else:
            lines.append(f"[FILE] {entry.name} ({entry.stat().st_size} bytes)")
    return "\n".join(lines) if lines else "(empty directory)"


def find_files(workdir: Path, pattern: str, path: str = ".") -> str:
    root = _resolve_path(workdir, path)
    if not root.exists():
        return f"Error: Path not found: {root}"

    matches: list[str] = []
    for p in root.rglob("*"):
        if any(part in IGNORE_DIRS for part in p.parts):
            continue
        if p.is_file() and fnmatch.fnmatch(p.name, pattern):
            try:
                rel = p.relative_to(root)
            except ValueError:
                rel = p
            matches.append(str(rel))
            if len(matches) >= 200:
                break

    if not matches:
        return f"No files matching '{pattern}' found."
    result = "\n".join(sorted(matches))
    if len(matches) >= 200:
        result += "\n... (results capped at 200 files)"
    return result


def search_text(workdir: Path, query: str, path: str = ".") -> str:
    root = _resolve_path(workdir, path)
    if not root.exists():
        return f"Error: Path not found: {root}"

    results: list[str] = []
    files = [root] if root.is_file() else root.rglob("*")
    for p in files:
        if not p.is_file():
            continue
        if any(part in IGNORE_DIRS for part in p.parts):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for idx, line in enumerate(text.splitlines(), start=1):
            if query in line:
                try:
                    rel = p.relative_to(workdir)
                except ValueError:
                    rel = p
                results.append(f"{rel}:{idx}: {line.strip()}")
                if len(results) >= 100:
                    return "\n".join(results) + "\n... (capped at 100 matches)"

    return "\n".join(results) if results else f"No matches for '{query}'."


def _fetch_url_sync(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (CodingHarness/0.1)"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    # Strip script/style blocks and HTML tags for readable text
    cleaned = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return _truncate(cleaned)


async def fetch_url(url: str) -> str:
    try:
        return await asyncio.to_thread(_fetch_url_sync, url)
    except Exception as exc:
        return f"Error fetching {url}: {exc}"


async def execute_tool(
    workdir: Path,
    name: str,
    raw_args: str,
    on_ask_user: OnAskUser | None = None,
) -> str:
    try:
        args: dict[str, Any] = json.loads(raw_args) if raw_args else {}
    except json.JSONDecodeError as exc:
        return f"Error: Invalid JSON arguments: {exc}"

    if name == "read_file":
        return read_file(
            workdir,
            path=args["path"],
            offset=args.get("offset", 1),
            limit=args.get("limit", 2000),
        )
    if name == "write_file":
        return write_file(workdir, path=args["path"], content=args["content"])
    if name == "edit_file":
        return edit_file(
            workdir,
            path=args["path"],
            old_text=args["old_text"],
            new_text=args["new_text"],
        )
    if name == "bash":
        return await bash(workdir, command=args["command"], timeout=args.get("timeout", 30))
    if name == "run_python":
        return await run_python(workdir, code=args["code"], timeout=args.get("timeout", 30))
    if name == "install_package":
        return await install_package(workdir, package=args["package"])
    if name == "check_python":
        return await check_python(workdir, path=args["path"])
    if name == "list_dir":
        return list_dir(workdir, path=args.get("path", "."))
    if name == "find_files":
        return find_files(workdir, pattern=args["pattern"], path=args.get("path", "."))
    if name == "search_text":
        return search_text(workdir, query=args["query"], path=args.get("path", "."))
    if name == "fetch_url":
        return await fetch_url(url=args["url"])
    if name == "ask_user":
        if on_ask_user is None:
            return "Error: ask_user is not available in this interface."
        return await on_ask_user(args["question"], args.get("options"))

    return f"Error: Unknown tool '{name}'"


TOOLS_SCHEMA: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file with line numbers. Use offset and limit for large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path (relative to workdir or absolute)"},
                    "offset": {"type": "integer", "description": "1-based starting line number", "default": 1},
                    "limit": {"type": "integer", "description": "Max lines to return", "default": 2000},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create a new file or overwrite an existing file with full content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path"},
                    "content": {"type": "string", "description": "Full file content"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Replace an exact, unique occurrence of old_text with new_text in an existing file. Read the file first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path"},
                    "old_text": {"type": "string", "description": "Exact text to replace (must match once)"},
                    "new_text": {"type": "string", "description": "Replacement text"},
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a shell command in the working directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds", "default": 30},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_python",
            "description": "Execute a snippet of Python code using the project's Python interpreter.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds", "default": 30},
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "install_package",
            "description": "Install a Python package via pip into the active environment.",
            "parameters": {
                "type": "object",
                "properties": {
                    "package": {"type": "string", "description": "Package name (e.g. 'requests' or 'pandas==2.2.0')"},
                },
                "required": ["package"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_python",
            "description": "Check a Python file for syntax errors using py_compile.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the .py file"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List files and subdirectories in a directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path (defaults to '.')", "default": "."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_files",
            "description": "Find files matching a glob pattern (e.g. '*.py').",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Filename glob pattern, e.g. '*.py'"},
                    "path": {"type": "string", "description": "Root directory to search", "default": "."},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_text",
            "description": "Search for a text string across files in the project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text to search for"},
                    "path": {"type": "string", "description": "Directory or file to search in", "default": "."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_url",
            "description": "Fetch a web page and return its readable text content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "HTTP/HTTPS URL to fetch"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_user",
            "description": "Ask the user a clarifying question, optionally with predefined choices.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "Question to ask the user"},
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of short answer choices",
                    },
                },
                "required": ["question"],
            },
        },
    },
]
