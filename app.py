import os
from pathlib import Path

import chainlit as cl
from chainlit.input_widget import TextInput
from dotenv import load_dotenv

from harness.agent import run_agent_turn

load_dotenv()

DEFAULT_MODEL = os.getenv("HARNESS_MODEL", "openai/claude-3-7-sonnet-latest")
DEFAULT_API_BASE = os.getenv("HARNESS_API_BASE", "https://api.hydraai.ru/v1")
DEFAULT_API_KEY = os.getenv("HARNESS_API_KEY", "")
DEFAULT_WORKDIR = os.getenv("HARNESS_WORKDIR", ".")


@cl.on_chat_start
async def on_chat_start():
    workdir = Path(DEFAULT_WORKDIR).expanduser().resolve()
    cl.user_session.set("messages", [])
    cl.user_session.set("model", DEFAULT_MODEL)
    cl.user_session.set("api_base", DEFAULT_API_BASE)
    cl.user_session.set("api_key", DEFAULT_API_KEY)
    cl.user_session.set("workdir", str(workdir))

    await cl.ChatSettings(
        [
            TextInput(
                id="model",
                label="Модель (для HydraAI пиши openai/название_модели)",
                initial=DEFAULT_MODEL,
                description="Например: openai/claude-3-7-sonnet-latest или openai/gpt-4o",
            ),
            TextInput(
                id="api_base",
                label="API Base URL (провайдер)",
                initial=DEFAULT_API_BASE,
                description="Для HydraAI: https://api.hydraai.ru/v1",
            ),
            TextInput(
                id="api_key",
                label="API Ключ",
                initial=DEFAULT_API_KEY,
                description="Вставь сюда свой ключ от HydraAI",
            ),
            TextInput(
                id="workdir",
                label="Рабочая папка",
                initial=str(workdir),
                description="Папка на компьютере, где агент будет работать с файлами",
            ),
        ]
    ).send()

    key_status = "указан" if DEFAULT_API_KEY else "НЕ указан (нажми на шестерёнку внизу и вставь ключ)"
    await cl.Message(
        content=(
            f"Привет! Твой локальный кодинг-агент готов к работе.\n"
            f"- **Модель:** `{DEFAULT_MODEL}`\n"
            f"- **Провайдер:** `{DEFAULT_API_BASE}`\n"
            f"- **API Ключ:** {key_status}\n"
            f"- **Рабочая папка:** `{workdir}`\n\n"
            f"Нажми на иконку **шестерёнки** (рядом с полем ввода), чтобы вставить ключ от HydraAI, выбрать модель или папку."
        )
    ).send()


@cl.on_settings_update
async def on_settings_update(settings: dict):
    model = settings.get("model", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    api_base = settings.get("api_base", DEFAULT_API_BASE).strip() or None
    api_key = settings.get("api_key", DEFAULT_API_KEY).strip() or None
    workdir_raw = settings.get("workdir", DEFAULT_WORKDIR).strip() or DEFAULT_WORKDIR
    workdir = Path(workdir_raw).expanduser().resolve()

    cl.user_session.set("model", model)
    cl.user_session.set("api_base", api_base)
    cl.user_session.set("api_key", api_key)
    cl.user_session.set("workdir", str(workdir))

    await cl.Message(
        content=(
            f"Настройки обновлены:\n"
            f"- **Модель:** `{model}`\n"
            f"- **Провайдер:** `{api_base or 'по умолчанию'}`\n"
            f"- **Рабочая папка:** `{workdir}`"
        )
    ).send()


@cl.on_message
async def on_message(message: cl.Message):
    messages = cl.user_session.get("messages", [])
    model = cl.user_session.get("model", DEFAULT_MODEL)
    api_base = cl.user_session.get("api_base", DEFAULT_API_BASE)
    api_key = cl.user_session.get("api_key", DEFAULT_API_KEY)
    workdir = Path(cl.user_session.get("workdir", DEFAULT_WORKDIR)).resolve()

    messages.append({"role": "user", "content": message.content})

    ui_msg = cl.Message(content="")

    async def on_text_delta(token: str):
        await ui_msg.stream_token(token)

    async def on_tool_start(name: str, args: str):
        step = cl.Step(name=name, type="tool")
        step.input = args
        await step.send()
        return step

    async def on_tool_end(step: cl.Step, result: str):
        step.output = result
        await step.update()

    async def on_ask_user(question: str, options: list[str] | None) -> str:
        if options:
            actions = [
                cl.Action(name=f"opt_{i}", payload={"value": opt}, label=opt)
                for i, opt in enumerate(options)
            ]
            res = await cl.AskActionMessage(content=question, actions=actions).send()
            if res and res.get("payload"):
                return str(res["payload"].get("value", ""))
            return "Пользователь не выбрал вариант."
        res = await cl.AskUserMessage(content=question, timeout=300).send()
        if res and res.get("output"):
            return str(res["output"])
        return "Пользователь не ответил."

    try:
        updated = await run_agent_turn(
            messages=messages,
            model=model,
            workdir=workdir,
            on_text_delta=on_text_delta,
            on_tool_start=on_tool_start,
            on_tool_end=on_tool_end,
            on_ask_user=on_ask_user,
            api_base=api_base,
            api_key=api_key,
        )
        cl.user_session.set("messages", updated)
        if ui_msg.content:
            await ui_msg.send()
    except Exception as exc:
        await cl.Message(content=f"Ошибка: `{exc}`").send()
