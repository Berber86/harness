import asyncio
import json
from pathlib import Path
from typing import Any


MAX_OUTPUT_CHARS = 20_000


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


async def execute_tool(workdir: Path, name: str, raw_args: str) -> str:
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
        return bash_result if isinstance(
            (bash_result := await bash(workdir, command=args["command"], timeout=args.get("timeout", 30))),
            str,
        ) else str(bash_result)

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
]
