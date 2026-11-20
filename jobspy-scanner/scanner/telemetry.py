"""OpenTelemetry for the scanner: its run and stages as spans.

Exports to APPLICATIONINSIGHTS_CONNECTION_STRING, which Terraform sets, through
the Azure Monitor distro. Without it (tests, local runs) nothing is configured
and spans go nowhere.

The distro instruments HTTP clients by default. Those are off here: jobspy
scrapes through `requests`, and every search URL carries the target titles and
locations.
Only this scanner's own logger is exported, never a library's: jobspy logs
the URLs it fetched. Span names follow the Node side, so the evaluation's
latency query finds the run: functions/src/lib/telemetry/spans.ts lists the
same names, and a test on each side pins them.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager

from opentelemetry import trace

LOGGER = "jobspy-scanner"
TRACER = "jobspy-scanner"

# The run's span, the root of its trace (RUN_SPANS.jobspy on the Node side).
RUN_SPAN = "jobspy run"

# What the run span says it is, in OTel's GenAI agent terms, so Foundry's Traces
# view lists the run (#207): the same agent as the Node app's runs
# (AGENT_ATTRIBUTES in functions/src/lib/telemetry/spans.ts).
AGENT_ATTRIBUTES = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.id": "job-scan",
    "gen_ai.agent.name": "job-scan",
}

# A stage's span is "node <stage>", as a Node graph node's is.
NODE_SPAN_PREFIX = "node "


def node_span(stage: str) -> str:
    return f"{NODE_SPAN_PREFIX}{stage}"


# The distro's instrumentations that would record request URLs.
HTTP_CLIENTS = ("requests", "urllib", "urllib3", "httpx", "httpx2")


def configure(
    env: dict[str, str],
    configure_azure_monitor: Callable[..., None] | None = None,
) -> bool:
    """Export to Application Insights when the app has its connection string; True if it does."""
    if not env.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
        return False
    if configure_azure_monitor is None:
        from azure.monitor.opentelemetry import configure_azure_monitor
    configure_azure_monitor(
        logger_name=LOGGER,
        instrumentation_options={name: {"enabled": False} for name in HTTP_CLIENTS},
    )
    return True


@contextmanager
def span(name: str, attributes: dict[str, str] | None = None) -> Iterator[trace.Span]:
    """A span current for the block; an exception marks it failed and goes on.

    Only the exception's type is recorded: its message can hold config values
    or posting text (a validation error quotes its input)."""
    tracer = trace.get_tracer(TRACER)
    with tracer.start_as_current_span(
        name, attributes=attributes, record_exception=False, set_status_on_exception=False
    ) as current:
        try:
            yield current
        except BaseException as err:
            kind = type(err).__name__
            current.add_event("exception", {"exception.type": kind})
            current.set_status(trace.Status(trace.StatusCode.ERROR, kind))
            raise


def trace_of(current: trace.Span) -> dict[str, str] | None:
    """Where the trace stands, for the handoff, so `collect` can link to it; None when not traced."""
    context = current.get_span_context()
    if not context.is_valid:
        return None
    return {
        "trace_id": trace.format_trace_id(context.trace_id),
        "span_id": trace.format_span_id(context.span_id),
    }
