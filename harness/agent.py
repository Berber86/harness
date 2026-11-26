from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import litellm

from harness.prompts import build_system_prompt
from harness.tools import TOOLS_SCHEMA, OnAskUser, execute_tool


OnTextDelta = Callable[[str], Awaitable[None]]
OnToolStart = Callable[[str, str], Awaitable[Any]]
OnToolEnd = Callable[[Any, str], Awaitable[None]]


async def run_agent_turn(
    messages: list[dict[str, Any]],
    model: str,
    workdir: Path,
    on_text_delta: OnTextDelta,
    on_tool_start: OnToolStart,
    on_tool_end: OnToolEnd,
    on_ask_user: OnAskUser | None = None,
    api_base: str | None = None,
    api_key: str | None = None,
    max_steps: int = 20,
) -> list[dict[str, Any]]:
    """Run the tool-calling agent loop until a final response or max_steps."""
    system_prompt = build_system_prompt(workdir)

    for _ in range(max_steps):
        full_messages = [{"role": "system", "content": system_prompt}, *messages]

        completion_kwargs: dict[str, Any] = {
            "model": model,
            "messages": full_messages,
            "tools": TOOLS_SCHEMA,
            "stream": True,
        }
        if api_base:
            completion_kwargs["api_base"] = api_base
        if api_key:
            completion_kwargs["api_key"] = api_key

        response = await litellm.acompletion(**completion_kwargs)

        assistant_text = ""
        tool_calls_acc: dict[int, dict[str, Any]] = {}

        async for chunk in response:
            delta = chunk.choices[0].delta
            if delta.content:
                assistant_text += delta.content
                await on_text_delta(delta.content)

            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls_acc:
                        tool_calls_acc[idx] = {
                            "id": tc.id or f"call_{idx}",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        }
                    if tc.id:
                        tool_calls_acc[idx]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            tool_calls_acc[idx]["function"]["name"] += tc.function.name
                        if tc.function.arguments:
                            tool_calls_acc[idx]["function"]["arguments"] += tc.function.arguments

        tool_calls = [tool_calls_acc[i] for i in sorted(tool_calls_acc)]
        assistant_msg: dict[str, Any] = {
            "role": "assistant",
            "content": assistant_text or None,
        }
        if tool_calls:
            assistant_msg["tool_calls"] = tool_calls

        messages.append(assistant_msg)

        if not tool_calls:
            break

        for tc in tool_calls:
            fn_name = tc["function"]["name"]
            fn_args = tc["function"]["arguments"]
            step_ctx = await on_tool_start(fn_name, fn_args)
            result = await execute_tool(
                workdir, fn_name, fn_args, on_ask_user=on_ask_user
            )
            await on_tool_end(step_ctx, result)

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": fn_name,
                    "content": result,
                }
            )

    return messages
