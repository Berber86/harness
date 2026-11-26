import subprocess
from pathlib import Path


def _get_git_branch(workdir: Path) -> str | None:
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(workdir),
            capture_output=True,
            text=True,
            timeout=2,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return None


def build_system_prompt(workdir: Path) -> str:
    branch = _get_git_branch(workdir)
    git_line = f"\nCurrent Git branch: `{branch}`" if branch else ""

    return f"""You are a skilled coding agent running inside a local development harness.
Working directory: `{workdir}`{git_line}

You have access to tools for reading, writing, and editing files, as well as running bash commands.

Guidelines:
- Always read a file before editing it with `edit_file`.
- Prefer `edit_file` over `write_file` for modifying existing files so you don't accidentally drop code.
- Use `bash` to inspect the repository, run tests, linters, or git commands.
- Keep your explanations concise and grounded in what you actually observed in files and command outputs.
- If a command or edit fails, inspect the error and adjust your approach.
"""
