"""Tool registry: every tool Jarvis can call, plus a safe executor."""

import asyncio
import inspect
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable

log = logging.getLogger("jarvis.tools")


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict
    handler: Callable[..., Any]  # sync or async; returns str or JSON-able object

    def definition(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
            # Stream tool arguments as they are generated; we validate them ourselves below.
            "eager_input_streaming": True,
        }


REGISTRY: dict[str, Tool] = {}


def tool(name: str, description: str, properties: dict, required: list[str] | None = None):
    """Decorator that registers a function as a Claude tool."""

    def wrap(fn):
        REGISTRY[name] = Tool(
            name=name,
            description=description,
            input_schema={
                "type": "object",
                "properties": properties,
                "required": required or [],
                "additionalProperties": False,
            },
            handler=fn,
        )
        return fn

    return wrap


class ToolInputError(ValueError):
    pass


def _validate(t: Tool, args: Any) -> dict:
    if not isinstance(args, dict):
        raise ToolInputError("Tool input must be a JSON object.")
    props = t.input_schema["properties"]
    missing = [k for k in t.input_schema["required"] if args.get(k) in (None, "")]
    if missing:
        raise ToolInputError(f"Missing required field(s): {', '.join(missing)}")
    unknown = [k for k in args if k not in props]
    if unknown:
        raise ToolInputError(f"Unknown field(s): {', '.join(unknown)}")
    py_types = {"string": str, "integer": int, "boolean": bool, "number": (int, float)}
    for k, v in args.items():
        expected = py_types.get(props[k].get("type"))
        if expected and v is not None and not isinstance(v, expected):
            raise ToolInputError(f"Field '{k}' should be {props[k]['type']}.")
        if "enum" in props[k] and v not in props[k]["enum"]:
            raise ToolInputError(f"Field '{k}' must be one of {props[k]['enum']}.")
    return args


async def execute(name: str, args: Any) -> tuple[str, bool]:
    """Run a tool. Returns (result_text, is_error). Never raises."""
    t = REGISTRY.get(name)
    if t is None:
        return f"Unknown tool: {name}", True
    try:
        clean = _validate(t, args)
        if inspect.iscoroutinefunction(t.handler):
            result = await t.handler(**clean)
        else:
            result = await asyncio.to_thread(t.handler, **clean)
        if not isinstance(result, str):
            result = json.dumps(result, ensure_ascii=False, default=str)
        return result, False
    except ToolInputError as e:
        return f"INVALID_INPUT: {e}", True
    except Exception as e:  # report to the model so it can recover or explain
        log.exception("Tool %s failed", name)
        return f"Tool error: {type(e).__name__}: {e}", True


def definitions() -> list[dict]:
    # Sorted so the tools block is byte-identical every request (keeps the prompt cache warm).
    return [REGISTRY[n].definition() for n in sorted(REGISTRY)]


# Import tool modules so their @tool decorators register.
from . import tasks, memory, google_tools  # noqa: E402,F401
